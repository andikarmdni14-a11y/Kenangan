(() => {
  'use strict';
  const V = window.Vault;
  const { $, db, cfg, state, unwrap, message, node } = V;
  let previewURL = null,
    inboxBusy = false;
  const pageSize = 20;
  const offsets = { replies: 0, daily_journals: 0 };
  const formats = Object.freeze({
    'image/jpeg': ['jpg', 'image'],
    'image/png': ['png', 'image'],
    'image/webp': ['webp', 'image'],
    'image/gif': ['gif', 'image'],
    'video/mp4': ['mp4', 'video'],
    'video/webm': ['webm', 'video'],
    'video/quicktime': ['mov', 'video'],
    'audio/mpeg': ['mp3', 'audio'],
    'audio/mp4': ['m4a', 'audio'],
    'audio/ogg': ['ogg', 'audio'],
    'audio/wav': ['wav', 'audio'],
    'audio/x-wav': ['wav', 'audio'],
    'audio/webm': ['webm', 'audio'],
  });
  function requireAdmin() {
    if (!db || state.role !== 'admin' || !state.user)
      throw new Error('Silakan masuk sebagai Admin dahulu.');
    if (!navigator.onLine)
      throw new Error('Sambungkan internet sebelum menyimpan.');
  }
  function fileFormat(file) {
    if (!file || !file.size)
      throw new Error('Pilih file yang berisi foto, video, atau audio.');
    if (file.size > cfg.MAX_UPLOAD_BYTES)
      throw new Error(
        'Ukuran file melebihi 25 MB. Kompres dahulu, lalu coba lagi.'
      );
    if (!formats[file.type])
      throw new Error(
        'Format belum didukung. Pilih JPG, PNG, WebP, GIF, MP4, WebM, MOV, MP3, M4A, OGG, atau WAV.'
      );
    return formats[file.type];
  }
  function clearPreview() {
    V.stopMedia($('upload-preview'));
    $('upload-preview').replaceChildren();
    $('upload-preview').hidden = true;
    if (previewURL) URL.revokeObjectURL(previewURL);
    previewURL = null;
  }
  function bindForm(id, messageId, action) {
    $(id).addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form); // Sebelum form dinonaktifkan.
      V.formAction(form, messageId, async () => {
        requireAdmin();
        await action(data, form, state.epoch);
      });
    });
  }
  async function refreshAfterSave(messageId, success) {
    message(messageId, success);
    await V.refresh();
  }
  async function fillSettings() {
    requireAdmin();
    const epoch = state.epoch;
    await V.loadSettings();
    const rows = await V.readAll(
      'memories',
      'id,title,media_kind,unlock_at,created_at'
    );
    if (!V.alive(epoch)) return;
    const settings = state.settings;
    $('settings-names').value = settings.couple_names;
    $('settings-start').value = settings.relationship_started_at
      ? V.localInput(settings.relationship_started_at)
      : '';
    $('settings-timezone').value = settings.timezone;
    $('settings-event').value = settings.event_name;
    $('settings-event-at').value = settings.event_at
      ? V.localInput(settings.event_at)
      : '';
    const empty = node('option', '', 'Tanpa musik');
    empty.value = '';
    $('settings-music').replaceChildren(empty);
    rows
      .filter(
        (memory) =>
          memory.media_kind === 'audio' &&
          (!memory.unlock_at || Date.parse(memory.unlock_at) <= V.now())
      )
      .forEach((memory) => {
        const option = node('option', '', memory.title);
        option.value = memory.id;
        $('settings-music').append(option);
      });
    $('settings-music').value = settings.music_memory_id || '';
  }
  function inboxCard(entry, isJournal) {
    const article = node('article', 'inbox-item');
    article.append(
      node(
        'time',
        '',
        V.formatDate(
          isJournal ? entry.journal_date : entry.created_at,
          !isJournal
        )
      )
    );
    if (isJournal) article.append(node('h4', '', entry.question));
    else if (entry.memory_id)
      article.append(node('p', 'context', 'Balasan untuk sebuah kenangan'));
    article.append(node('p', '', isJournal ? entry.answer : entry.body));
    return article;
  }
  async function inboxPage(table, reset = false) {
    requireAdmin();
    const epoch = state.epoch;
    const isJournal = table === 'daily_journals';
    const target = $(isJournal ? 'admin-journals' : 'admin-replies');
    const moreButton = $(isJournal ? 'more-journals' : 'more-replies');
    const offset = reset ? 0 : offsets[table];
    const fields = isJournal
      ? 'id,journal_date,question,answer,created_at'
      : 'id,body,memory_id,created_at';
    const rows = await unwrap(
      db
        .from(table)
        .select(fields)
        .order('created_at', { ascending: false })
        .order('id')
        .range(offset, offset + pageSize - 1)
    );
    if (!V.alive(epoch)) return;
    if (reset) target.replaceChildren();
    offsets[table] = offset + rows.length;
    rows.forEach((entry) => target.append(inboxCard(entry, isJournal)));
    if (!offsets[table])
      target.append(
        node(
          'p',
          'muted tiny',
          isJournal ? 'Belum ada jurnal harian.' : 'Belum ada pesan masuk.'
        )
      );
    moreButton.hidden = rows.length < pageSize;
  }
  async function loadInbox() {
    if (inboxBusy) return;
    const epoch = state.epoch;
    inboxBusy = true;
    message('inbox-message', 'Memuat cerita pasanganmu…');
    try {
      const results = await Promise.allSettled([
        inboxPage('replies', true),
        inboxPage('daily_journals', true),
      ]);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
      if (V.alive(epoch)) message('inbox-message');
    } catch (error) {
      if (V.alive(epoch)) message('inbox-message', V.errorText(error), true);
    } finally {
      inboxBusy = false;
    }
  }

  $('admin-login-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const email = $('admin-email').value,
      password = $('admin-password').value;
    V.formAction(event.currentTarget, 'admin-login-message', async () => {
      await V.login(email, password, 'admin');
      message('admin-login-message');
    });
  });
  $('admin-open').addEventListener('click', async () => {
    try {
      requireAdmin();
      if (!$('admin-dialog').open) $('admin-dialog').showModal();
      if (!$('memory-date').value)
        $('memory-date').value = V.localInput().slice(0, 10);
      await fillSettings();
      if ($('inbox-details').open) await loadInbox();
    } catch (error) {
      V.toast(V.errorText(error));
    }
  });
  $('memory-file').addEventListener('change', () => {
    clearPreview();
    message('upload-message');
    const file = $('memory-file').files[0];
    if (!file) return;
    try {
      const [, kind] = fileFormat(file);
      previewURL = URL.createObjectURL(file);
      const media = node(
        kind === 'image' ? 'img' : kind === 'video' ? 'video' : 'audio'
      );
      media.src = previewURL;
      if (kind === 'image') media.alt = 'Pratinjau unggahan';
      else {
        media.controls = true;
        media.preload = 'metadata';
        media.setAttribute('playsinline', '');
      }
      $('upload-preview').append(media);
      $('upload-preview').hidden = false;
    } catch (error) {
      message('upload-message', V.errorText(error), true);
      $('memory-file').value = '';
    }
  });
  bindForm('upload-form', 'upload-message', async (formData, form, epoch) => {
    const file = formData.get('file');
    const [extension, kind] = fileFormat(file);
    const title = String(formData.get('title')).trim();
    if (!title) throw new Error('Judul kenangan tidak boleh kosong.');
    const unlockValue = formData.get('unlock');
    const unlockAt = unlockValue ? new Date(unlockValue).toISOString() : null;
    const id = crypto.randomUUID();
    const path = `${state.user.id}/${id}.${extension}`;
    const memory = {
      id,
      title,
      caption: String(formData.get('caption')).trim(),
      media_path: path,
      media_kind: kind,
      occurred_on: formData.get('date'),
      unlock_at: unlockAt,
    };
    let uploaded = false;
    $('upload-progress').hidden = false;
    try {
      message(
        'upload-message',
        'Mengunggah media… Jangan tutup halaman dahulu.'
      );
      await unwrap(
        db.storage
          .from(cfg.BUCKET)
          .upload(path, file, {
            upsert: false,
            contentType: file.type,
            cacheControl: '0',
          })
      );
      uploaded = true;
      if (!V.alive(epoch)) return;
      message('upload-message', 'Media terunggah. Menyimpan ceritanya…');
      const { error: insertError } = await db
        .from('memories')
        .insert(memory)
        .select('id')
        .single();
      if (insertError) {
        // Timeout bisa terjadi SETELAH commit. Periksa ID yang sama sebelum cleanup.
        const check = await db
          .from('memories')
          .select('id')
          .eq('id', id)
          .maybeSingle();
        if (check.error)
          throw new Error(
            'Hasil penyimpanan belum dapat dipastikan. Muat ulang galeri sebelum mengunggah ulang. File masih disimpan di Storage.'
          );
        if (!check.data) {
          const cleanup = await db.storage.from(cfg.BUCKET).remove([path]);
          if (cleanup.error)
            throw new Error(
              'Cerita gagal tersimpan dan file belum dapat dibersihkan. Periksa Storage sebelum mencoba lagi.'
            );
          throw insertError;
        }
      }
      if (!V.alive(epoch)) return;
      form.reset();
      clearPreview();
      $('memory-date').value = V.localInput().slice(0, 10);
      await refreshAfterSave(
        'upload-message',
        unlockAt && Date.parse(unlockAt) > V.now()
          ? 'Kapsul waktumu sudah disimpan. ♡'
          : 'Kenangan baru sudah tersimpan. ♡'
      );
      // Jangan menimpa pengaturan lain yang sedang diketik saat memperbarui opsi musik.
      if (kind === 'audio' && (!unlockAt || Date.parse(unlockAt) <= V.now())) {
        const option = node('option', '', title);
        option.value = id;
        $('settings-music').append(option);
      }
    } catch (error) {
      if (
        !uploaded &&
        /fetch|network|abort|timeout/i.test(error.message || '')
      ) {
        throw new Error(
          'Koneksi terputus saat unggah. Periksa galeri dan Storage sebelum mencoba lagi; file mungkin sudah terunggah.'
        );
      }
      throw error;
    } finally {
      $('upload-progress').hidden = true;
    }
  });
  bindForm('bucket-form', 'bucket-message', async (data, form, epoch) => {
    const title = String(data.get('title')).trim();
    if (!title) throw new Error('Tulis impianmu terlebih dahulu.');
    await unwrap(
      db.from('bucket_list').insert({ title }).select('id').single()
    );
    if (!V.alive(epoch)) return;
    form.reset();
    message('bucket-message', 'Impian baru sudah ditambahkan.');
    await V.loadBuckets();
  });
  bindForm('letter-form', 'letter-message', async (data, form, epoch) => {
    const title = String(data.get('title')).trim(),
      body = String(data.get('body')).trim();
    if (!title || !body) throw new Error('Isi judul dan suratmu dahulu.');
    await unwrap(
      db.from('love_letters').insert({ title, body }).select('id').single()
    );
    if (!V.alive(epoch)) return;
    form.reset();
    message('letter-message', 'Suratmu sudah tersimpan di dalam amplop.');
    await V.loadLetters();
  });
  bindForm('settings-form', 'settings-message', async (data, form, epoch) => {
    const names = String(data.get('names')).trim();
    if (!names) throw new Error('Isi nama kalian dahulu.');
    const eventName = String(data.get('event')).trim();
    if (data.get('eventAt') && !eventName)
      throw new Error('Beri nama untuk hari spesialmu.');
    const settings = {
      couple_names: names,
      relationship_started_at: data.get('start')
        ? new Date(data.get('start')).toISOString()
        : null,
      timezone: data.get('timezone'),
      event_name: eventName,
      event_at: data.get('eventAt')
        ? new Date(data.get('eventAt')).toISOString()
        : null,
      music_memory_id: data.get('music') || null,
    };
    await unwrap(
      db.from('app_settings').update(settings).eq('id', 1).select('id').single()
    );
    if (!V.alive(epoch)) return;
    await refreshAfterSave(
      'settings-message',
      'Pengaturan cerita kita sudah diperbarui.'
    );
  });
  $('inbox-details').addEventListener('toggle', () => {
    if ($('inbox-details').open && state.role === 'admin') loadInbox();
  });
  $('inbox-refresh').addEventListener('click', loadInbox);
  for (const [id, table] of [
    ['more-replies', 'replies'],
    ['more-journals', 'daily_journals'],
  ]) {
    $(id).addEventListener('click', async () => {
      $(id).disabled = true;
      try {
        await inboxPage(table);
      } catch (error) {
        message('inbox-message', V.errorText(error), true);
      } finally {
        $(id).disabled = false;
      }
    });
  }
  $('admin-dialog').addEventListener('close', () => {
    $('upload-preview')
      .querySelectorAll('video,audio')
      .forEach((media) => media.pause());
  });
  document.addEventListener('cmv:locked', () => {
    clearPreview();
    offsets.replies = 0;
    offsets.daily_journals = 0;
    inboxBusy = false;
    const option = node('option', '', 'Tanpa musik');
    option.value = '';
    $('settings-music').replaceChildren(option);
  });
})();
