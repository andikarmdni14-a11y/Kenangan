-- Couple Memory Vault v6. Jalankan SELURUH file sebagai postgres di SQL Editor.
-- Memerlukan setup.sql dan upgrade-v4.sql yang sudah dipakai aplikasi v5.1.
-- Idempotent, satu transaksi. Tidak menghapus kenangan, file, akun, atau reaksi lama.
begin;
do $$ begin
  if to_regprocedure('public.cmv_require_member()') is null
     or to_regclass('private.members') is null
     or to_regclass('public.cmv_locations') is null then
    raise exception 'Setup aplikasi dan upgrade-v4.sql perlu tersedia dahulu. Tidak ada perubahan disimpan.';
  end if;
end $$;

alter table public.memories add column if not exists type text;
alter table public.memories add column if not exists tags text[] not null default '{}';
alter table public.memories add column if not exists is_favorite boolean not null default false;
-- Jangan menebak isi audio dari nama file. Audio lama tetap di pemutar sampai dipilih.
update public.memories m set type = case
  when media_kind <> 'audio' then media_kind
  when exists(select 1 from public.app_settings s where s.music_memory_id=m.id) then 'music'
  else 'legacy_audio' end where type is null;
alter table public.memories alter column type set not null;
create or replace function private.cmv_memory_metadata() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.type is null then new.type := case when new.media_kind='audio' then 'voice_note' else new.media_kind end; end if;
  if (new.media_kind='audio' and new.type not in ('voice_note','music','legacy_audio'))
     or (new.media_kind<>'audio' and new.type<>new.media_kind) then
    raise exception 'Jenis media dan jenis cerita tidak cocok.';
  end if;
  if new.tags is null then new.tags := '{}'; end if;
  if cardinality(new.tags)>8 or array_ndims(new.tags)>1 then raise exception 'Maksimal delapan label.'; end if;
  if exists(select 1 from unnest(new.tags) t where t is null or char_length(t)>32) then
    raise exception 'Setiap label maksimal 32 karakter.';
  end if;
  select coalesce(array_agg(t order by t),'{}'::text[]) into new.tags from
    (select distinct lower(btrim(regexp_replace(x,'^#+',''))) t from unnest(new.tags) x) q
    where t<>'';
  if exists(select 1 from unnest(new.tags) t where t !~ '^[[:alnum:]_-]+$') then
    raise exception 'Label hanya memakai huruf, angka, garis bawah, atau tanda hubung.';
  end if;
  return new;
end $$;
drop trigger if exists cmv_memory_metadata on public.memories;
create trigger cmv_memory_metadata before insert or update on public.memories
for each row execute function private.cmv_memory_metadata();
create index if not exists cmv_memories_tags on public.memories using gin(tags);
create index if not exists cmv_archive_sort on public.memories(occurred_on desc,created_at desc,id desc)
  where type in ('image','video','voice_note');

