/* Arsip pribadi, pertanyaan berdua, kilas balik, EXIF, rekaman, dan ekspor. */
(() => {
  "use strict";
  const V = window.Vault, C = window.MemoryCore;
  const { $, state, db, unwrap, node } = V;
  let tags = [], filtering = false, weekly = null, weeklyTicket = 0;
  let weeklyReading = false, weeklySending = false, audioPage = 0, audioBusy = false;
  let metaFile = null, metaPromise = Promise.resolve(), metaTicket = 0, autoPoint = null;
  let recorder = null, recordingTicket = 0, recordTimer = 0, stream = null;
  let review = null, slideIndex = 0, slideTicket = 0, slideURL = null;
  let bookTicket = 0, bookBusy = false, bookURL = null, favorite = null;
  const error = (id, e) => V.message(id, V.errorText(e), true);
  const canContinue = epoch => { if (!V.alive(epoch)) throw Error("Sesi sudah dikunci."); };
  const filters = () => ({...state.archiveFilters});
  const matches = memory => C.archiveMatch(memory, state.archiveFilters);

  function paintFilters() {
    const bar = $("archive-tags"); bar.replaceChildren();
    for (const tag of [null, ...tags]) {
      const b = node("button", "filter-chip", tag ? `#${tag}` : "Semua label");
      b.type = "button"; b.setAttribute("aria-pressed", String(state.archiveFilters.tag === tag));
      b.disabled = filtering;
      b.onclick = () => applyFilters({...filters(), tag}); bar.append(b);
    }
    $("filter-voice").setAttribute("aria-pressed", String(state.archiveFilters.kind === "voice_note"));
    $("filter-location").setAttribute("aria-pressed", String(state.archiveFilters.withLocation));
    $("filter-voice").disabled = $("filter-location").disabled = filtering;
  }
  async function applyFilters(next) {
    if (filtering) return;
    filtering = true; paintFilters();
    try {
      await V.filterGallery(next);
      window.VaultFeatures.renderMap();
    } catch (e) { V.toast(V.errorText(e)); }
    finally { filtering = false; paintFilters(); }
  }
  $("filter-voice").onclick = () => applyFilters({...filters(), kind: state.archiveFilters.kind ? null : "voice_note"});
  $("filter-location").onclick = () => applyFilters({...filters(), withLocation: !state.archiveFilters.withLocation});
  async function loadTags() {
    const epoch = state.epoch;
    const data = await V.local.cached("archive-tags-v6", () => unwrap(db.rpc("cmv_archive_tags")));
    if (!V.alive(epoch)) return;
    tags = [...new Set([...data, ...(state.archiveFilters.tag ? [state.archiveFilters.tag] : [])])].sort();
    paintFilters();
  }

  function paintWeekly(data) {
    const wasRevealed = weekly?.week_start === data.week_start && weekly?.revealed;
    weekly = data;
    $("weekly-question").textContent = data.question;
    $("weekly-form").hidden = data.own_answered;
    $("weekly-submit").disabled = data.own_answered || !navigator.onLine;
    $("weekly-own").hidden = !data.own_answered;
    $("weekly-own").replaceChildren();
    if (data.own_answered) {
      $("weekly-answer").value = "";
      $("weekly-own").append(node("h3", "", "Jawabanmu"), node("p", "preserve-lines", data.own_answer || ""));
    }
    const partner = $("weekly-partner"); partner.replaceChildren();
    if (data.revealed === true && data.user_a_answered === true && data.user_b_answered === true) {
      partner.className = "weekly-answer";
      partner.append(node("h3", "", "Jawaban pasangan"), node("p", "preserve-lines", data.partner_answer || ""));
      if (!wasRevealed && !matchMedia("(prefers-reduced-motion: reduce)").matches)
        partner.animate?.([{opacity: 0, transform: "translateY(8px)"}, {opacity: 1, transform: "none"}], {duration: 320});
    } else {
      partner.className = "weekly-locked";
      const lock = node("span", "", "▣"); lock.setAttribute("aria-hidden", "true");
      partner.append(lock, node("p", "", data.partner_answered ? "Pasangan sudah menjawab. Giliranmu untuk membuka cerita ini." : "Jawaban pasangan masih terkunci."));
    }
    V.message("weekly-status", data.revealed ? "Kalian sudah menjawab. Selamat saling menemukan lagi." : data.own_answered ? "Jawabanmu tersimpan. Menunggu pasangan menjawab." : `Pekan ${V.formatDate(data.week_start)} · Jawaban hanya dibuka bersama.`);
  }
  async function loadWeekly() {
    if (!state.user || weeklyReading || weeklySending) return;
    if (!navigator.onLine) { $("weekly-submit").disabled = true; V.message("weekly-status", "Sambungkan internet untuk memeriksa atau mengirim jawaban berdua."); return; }
    weeklyReading = true;
    const ticket = ++weeklyTicket, epoch = state.epoch;
    try {
      // No local cache of hidden answers. Server returns null until both members answer.
      const result = await unwrap(db.rpc("cmv_weekly_state"));
      if (V.alive(epoch) && ticket === weeklyTicket) paintWeekly(result);
    } catch (e) { if (V.alive(epoch) && ticket === weeklyTicket) { $("weekly-submit").disabled = true; error("weekly-status", e); } }
    finally { weeklyReading = false; }
  }
  $("weekly-refresh").onclick = loadWeekly;
  $("weekly-form").addEventListener("submit", event => {
    event.preventDefault();
    if (!weekly || weeklySending) return;
    const week = weekly.week_start, answer = $("weekly-answer").value.trim(), epoch = state.epoch;
    V.formAction(event.currentTarget, "weekly-status", async () => {
      if (!navigator.onLine) throw Error("Sambungkan internet untuk mengirim jawaban.");
      weeklySending = true; const ticket = ++weeklyTicket;
      try {
        const data = await unwrap(db.rpc("cmv_submit_weekly", {p_week: week, p_answer: answer}));
        if (V.alive(epoch) && ticket === weeklyTicket) paintWeekly(data);
      } finally { weeklySending = false; }
    });
  });
  setInterval(() => {
    if (state.user && !document.hidden && window.VaultPages.current === "jurnal") loadWeekly();
  }, 15000);
  document.addEventListener("cmv:page", event => { if (event.detail.page === "jurnal") loadWeekly(); });

  function paintUploadTags() {
    $("upload-tag-chips").replaceChildren();
    try {
      for (const tag of C.normalizeTags($("memory-tags").value)) {
        const b = node("button", "filter-chip", `#${tag} ×`);
        b.type = "button"; b.setAttribute("aria-label", `Hapus label ${tag}`);
        b.onclick = () => { $("memory-tags").value = C.normalizeTags($("memory-tags").value).filter(x => x !== tag).map(x => `#${x}`).join(" "); paintUploadTags(); };
        $("upload-tag-chips").append(b);
      }
      $("memory-tags-help").textContent = "Pisahkan dengan spasi atau koma. Maksimal 8 label.";
    } catch (e) { $("memory-tags-help").textContent = e.message; }
  }
  $("memory-tags").addEventListener("input", paintUploadTags);
  V.all("[data-add-tag]").forEach(b => b.onclick = () => {
    try { $("memory-tags").value = C.normalizeTags([...C.normalizeTags($("memory-tags").value), b.dataset.addTag]).map(t => `#${t}`).join(" "); paintUploadTags(); }
    catch (e) { V.toast(e.message); }
  });
  function clearAutoPoint() {
    if (autoPoint && $("memory-lat").value === autoPoint.lat && $("memory-lng").value === autoPoint.lng)
      $("memory-lat").value = $("memory-lng").value = "";
    autoPoint = null;
  }
  function readPhoto(file) {
    const ticket = ++metaTicket; metaFile = file; clearAutoPoint();
    metaPromise = (async () => {
      if (!file?.type.startsWith("image/") || !$("memory-exif").checked) return;
      if (file.size > V.cfg.MAX_UPLOAD_BYTES) return;
      V.message("exif-status", "Membaca lokasi di foto…");
      const point = C.gpsFromExif(await file.arrayBuffer());
      if (ticket !== metaTicket || !$("memory-exif").checked) return;
      if (!point) { V.message("exif-status", "Foto ini tidak memiliki GPS yang dapat dibaca. Kamu bisa memilih titik di peta."); return; }
      if ($("memory-lat").value || $("memory-lng").value) { V.message("exif-status", "GPS ditemukan. Titik yang sudah kamu pilih tetap dipakai."); return; }
      autoPoint = {lat: point.lat.toFixed(6), lng: point.lng.toFixed(6)};
      $("memory-lat").value = autoPoint.lat; $("memory-lng").value = autoPoint.lng;
      V.message("exif-status", "Lokasi foto sudah terisi. Pin akan muncul setelah kenangan disimpan.");
    })().catch(() => { if (ticket === metaTicket) V.message("exif-status", "Lokasi foto belum terbaca. Pilih titik di peta jika diperlukan."); });
    return metaPromise;
  }
  $("memory-file").addEventListener("change", () => {
    const file = $("memory-file").files[0];
    $("audio-purpose-wrap").hidden = !file?.type.startsWith("audio/");
    readPhoto(file);
  });
  $("memory-exif").addEventListener("change", () => {
    if ($("memory-exif").checked) readPhoto($("memory-file").files[0]);
    else { ++metaTicket; clearAutoPoint(); V.message("exif-status", "Lokasi otomatis dimatikan. File asli tetap disimpan utuh."); }
  });
  for (const id of ["memory-lat", "memory-lng"]) $(id).addEventListener("input", () => { autoPoint = null; });
  for (const id of ["location-pick", "location-current", "location-clear"]) $(id).addEventListener("click", () => { ++metaTicket; autoPoint = null; });
  $("upload-form").addEventListener("reset", () => {
    ++metaTicket; metaFile = null; autoPoint = null;
    $("upload-tag-chips").replaceChildren(); $("audio-purpose-wrap").hidden = true;
    V.message("voice-status"); V.message("exif-status", "Lokasi akan diisi jika foto memiliki metadata GPS.");
  });

  function stopRecording(cancel = false) {
    clearTimeout(recordTimer);
    if (cancel) ++recordingTicket;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    stream?.getTracks().forEach(t => t.stop()); stream = null;
    $("voice-record").disabled = false; $("voice-stop").hidden = true;
  }
  $("voice-record").onclick = async () => {
    if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia || !window.DataTransfer) { V.message("voice-status", "Perekam belum tersedia di browser ini. Unggah rekaman dari aplikasi perekam HP."); return; }
    if ($("memory-file").files.length && !await window.VaultFeatures.confirmAction("Ganti file yang dipilih dengan rekaman baru?")) return;
    const ticket = ++recordingTicket, epoch = state.epoch;
    $("voice-record").disabled = true;
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({audio: true});
      if (!V.alive(epoch) || ticket !== recordingTicket || !$("admin-dialog").open) { acquired.getTracks().forEach(t => t.stop()); return; }
      stream = acquired; $("background-music").pause();
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find(t => MediaRecorder.isTypeSupported(t));
      if (!mimeType) throw Error("Format rekaman belum didukung. Gunakan aplikasi perekam HP lalu unggah filenya.");
      recorder = new MediaRecorder(stream, {mimeType});
      const parts = [], started = Date.now(); let size = 0;
      recorder.ondataavailable = event => {
        if (event.data.size) { parts.push(event.data); size += event.data.size; }
        if (ticket === recordingTicket) V.message("voice-status", `Merekam ${Math.round((Date.now() - started) / 1000)} detik · batas 2 menit.`);
        if (size > V.cfg.MAX_UPLOAD_BYTES) { stopRecording(true); V.message("voice-status", "Rekaman terlalu besar. Coba rekaman lebih pendek."); }
      };
      recorder.onerror = () => { stopRecording(true); V.message("voice-status", "Rekaman terhenti. Coba lagi atau unggah dari HP."); };
      recorder.onstop = () => {
        if (ticket !== recordingTicket || !V.alive(epoch)) return;
        stream?.getTracks().forEach(t => t.stop()); stream = null; clearTimeout(recordTimer);
        $("voice-record").disabled = false; $("voice-stop").hidden = true;
        const type = mimeType.split(";")[0], ext = type === "audio/mp4" ? "m4a" : type === "audio/ogg" ? "ogg" : "webm";
        if (!size) { V.message("voice-status", "Belum ada suara terekam. Coba lagi."); return; }
        const file = new File(parts, `pesan-suara.${ext}`, {type});
        const transfer = new DataTransfer(); transfer.items.add(file); $("memory-file").files = transfer.files;
        $("memory-audio-purpose").value = "voice_note";
        $("memory-file").dispatchEvent(new Event("change"));
        V.message("voice-status", "Rekaman siap. Isi judul lalu simpan kenangan.");
      };
      recorder.start(1000); $("voice-stop").hidden = false;
      V.message("voice-status", "Sedang merekam… Tekan Selesai saat sudah cukup.");
      recordTimer = setTimeout(() => stopRecording(), 120000);
    } catch (e) { stopRecording(true); V.message("voice-status", e.name === "NotAllowedError" ? "Mikrofon belum diizinkan. Kamu tetap bisa mengunggah file rekaman." : V.errorText(e), true); }
  };
  $("voice-stop").onclick = () => stopRecording();
  $("admin-dialog").addEventListener("close", () => stopRecording(true));

  async function loadAudio(page = 0) {
    if (audioBusy || !state.user) return;
    audioBusy = true; const epoch = state.epoch;
    $("audio-next").disabled = $("audio-previous").disabled = true;
    try {
      const rows = await unwrap(db.from("memories").select("id,title,type,media_kind").eq("media_kind", "audio").order("created_at", {ascending: false}).order("id").range(page * 20, page * 20 + 20));
      if (!V.alive(epoch)) return;
      audioPage = page; $("audio-library-list").replaceChildren();
      for (const m of rows.slice(0, 20)) {
        const row = node("div", "audio-library-row"), label = node("label", "", m.title);
        const select = node("select"); select.id = `audio-type-${m.id}`; label.htmlFor = select.id;
        for (const [value, text] of [["legacy_audio", "Belum ditandai · pemutar musik"], ["voice_note", "Pesan Suara · Rak Kenangan"], ["music", "Lagu · pemutar musik"]]) {
          const option = node("option", "", text); option.value = value; option.disabled = value === "legacy_audio"; select.append(option);
        }
        select.value = m.type;
        select.onchange = async () => {
          select.disabled = true;
          try {
            const result = await unwrap(db.rpc("cmv_set_memory_options", {p_id: m.id, p_type: select.value}));
            if (!V.alive(epoch)) return;
            m.type = result.type; V.message("audio-library-status", "Jenis audio tersimpan."); await V.refresh();
          } catch (e) { if (V.alive(epoch)) { select.value = m.type; error("audio-library-status", e); } }
          finally { select.disabled = false; }
        };
        row.append(label, select); $("audio-library-list").append(row);
      }
      V.message("audio-library-status", rows.length ? `Halaman ${page + 1} · pilihan langsung tersimpan.` : "Belum ada audio.");
      $("audio-next").disabled = rows.length <= 20;
    } catch (e) { if (V.alive(epoch)) error("audio-library-status", e); }
    finally { audioBusy = false; $("audio-previous").disabled = audioPage === 0; }
  }
  $("audio-library").addEventListener("toggle", () => { if ($("audio-library").open) loadAudio(); });
  $("audio-next").onclick = () => loadAudio(audioPage + 1);
  $("audio-previous").onclick = () => loadAudio(Math.max(0, audioPage - 1));
  function paintFavorite() {
    $("memory-favorite").setAttribute("aria-pressed", String(!!favorite?.is_favorite));
    $("memory-favorite").textContent = favorite?.is_favorite ? "Tersimpan sebagai favorit" : "Jadikan favorit";
  }
  document.addEventListener("cmv:memory-open", e => { favorite = e.detail; paintFavorite(); });
  $("memory-favorite").onclick = async () => {
    if (!favorite) return;
    const selected = favorite, epoch = state.epoch; $("memory-favorite").disabled = true;
    try {
      const result = await unwrap(db.rpc("cmv_set_memory_options", {p_id: selected.id, p_favorite: !selected.is_favorite}));
      if (V.alive(epoch) && favorite?.id === selected.id) { favorite.is_favorite = result.is_favorite; paintFavorite(); }
    } catch (e) { if (V.alive(epoch)) V.toast(V.errorText(e)); }
    finally { $("memory-favorite").disabled = false; }
  };

  async function mediaBlob(path, epoch) {
    const blob = await V.local.media(path, () => unwrap(db.storage.from(V.cfg.BUCKET).download(path)));
    canContinue(epoch); return blob;
  }
  function releaseSlide() {
    ++slideTicket; V.stopMedia($("review-slide")); $("review-slide").replaceChildren();
    if (slideURL) URL.revokeObjectURL(slideURL); slideURL = null;
  }
  async function showSlide(index) {
    if (!review || !$("review-dialog").open) return;
    releaseSlide(); const ticket = slideTicket, epoch = state.epoch, area = $("review-slide");
    slideIndex = Math.max(0, Math.min(index, review.slides.length + 1));
    $("review-progress").textContent = `${slideIndex + 1} / ${review.slides.length + 2}`;
    $("review-previous").disabled = slideIndex === 0;
    $("review-next").textContent = slideIndex === review.slides.length + 1 ? "Selesai" : "Berikutnya →";
    if (slideIndex === 0) {
      area.append(node("p", "eyebrow", review.anniversary ? "SELAMAT HARI JADI" : "SATU TAHUN CERITA KITA"), node("h3", "review-title", review.couple_names),
        node("p", "", "Ada banyak hari biasa yang menjadi istimewa karena kita menjalaninya bersama."),
        node("p", "tiny muted", `${V.formatDate(review.from_date)} – ${V.formatDate(review.to_date)}`),
        node("p", "tiny muted", "Ketuk sisi kanan untuk lanjut. Geser atau gunakan tombol di bawah."));
      return;
    }
    if (slideIndex === review.slides.length + 1) {
      area.append(node("p", "eyebrow", "DAN CERITA INI MASIH BERLANJUT"), node("h3", "review-title", review.days_together === null ? "Bersamamu" : `${review.days_together.toLocaleString("id-ID")} hari bersama`));
      for (const text of [`${review.stats.total} kenangan setahun ini`, `${review.stats.photos} foto · ${review.stats.voice_notes} pesan suara`, `${review.stats.favorites} favorit kita`]) area.append(node("p", "", text));
      if (!review.slides.length) area.append(node("p", "tiny muted", "Belum ada foto atau pesan suara pada periode ini. Tambahkan cerita pertama kita."));
      return;
    }
    const m = review.slides[slideIndex - 1];
    area.append(node("p", "eyebrow", m.type === "voice_note" ? "SUARAMU, DEKAT LAGI" : m.is_favorite ? "FAVORIT KITA" : "POTONGAN CERITA"));
    const frame = node("div", "review-media"), status = node("p", "tiny muted", "Membuka kenangan…"); frame.append(status); area.append(frame);
    area.append(node("h3", "", m.title), node("p", "preserve-lines", m.caption), node("p", "tiny muted", V.formatDate(m.occurred_on)));
    try {
      const blob = await mediaBlob(m.preview_path || m.media_path, epoch);
      if (ticket !== slideTicket || !$("review-dialog").open) return;
      slideURL = URL.createObjectURL(blob);
      const media = node(m.type === "voice_note" ? "audio" : "img"); media.src = slideURL;
      if (m.type === "voice_note") { media.controls = true; media.preload = "metadata"; media.setAttribute("aria-label", `Dengarkan pesan suara: ${m.title}`); }
      else { media.alt = m.title; media.loading = "lazy"; media.decoding = "async"; }
      frame.replaceChildren(media);
    } catch (e) { if (V.alive(epoch) && ticket === slideTicket) status.textContent = V.errorText(e); }
  }
  $("review-open").onclick = async () => {
    const epoch = state.epoch; review = null; releaseSlide(); const ticket = slideTicket;
    $("review-dialog").showModal(); $("background-music").pause();
    $("review-slide").append(node("p", "", "Merangkai kembali cerita kita…"));
    $("review-previous").disabled = $("review-next").disabled = true;
    try {
      const result = await unwrap(db.rpc("cmv_year_review"));
      if (!V.alive(epoch) || ticket !== slideTicket || !$("review-dialog").open) return;
      review = result; $("review-next").disabled = false; showSlide(0);
    } catch (e) { if (V.alive(epoch) && ticket === slideTicket) $("review-slide").replaceChildren(node("p", "", V.errorText(e))); }
  };
  const nextSlide = () => { if (!review) return; if (slideIndex === review.slides.length + 1) $("review-dialog").close(); else showSlide(slideIndex + 1); };
  $("review-next").onclick = nextSlide; $("review-previous").onclick = () => showSlide(slideIndex - 1);
  $("review-dialog").addEventListener("keydown", e => {
    if (e.target.closest("audio, input, textarea")) return;
    if (e.key === "ArrowRight") { e.preventDefault(); nextSlide(); }
    if (e.key === "ArrowLeft") { e.preventDefault(); showSlide(slideIndex - 1); }
  });
  let pointer = null, skipClick = false;
  $("review-slide").addEventListener("pointerdown", e => { pointer = {x: e.clientX, y: e.clientY}; skipClick = false; });
  $("review-slide").addEventListener("pointerup", e => {
    if (!pointer || e.target.closest("audio,button,a")) return;
    const dx = e.clientX - pointer.x, dy = e.clientY - pointer.y; pointer = null;
    if (Math.abs(dy) > 20) { skipClick = true; return; }
    if (Math.abs(dx) > 40) { skipClick = true; dx < 0 ? nextSlide() : showSlide(slideIndex - 1); }
  });
  $("review-slide").addEventListener("click", e => {
    if (skipClick) { skipClick = false; return; }
    if (e.target.closest("audio,button,a") || window.getSelection()?.toString()) return;
    const rect = $("review-slide").getBoundingClientRect();
    e.clientX < rect.left + rect.width / 3 ? showSlide(slideIndex - 1) : nextSlide();
  });
  $("review-dialog").addEventListener("close", () => { releaseSlide(); review = null; $("review-open").focus({preventScroll: true}); });

  function clearBook() {
    if (bookURL) URL.revokeObjectURL(bookURL); bookURL = null;
    $("book-download").hidden = true; $("book-download").removeAttribute("href");
  }
  $("book-open").onclick = () => {
    $("sync-dialog").close();
    const to = new Date(V.now()), from = new Date(to); from.setFullYear(from.getFullYear() - 1);
    $("book-from").value ||= V.localInput(from).slice(0, 10); $("book-to").value ||= V.localInput(to).slice(0, 10);
    $("book-dialog").showModal();
  };
  const cancelBook = () => { ++bookTicket; if (bookBusy) V.message("book-status", "Pembuatan dibatalkan. Kamu bisa mencoba lagi setelah proses berhenti."); };
  $("book-cancel").onclick = cancelBook;
  $("book-dialog").addEventListener("close", cancelBook);
  $("book-form").addEventListener("submit", e => {
    e.preventDefault(); if (bookBusy) return;
    const from = $("book-from").value, to = $("book-to").value, epoch = state.epoch;
    V.formAction(e.currentTarget, "book-status", async () => {
      if (from > to) throw Error("Tanggal akhir perlu sesudah tanggal awal.");
      const ticket = ++bookTicket; bookBusy = true; clearBook(); $("book-cancel").hidden = false;
      const active = () => V.alive(epoch) && ticket === bookTicket;
      try {
        V.message("book-status", "Mengumpulkan foto dan jurnal…");
        const items = await unwrap(db.rpc("cmv_book_items", {p_from: from, p_to: to, p_offset: 0, p_limit: 61}));
        if (!active()) return;
        if (!items.length) throw Error("Belum ada kenangan atau jurnal terbuka dalam rentang ini.");
        if (items.length > 60) throw Error("Ada lebih dari 60 catatan. Pilih rentang lebih pendek agar buku ringan dibuat di HP.");
        const bytes = await window.MemoryBook.create({items, title: state.settings?.couple_names || "Kita berdua", from, to,
          image: async m => {
            const blob = await mediaBlob(m.media_path, epoch); if (!active()) throw Error("Pembuatan dibatalkan.");
            const url = URL.createObjectURL(blob);
            try { const img = new Image(); img.src = url; await img.decode(); return img; }
            finally { URL.revokeObjectURL(url); }
          }, active, progress: text => { if (active()) V.message("book-status", text); }});
        if (!active()) return;
        bookURL = URL.createObjectURL(new Blob([bytes], {type: "application/pdf"}));
        $("book-download").href = bookURL; $("book-download").download = `Buku-Kenangan-${from}-${to}.pdf`; $("book-download").hidden = false;
        V.message("book-status", "Buku siap. Tekan Unduh, lalu cetak dengan ukuran kertas A4.");
      } catch (err) { if (active()) throw err; }
      finally { bookBusy = false; $("book-cancel").hidden = true; }
    });
  });
  document.addEventListener("cmv:locked", () => {
    ++weeklyTicket; ++metaTicket; ++bookTicket; stopRecording(true); clearBook(); releaseSlide();
    weekly = review = favorite = null; tags = []; metaFile = autoPoint = null;
    state.archiveFilters = {tag: null, withLocation: false, kind: null}; paintFilters();
    $("weekly-answer").value = ""; $("weekly-own").replaceChildren(); $("weekly-partner").replaceChildren();
    $("weekly-question").textContent = "Buka pertanyaan untuk kita berdua.";
    $("audio-library-list").replaceChildren(); $("weekly-form").hidden = false;
    for (const id of ["weekly-status", "audio-library-status", "book-status", "voice-status"]) V.message(id);
  });
  window.VaultEpic = {
    matches,
    async load() { await Promise.allSettled([loadTags(), loadWeekly()]); },
    async prepareUpload(file) { if (recorder?.state === "recording") throw Error("Selesaikan rekaman dahulu."); if (metaFile !== file) readPhoto(file); await metaPromise; },
    get unsaved() { return bookBusy || recorder?.state === "recording" || !!$("weekly-answer").value.trim(); },
    async canLock() {
      if (weeklySending) { V.toast("Tunggu jawaban selesai dikirim."); return false; }
      if (!this.unsaved) return true;
      return window.VaultFeatures.confirmAction("Masih ada jawaban yang belum dikirim atau proses yang berjalan. Kunci dan tinggalkan sekarang?");
    }
  };
  paintFilters();
})();