create or replace function public.cmv_list_archive(
  p_offset integer default 0,p_limit integer default 24,p_tag text default null,
  p_with_location boolean default false,p_kind text default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid; v_role text; v_result jsonb;
begin
  v_uid:=public.cmv_require_member(); v_role:=private.app_role();
  if p_kind is not null and p_kind not in ('image','video','voice_note') then raise exception 'Filter tidak dikenal.'; end if;
  select coalesce(jsonb_agg(q.item order by q.occurred_on desc,q.created_at desc,q.id desc),'[]'::jsonb)
    into v_result from (
    select m.id,m.occurred_on,m.created_at,
      case when x.locked then jsonb_build_object('id',m.id,'is_locked',true,'unlock_at',m.unlock_at)
        else to_jsonb(m)||jsonb_build_object('is_locked',false) end item
    from public.memories m
    cross join lateral (select v_role<>'admin' and m.created_by<>v_uid and m.unlock_at>now() as locked) x
    where m.type in ('image','video','voice_note')
      and (p_kind is null or (not coalesce(x.locked,false) and m.type=p_kind))
      and (nullif(p_tag,'') is null or (not coalesce(x.locked,false) and m.tags @> array[p_tag]))
      and (not coalesce(p_with_location,false) or (not coalesce(x.locked,false) and exists(
        select 1 from public.cmv_locations l where l.memory_id=m.id)))
    order by m.occurred_on desc,m.created_at desc,m.id desc
    limit greatest(1,least(coalesce(p_limit,24),24)) offset greatest(0,coalesce(p_offset,0))
  ) q;
  return v_result;
end $$;

create or replace function public.cmv_archive_tags() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform public.cmv_require_member();
  return coalesce((select jsonb_agg(t order by t) from (
    select distinct unnest(m.tags) t from public.memories m
    where m.type in ('image','video','voice_note') and (m.unlock_at is null or m.unlock_at<=now())
    order by t limit 60) q),'[]'::jsonb);
end $$;

create or replace function public.cmv_set_memory_options(p_id uuid,p_favorite boolean default null,p_type text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_uid uuid; v_m public.memories%rowtype;
begin
  v_uid:=public.cmv_require_member();
  select * into v_m from public.memories where id=p_id for update;
  if not found or (v_m.unlock_at>now() and v_m.created_by<>v_uid and private.app_role()<>'admin') then
    raise exception 'Kenangan belum tersedia.' using errcode='42501';
  end if;
  if p_type is not null and (v_m.media_kind<>'audio' or p_type not in ('voice_note','music')) then
    raise exception 'Pilih Pesan Suara atau Lagu.';
  end if;
  update public.memories set is_favorite=coalesce(p_favorite,is_favorite),type=coalesce(p_type,type) where id=p_id;
  if p_type='voice_note' then update public.app_settings set music_memory_id=null where music_memory_id=p_id; end if;
  return jsonb_build_object('id',p_id,'is_favorite',coalesce(p_favorite,v_m.is_favorite),'type',coalesce(p_type,v_m.type));
end $$;

-- Peta tetap memakai Leaflet dan mesin lokasi lama; lagu tidak masuk ke arsip/peta.
create or replace function public.cmv_shared_state() returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform public.cmv_require_member();
  return jsonb_build_object('server_time',now(),
    'events',coalesce((select jsonb_agg(to_jsonb(e) order by e.event_date,e.event_time nulls first) from public.cmv_calendar e where not e.deleted),'[]'::jsonb),
    'locations',coalesce((select jsonb_agg(jsonb_build_object('memory_id',l.memory_id,'label',l.label,'lat',l.lat,'lng',l.lng,'memory',to_jsonb(m)||jsonb_build_object('is_locked',false))) from public.cmv_locations l join public.memories m on m.id=l.memory_id where m.type in ('image','video','voice_note') and (m.unlock_at is null or m.unlock_at<=now())),'[]'::jsonb),
    'reactions',coalesce((select jsonb_agg(to_jsonb(r)) from public.cmv_reactions r where r.target_kind<>'memory' and public.cmv_target_open(r.target_kind,r.target_id)),'[]'::jsonb));
end $$;
create or replace function public.random_memory() returns setof public.memories
language sql volatile security invoker set search_path='' as $$
  select m.* from public.memories m where m.type in ('image','video','voice_note')
    and (m.unlock_at is null or m.unlock_at<=now()) order by random() limit 1;
$$;

-- Isi Blind Q&A tidak pernah diekspos sebagai tabel API, termasuk untuk Admin aplikasi.
create table if not exists private.cmv_weekly_rounds(
  week_start date primary key,
  question text not null,
  member_a uuid not null references auth.users(id),
  member_b uuid not null references auth.users(id),
  check(member_a<>member_b)
);
create table if not exists private.cmv_weekly_answers(
  week_start date not null references private.cmv_weekly_rounds(week_start),
  author_id uuid not null references auth.users(id),
  answer text not null check(char_length(btrim(answer)) between 1 and 3000),
  created_at timestamptz not null default now(),
  primary key(week_start,author_id)
);
alter table private.cmv_weekly_rounds enable row level security;
alter table private.cmv_weekly_answers enable row level security;
revoke all on private.cmv_weekly_rounds,private.cmv_weekly_answers from public,anon,authenticated;

create or replace function public.cmv_weekly_state() returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_uid uuid; v_week date; v_members uuid[]; v_r private.cmv_weekly_rounds%rowtype;
  v_own text; v_partner text; v_a boolean; v_b boolean;
  v_questions text[]:=array[
    'Hal kecil apa dariku yang paling membuatmu merasa dicintai?',
    'Kenangan mana yang ingin kamu ulang bersamaku?',
    'Apa satu hal yang ingin kita pelajari bersama?',
    'Kapan kamu merasa paling dekat denganku minggu ini?',
    'Tempat seperti apa yang ingin kita kunjungi berdua?',
    'Dukungan seperti apa yang kamu butuhkan dariku sekarang?',
    'Apa yang ingin kamu rayakan dari perjalanan kita?',
    'Kebiasaan kecil apa yang ingin kita bangun bersama?'];
begin
  v_uid:=public.cmv_require_member();
  select array_agg(user_id order by user_id) into v_members from private.members where role in ('admin','viewer');
  if coalesce(cardinality(v_members),0)<>2 then raise exception 'Pertanyaan berdua membutuhkan tepat dua akun anggota.'; end if;
  select date_trunc('week',now() at time zone timezone)::date into v_week from public.app_settings where id=1;
  insert into private.cmv_weekly_rounds(week_start,question,member_a,member_b)
    values(v_week,v_questions[1+mod((v_week-date '2020-01-06')/7,8)],v_members[1],v_members[2])
    on conflict(week_start) do nothing;
  select * into v_r from private.cmv_weekly_rounds where week_start=v_week;
  if not (v_uid in (v_r.member_a,v_r.member_b)) or not (v_r.member_a=any(v_members) and v_r.member_b=any(v_members)) then
    raise exception 'Anggota berubah. Pertanyaan berdua tersedia kembali minggu depan.' using errcode='42501';
  end if;
  select exists(select 1 from private.cmv_weekly_answers where week_start=v_week and author_id=v_r.member_a),
    exists(select 1 from private.cmv_weekly_answers where week_start=v_week and author_id=v_r.member_b) into v_a,v_b;
  select answer into v_own from private.cmv_weekly_answers where week_start=v_week and author_id=v_uid;
  if v_a and v_b then
    select answer into v_partner from private.cmv_weekly_answers where week_start=v_week and author_id<>v_uid;
  end if;
  return jsonb_build_object('week_start',v_week,'question',v_r.question,'user_a_answered',v_a,'user_b_answered',v_b,
    'own_answer',v_own,'own_answered',v_own is not null,'partner_answered',case when v_uid=v_r.member_a then v_b else v_a end,
    'revealed',v_a and v_b,'partner_answer',v_partner);
end $$;
create or replace function public.cmv_submit_weekly(p_week date,p_answer text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_uid uuid; v_state jsonb; v_existing text;
begin
  v_uid:=public.cmv_require_member();
  if p_answer is null or char_length(btrim(p_answer)) not between 1 and 3000 then raise exception 'Jawaban perlu diisi, maksimal 3.000 karakter.'; end if;
  -- Semua jawaban untuk minggu yang sama berurutan, termasuk submit serentak/lintas tab.
  perform pg_advisory_xact_lock(hashtextextended('cmv-week:'||p_week::text,0));
  v_state:=public.cmv_weekly_state();
  if p_week is null or p_week<>(v_state->>'week_start')::date then raise exception 'Minggu sudah berganti. Muat pertanyaan terbaru dahulu.'; end if;
  select answer into v_existing from private.cmv_weekly_answers where week_start=p_week and author_id=v_uid;
  if found and v_existing<>btrim(p_answer) then raise exception 'Jawaban sudah dikirim dan tidak dapat diganti.'; end if;
  insert into private.cmv_weekly_answers(week_start,author_id,answer) values(p_week,v_uid,btrim(p_answer))
    on conflict(week_start,author_id) do nothing;
  return public.cmv_weekly_state();
end $$;

create or replace function public.cmv_year_review() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_s public.app_settings%rowtype; v_today date; v_from date; v_stats jsonb; v_slides jsonb;
begin
  perform public.cmv_require_member();
  select * into v_s from public.app_settings where id=1;
  v_today:=(now() at time zone v_s.timezone)::date;
  v_from:=(v_today-interval '1 year')::date;
  select jsonb_build_object('total',count(*),'photos',count(*) filter(where type='image'),
    'voice_notes',count(*) filter(where type='voice_note'),'favorites',count(*) filter(where is_favorite)) into v_stats
    from public.memories where type in ('image','video','voice_note') and occurred_on>v_from and occurred_on<=v_today
      and (unlock_at is null or unlock_at<=now());
  select coalesce(jsonb_agg(to_jsonb(q) order by q.is_favorite desc,q.occurred_on,q.id),'[]'::jsonb) into v_slides from (
    (select * from public.memories where type='image' and occurred_on>v_from and occurred_on<=v_today and (unlock_at is null or unlock_at<=now()) order by is_favorite desc,occurred_on desc,id limit 12)
    union all
    (select * from public.memories where type='voice_note' and occurred_on>v_from and occurred_on<=v_today and (unlock_at is null or unlock_at<=now()) order by is_favorite desc,occurred_on desc,id limit 2)
  ) q;
  return jsonb_build_object('from_date',v_from+1,'to_date',v_today,'couple_names',v_s.couple_names,
    'days_together',case when v_s.relationship_started_at is null then null else greatest(0,v_today-(v_s.relationship_started_at at time zone v_s.timezone)::date) end,
    'anniversary',v_s.relationship_started_at is not null and v_today>(v_s.relationship_started_at at time zone v_s.timezone)::date and to_char(v_today,'MM-DD')=to_char(v_s.relationship_started_at at time zone v_s.timezone,'MM-DD'),
    'stats',v_stats,'slides',v_slides);
end $$;

create or replace function public.cmv_book_items(p_from date,p_to date,p_offset integer default 0,p_limit integer default 61) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
  perform public.cmv_require_member();
  if p_from is null or p_to is null or p_to<p_from then raise exception 'Rentang tanggal belum sesuai.'; end if;
  select coalesce(jsonb_agg(to_jsonb(q) order by q.occurred_on,q.id),'[]'::jsonb) into v_result from (
    select * from (
      select m.id,m.type as kind,m.title,m.caption as body,m.occurred_on,m.media_path,m.preview_path from public.memories m
        where m.type in ('image','video','voice_note') and (m.unlock_at is null or m.unlock_at<=now())
      union all
      select e.id,'journal',e.title,e.body,e.occurred_on,null,null from public.cmv_entries e
        where e.kind='journal' and (e.unlock_at is null or e.unlock_at<=now())
      union all
      select j.id,'journal',j.question,j.answer,j.journal_date,null,null from public.daily_journals j
    ) b where occurred_on between p_from and p_to order by occurred_on,id
    limit greatest(1,least(coalesce(p_limit,61),100)) offset greatest(0,coalesce(p_offset,0))
  ) q;
  return v_result;
end $$;

revoke all on function private.cmv_memory_metadata() from public,anon,authenticated;
revoke all on function public.cmv_list_archive(integer,integer,text,boolean,text),public.cmv_archive_tags(),
  public.cmv_set_memory_options(uuid,boolean,text),public.cmv_weekly_state(),public.cmv_submit_weekly(date,text),
  public.cmv_year_review(),public.cmv_book_items(date,date,integer,integer) from public,anon,authenticated;
grant execute on function public.cmv_list_archive(integer,integer,text,boolean,text),public.cmv_archive_tags(),
  public.cmv_set_memory_options(uuid,boolean,text),public.cmv_weekly_state(),public.cmv_submit_weekly(date,text),
  public.cmv_year_review(),public.cmv_book_items(date,date,integer,integer) to authenticated;
notify pgrst,'reload schema';
commit;
