/* Vanilla JS. Semua aturan otorisasi tetap diperiksa ulang oleh Supabase. */
(() => {
  "use strict";
  const db = window.vaultClient;
  const cfg = window.VAULT_CONFIG;
  const local = window.VaultLocal;
  const pages = window.VaultPages;
  const $ = (id) => pages.get(id);
  const all = (selector) => pages.all(selector);
  const state = {
    user: null,
    role: null,
    epoch: 0,
    settings: null,
    memories: [],
    letters: [],
    more: false,
    galleryOffset: 0,
    galleryPage: 0,
    musicTracks: [],
    musicTrackId: null,
    view: "masonry",
    prompt: null,
    journalDirty: false,
    replyMemory: null,
    nextReplyAt: 0,
    replyBusy: false,
    serverBase: Date.now(),
    receivedAt: performance.now(),
  };
  const objectURLs = new Map();
  const pendingBuckets = new Map();
  const GALLERY_PAGE_SIZE = Math.min(24, Math.max(1, Math.floor(Number(cfg.PAGE_SIZE) || 24)));
  let galleryGeneration = 0, photoFrame = 0;
  let toastTimer,
    envelopeTimer,
    refreshing = false,
    galleryBusy = false;
  let authenticating = false,
    currentMemory = null,
    memoryOpener = null,
    observer,
    activeDownloads = 0;
  let downloadQueue = [],
    installPrompt = null,
    waitingWorker = null,
    musicBusy = false;
  let musicSequence = 0;
  const now = () => state.serverBase + performance.now() - state.receivedAt;
  const alive = (epoch) => epoch === state.epoch && Boolean(state.user);
  function syncTime(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return;
    state.serverBase = Date.parse(value);
    state.receivedAt = performance.now();
  }
  function node(tag, className = "", text = "") {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== "") result.textContent = text;
    return result;
  }
  function message(id, text = "", error = false) {
    $(id).textContent = text;
    $(id).classList.toggle("error", error);
  }
  function toast(text, duration = 3000) {
    clearTimeout(toastTimer);
    const popup = $("toast"), announcement = $("toast-announcement");
    // Keep feedback inside the active modal's top layer and accessibility tree.
    const host = [...document.querySelectorAll("dialog[open]")].at(-1) || document.body;
    host.append(popup, announcement);
    popup.textContent = text;
    popup.hidden = false;
    announcement.textContent = "";
    requestAnimationFrame(() => { announcement.textContent = text; });
    toastTimer = setTimeout(() => {
      popup.hidden = true;
      announcement.textContent = "";
    }, duration);
  }
  function errorText(error) {
    const raw = String(error?.message || error || "Terjadi kesalahan.");
    if (error?.name === "QuotaExceededError")
      return "Penyimpanan perangkat penuh. Jangan tutup tulisanmu; kosongkan ruang dahulu.";
    if (!navigator.onLine)
      return "Kamu sedang offline. Sambungkan internet lalu coba lagi.";
    if (/abort|fetch|network|timeout/i.test(raw))
      return "Koneksi terputus atau terlalu lama. Coba lagi sebentar.";
    if (/Invalid login credentials/i.test(raw))
      return "Email atau kata sandi belum cocok.";
    if (/Email not confirmed/i.test(raw))
      return "Email akun belum dikonfirmasi di Supabase.";
    if (/rate limit|too many requests/i.test(raw))
      return "Terlalu banyak percobaan masuk. Tunggu sebentar.";
    if (/row-level security|permission denied/i.test(raw))
      return "Akses tidak diizinkan. Periksa role akun dan setup.sql.";
    if (/schema cache|does not exist|PGRST202/i.test(raw))
      return "Fitur belum siap di database. Jalankan upgrade-v4.sql, lalu muat ulang.";
    if (/COOLDOWN:/.test(raw)) return raw.replace("COOLDOWN: ", "");
    return raw;
  }
  async function unwrap(query) {
    const { data, error } = await query;
    if (error) throw error;
    return data;
  }
  async function readAll(table, fields, order = "created_at") {
    return local.cached(`table:${table}:${fields}:${order}`, async () => {
      const all = [];
      for (let offset = 0; ; offset += 250) {
        const rows = await unwrap(
          db
            .from(table)
            .select(fields)
            .order(order, { ascending: false })
            .order("id")
            .range(offset, offset + 249),
        );
        all.push(...rows);
        if (rows.length < 250) return all;
      }
    });
  }
  function formatDate(value, withTime = false) {
    if (!value) return "";
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const date = dateOnly ? new Date(`${value}T12:00:00`) : new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    const options = { day: "numeric", month: "long", year: "numeric" };
    if (!dateOnly)
      options.timeZone = state.settings?.timezone || "Asia/Jakarta";
    if (withTime && !dateOnly)
      Object.assign(options, {
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      });
    return new Intl.DateTimeFormat("id-ID", options).format(date);
  }
  function localInput(value = new Date()) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  }
  function clearValidation(form) {
    form.querySelectorAll(".field-error").forEach((el) => el.remove());
    form.querySelectorAll("[aria-invalid]").forEach((el) => {
      el.removeAttribute("aria-invalid");
      const ids = (el.getAttribute("aria-describedby") || "")
        .split(" ")
        .filter((x) => !x.endsWith("-error"));
      if (ids.length) el.setAttribute("aria-describedby", ids.join(" "));
      else el.removeAttribute("aria-describedby");
    });
  }
  function fieldError(control, text) {
    control.setAttribute("aria-invalid", "true");
    const id = `${control.id}-error`;
    $(id)?.remove();
    const error = node("p", "field-error", text);
    error.id = id;
    control.setAttribute(
      "aria-describedby",
      [
        ...new Set([
          ...(control.getAttribute("aria-describedby") || "")
            .split(" ")
            .filter(Boolean),
          id,
        ]),
      ].join(" "),
    );
    // Keep the message outside the password + visibility-button flex row.
    (control.closest(".password-field") || control).insertAdjacentElement(
      "afterend",
      error,
    );
  }
  function validateForm(form) {
    clearValidation(form);
    let first;
    const fail = (el, text) => {
      fieldError(el, text);
      first ||= el;
    };
    for (const control of form.elements) {
      if (
        !control.willValidate ||
        control.disabled ||
        ["submit", "button", "checkbox"].includes(control.type)
      )
        continue;
      const value = String(control.value || "").trim();
      const name =
        control.labels?.[0]?.textContent.trim().replace(/\s+/g, " ") ||
        "Bagian ini";
      if (control.required && !value)
        fail(control, `${name} perlu diisi dahulu, ya.`);
      else if (control.validity.typeMismatch)
        fail(
          control,
          "Tulis alamat email yang lengkap, misalnya nama@email.com.",
        );
      else if (
        control.validity.badInput ||
        control.validity.rangeOverflow ||
        control.validity.rangeUnderflow
      )
        fail(
          control,
          `Isi ${name.toLowerCase()} dalam rentang ${control.min} sampai ${control.max}.`,
        );
      else if (control.maxLength > 0 && value.length > control.maxLength)
        fail(control, `Maksimal ${control.maxLength} karakter, ya.`);
      else if (
        control.type === "datetime-local" &&
        value &&
        (!Number.isFinite(Date.parse(value)) ||
          (control.id.includes("unlock") && Date.parse(value) <= now()))
      )
        fail(control, "Pilih tanggal dan jam di masa depan.");
    }
    if (form.id === "upload-form") {
      const lat = $("memory-lat"),
        lng = $("memory-lng");
      if (
        (lat.value || lng.value || $("memory-place").value.trim()) &&
        (!lat.value || !lng.value)
      )
        fail(
          !lat.value ? lat : lng,
          "Pilih titik di peta atau lengkapi kedua koordinat.",
        );
    }
    first?.focus();
    return !first;
  }
  document.addEventListener("input", (event) => {
    const el = event.target;
    if (el.hasAttribute("aria-invalid")) {
      el.removeAttribute("aria-invalid");
      $(el.id + "-error")?.remove();
      const described = (el.getAttribute("aria-describedby") || "")
        .split(" ")
        .filter((id) => id && id !== el.id + "-error");
      if (described.length)
        el.setAttribute("aria-describedby", described.join(" "));
      else el.removeAttribute("aria-describedby");
    }
  });
  document.addEventListener("reset", (event) => clearValidation(event.target));
  async function formAction(form, messageId, action) {
    if (!validateForm(form)) {
      message(messageId, "Ada bagian yang perlu dilengkapi di atas.", true);
      return;
    }
    if (form.dataset.busy) return;
    const controls = [...form.elements];
    const oldDisabled = controls.map((control) => control.disabled);
    form.dataset.busy = "true";
    form.setAttribute("aria-busy", "true");
    controls.forEach((control) => {
      control.disabled = true;
    });
    message(messageId, "Sebentar, ya…");
    try {
      await action();
    } catch (error) {
      message(messageId, errorText(error), true);
    } finally {
      controls.forEach((control, index) => {
        control.disabled = oldDisabled[index];
      });
      delete form.dataset.busy;
      form.removeAttribute("aria-busy");
      window.VaultFeatures?.formDone(form.id);
    }
  }
  function requireClient() {
    if (!db) throw new Error(window.vaultConfigError || "Supabase belum siap.");
    if (!navigator.onLine)
      throw new Error("Sambungkan internet untuk membuka kenangan.");
  }
  function stopMedia(container) {
    container.querySelectorAll("audio,video").forEach((media) => {
      media.pause();
      media.removeAttribute("src");
      media.load();
    });
  }
  function syncMusicUI() {
    const playing = !$("background-music").paused;
    const available = state.musicTracks.length > 0;
    $("music-button").textContent = playing ? "Ⅱ Jeda musik" : "♫ Putar musik";
    $("music-toggle").textContent = musicBusy ? "…" : playing ? "Ⅱ" : "▷";
    $("music-toggle").setAttribute(
      "aria-label",
      playing ? "Jeda musik" : "Putar musik",
    );
    for (const id of ["music-button", "music-toggle"]) {
      $(id).setAttribute("aria-pressed", String(playing));
      $(id).disabled = !available || musicBusy;
    }
    $("music-track").disabled = !available;
    $("music-previous").disabled = state.musicTracks.length < 2;
    $("music-next").disabled = state.musicTracks.length < 2;
  }
  function stopMusic() {
    musicSequence++;
    musicBusy = false;
    $("background-music").pause();
    syncMusicUI();
  }
  function wipeUI() {
    if (local.account) {
      const oldAccount = local.account;
      local
        .purge()
        .catch(() => {})
        .finally(() => {
          if (local.account === oldAccount) local.release();
        });
    }
    state.epoch++;
    state.user = null;
    state.role = null;
    state.settings = null;
    state.memories = [];
    state.galleryOffset = 0;
    state.galleryPage = 0;
    state.more = false;
    galleryGeneration++;
    pendingBuckets.clear();
    state.letters = [];
    state.musicTracks = [];
    state.musicTrackId = null;
    $("music-track").replaceChildren(node("option", "", "Belum ada lagu"));
    $("memory-download").removeAttribute("href");
    $("memory-download").hidden = true;
    state.prompt = null;
    state.journalDirty = false;
    state.replyMemory = null;
    state.nextReplyAt = 0;
    state.replyBusy = false;
    currentMemory = null;
    refreshing = false;
    galleryBusy = false;
    musicBusy = false;
    clearTimeout(toastTimer);
    observer?.disconnect();
    downloadQueue = [];
    document
      .querySelectorAll("dialog[open]")
      .forEach((dialog) => dialog.close());
    stopMedia(document);
    for (const cached of objectURLs.values())
      if (cached.url) URL.revokeObjectURL(cached.url);
    objectURLs.clear();
    for (const id of [
      "gallery",
      "bucket-list",
      "journal-history",
      "admin-replies",
      "admin-journals",
      "memory-view-media",
      "memory-view-title",
      "memory-view-caption",
      "letter-view-body",
      "letter-view-title",
      "letter-select",
      "daily-question",
      "reply-context",
    ])
      $(id).replaceChildren();
    all("form").forEach((form) => {
      form.reset();
      clearValidation(form);
    });
    $("viewer-password").type = "password";
    $("toggle-password").textContent = "Lihat";
    $("toggle-password").setAttribute("aria-pressed", "false");
    $("toggle-password").setAttribute("aria-label", "Tampilkan kata sandi");
    all(".form-message").forEach((element) => {
      element.textContent = "";
    });
    $("app-screen").hidden = true;
    $("lock-screen").hidden = false;
    $("admin-open").hidden = true;
    $("lock-button").hidden = true;
    $("sync-indicator").hidden = true;
    $("toast-announcement").textContent = "";
    $("toast").hidden = true;
    $("envelope-button").classList.remove("is-open");
    const clearedText = {
      "couple-names": "Kita berdua",
      "event-name": "HARI YANG DINANTI",
      "relationship-days": "—",
      "relationship-detail": "Tanggal jadian belum diatur.",
      "event-countdown": "Belum ada rencana",
      "event-detail": "Masih banyak hal indah menanti.",
      "letter-teaser": "Surat pertama kita belum ditulis.",
      "bucket-count": "0/0",
      "memory-view-date": "",
      "letter-view-date": "",
      "daily-date": "",
      "reply-cooldown": "",
      "music-note": "",
    };
    Object.entries(clearedText).forEach(([id, text]) => {
      $(id).textContent = text;
    });
    stopMusic();
    document.dispatchEvent(new CustomEvent("cmv:locked"));
  }
  async function lock(force = false) {
    if (
      force !== true &&
      window.VaultFeatures &&
      !(await window.VaultFeatures.canLock())
    )
      return;
    authenticating = true;
    await local.purge().catch(() => {});
    local.release();
    wipeUI();
    if (!db) {
      authenticating = false;
      return;
    }
    try {
      const { error } = await db.auth.signOut({ scope: "local" });
      if (error) throw error;
    } catch {
      // Hilangkan token lokal juga ketika endpoint Auth sedang tidak terjangkau.
      localStorage.removeItem(cfg.SESSION_KEY);
      sessionStorage.removeItem(cfg.SESSION_KEY);
      location.reload();
    } finally {
      authenticating = false;
    }
  }
  async function login(email, password, expectedRole) {
    requireClient();
    if (authenticating) throw new Error("Proses masuk masih berjalan.");
    authenticating = true;
    const epoch = state.epoch;
    try {
      const result = await unwrap(
        db.auth.signInWithPassword({ email: email.trim(), password }),
      );
      if (epoch !== state.epoch) return;
      await enter(result.session, expectedRole);
    } finally {
      authenticating = false;
    }
  }
  async function enter(session, expectedRole) {
    if (!session) return;
    const epoch = state.epoch;
    let context;
    local.use(session.user.id);
    try {
      context = await local.cached("context", () =>
        unwrap(db.rpc("get_context")),
      );
      if (expectedRole && context.role !== expectedRole)
        throw new Error("Akun ini tidak memiliki peran yang sesuai.");
    } catch (error) {
      if (navigator.onLine && !local.networkError(error))
        await db.auth.signOut({ scope: "local" });
      throw error;
    }
    if (epoch !== state.epoch) return;
    state.epoch++;
    state.user = session.user;
    state.role = context.role;
    if (navigator.onLine) syncTime(context.server_time);
    state.nextReplyAt = Date.parse(context.reply_ready_at) || 0;
    $("viewer-password").value = "";
    $("admin-password").value = "";
    if ($("admin-login-dialog").open) $("admin-login-dialog").close();
    $("lock-screen").hidden = true;
    $("app-screen").hidden = false;
    $("admin-open").hidden = false;
    document.querySelectorAll("[data-admin-only]").forEach((el) => {
      el.hidden = state.role !== "admin";
    });
    $("member-role").textContent =
      state.role === "admin"
        ? "Admin · Kita sama-sama bisa menambah cerita."
        : "Pasangan · Ruang ini juga milikmu.";
    $("lock-button").hidden = false;
    $("sync-indicator").hidden = false;
    $("viewer-journal").hidden = false;
    $("reply-panel").hidden = false;
    $("admin-journal-note").hidden = true;
    setupReveals();
    await refresh();
    document.dispatchEvent(new CustomEvent("cmv:ready"));
  }
  async function loadSettings() {
    const epoch = state.epoch;
    const settings = await local.cached("settings", () =>
      unwrap(db.from("app_settings").select("*").eq("id", 1).single()),
    );
    if (!alive(epoch)) return;
    state.settings = settings;
    $("couple-names").textContent = settings.couple_names;
    tick();
  }
  async function refresh() {
    if (!state.user || refreshing) return;
    refreshing = true;
    const epoch = state.epoch;
    message("app-message", "Sedang membuka cerita kita…");
    try {
      const context = await local.cached("context", () =>
        unwrap(db.rpc("get_context")),
      );
      if (!alive(epoch)) return;
      if (context.role !== state.role) {
        await lock(true);
        return;
      }
      if (navigator.onLine) syncTime(context.server_time);
      state.nextReplyAt = Date.parse(context.reply_ready_at) || 0;
      await loadSettings();
      await window.VaultFeatures?.load();
      const tasks = [
        loadGallery(),
        loadBuckets(),
        loadLetters(),
        loadDaily(),
        loadMusicTracks(),
      ];
      const results = await Promise.allSettled(tasks);
      if (!alive(epoch)) return;
      const failed = results.find((result) => result.status === "rejected");
      message(
        "app-message",
        failed
          ? `Sebagian cerita belum termuat. ${errorText(failed.reason)}`
          : "",
        Boolean(failed),
      );
    } catch (error) {
      if (error.code === "42501") {
        await lock(true);
        message("login-message", errorText(error), true);
      } else if (alive(epoch)) message("app-message", errorText(error), true);
    } finally {
      if (alive(epoch)) refreshing = false;
    }
  }
  async function mediaURL(path) {
    if (!state.user) throw new Error("Silakan masuk dahulu.");
    if (objectURLs.has(path)) return objectURLs.get(path).promise;
    const epoch = state.epoch;
    const cached = {};
    cached.promise = (async () => {
      // Authenticated download + RLS, bukan public URL / signed URL yang bisa dibagikan.
      const blob = await local.media(path, () =>
        unwrap(db.storage.from(cfg.BUCKET).download(path)),
      );
      if (!alive(epoch) || objectURLs.get(path) !== cached)
        throw new Error("Media tidak lagi diperlukan.");
      cached.url = URL.createObjectURL(blob);
      return cached.url;
    })().catch((error) => {
      if (objectURLs.get(path) === cached) objectURLs.delete(path);
      throw error;
    });
    objectURLs.set(path, cached);
    return cached.promise;
  }
  function pruneMediaURLs() {
    const used = new Set(state.memories.filter((m) => !m.is_locked && m.media_kind === "image")
      .map((m) => m.preview_path || m.media_path));
    if (currentMemory) used.add(currentMemory.media_path);
    const track = state.musicTracks.find((t) => t.id === state.musicTrackId);
    if (track) used.add(track.media_path);
    for (const [path, cached] of objectURLs) {
      if (used.has(path)) continue;
      if (cached.url) URL.revokeObjectURL(cached.url);
      objectURLs.delete(path);
    }
  }
  function queuePhoto(visual, memory) {
    if (!visual.isConnected || visual.dataset.queued || visual.classList.contains("has-photo")) return;
    visual.dataset.queued = "true";
    downloadQueue.push({ visual, memory, epoch: state.epoch, generation: galleryGeneration });
    pumpPhotos();
  }
  function pumpPhotos() {
    while (activeDownloads < 3 && downloadQueue.length) {
      const task = downloadQueue.shift();
      if (!alive(task.epoch) || task.generation !== galleryGeneration) continue;
      if (!task.visual.isConnected) {
        delete task.visual.dataset.queued;
        observer?.observe(task.visual);
        continue;
      }
      activeDownloads++;
      mediaURL(task.memory.preview_path || task.memory.media_path)
        .then((url) => {
          if (!alive(task.epoch) || task.generation !== galleryGeneration) return;
          const img = node("img");
          img.alt = task.memory.title;
          img.loading = "lazy";
          img.decoding = "async";
          img.fetchPriority = "low";
          img.addEventListener("error", () => {
            img.remove();
            task.visual.classList.remove("has-photo");
            task.visual.append(node("span", "loading-placeholder", "Pratinjau tidak tersedia. Ketuk untuk membuka."));
          });
          img.src = url;
          task.visual.querySelector(".loading-placeholder")?.remove();
          task.visual.classList.add("has-photo");
          task.visual.prepend(img);
        })
        .catch(() => {
          if (alive(task.epoch) && task.generation === galleryGeneration) {
            const label = task.visual.querySelector(".loading-placeholder");
            if (label) label.textContent = "Belum termuat. Ketuk untuk mencoba lagi.";
          }
        })
        .finally(() => {
          activeDownloads--;
          pumpPhotos();
        });
    }
  }
  function observeGalleryPhotos() {
    if (!observer && "IntersectionObserver" in window)
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.target.isConnected) {
            observer.unobserve(entry.target);
            queuePhoto(entry.target, entry.target._memory);
          }
        }
      }, { rootMargin: "160px 0px" });
    $("gallery").querySelectorAll(".memory-visual").forEach((visual) => {
      if (!visual._memory || visual.dataset.queued || visual.classList.contains("has-photo")) return;
      if (observer) observer.observe(visual);
      else if (visual.isConnected) {
        const box = visual.getBoundingClientRect();
        if (box.bottom >= -160 && box.top <= innerHeight + 160) queuePhoto(visual, visual._memory);
      }
    });
  }
  function schedulePhotoCheck() {
    if (observer || photoFrame) return;
    photoFrame = requestAnimationFrame(() => {
      photoFrame = 0;
      observeGalleryPhotos();
    });
  }
  function memoryCard(memory) {
    const card = node(
      "article",
      `memory-card${memory.is_locked ? " capsule" : ""}`,
    );
    card.dataset.memoryId = memory.id;
    const visual = node("div", "memory-visual");
    const copy = node("div", "memory-copy");
    if (memory.is_locked) {
      visual.append(node("span", "capsule-icon"));
      visual.setAttribute("aria-hidden", "true");
      copy.append(
        node("h3", "", "Sebuah cerita untuk nanti"),
        node("p", "", `Terkunci sampai ${formatDate(memory.unlock_at, true)}`),
      );
      card.append(visual, copy);
      return card;
    }
    const button = node("button", "memory-open");
    button.type = "button";
    button.setAttribute("aria-label", `Buka kenangan: ${memory.title}`);
    const names = { image: "Foto", video: "Video", audio: "Audio" };
    if (memory.media_kind === "image") {
      visual.append(node("span", "loading-placeholder", "Memuat foto…"));
      visual._memory = memory;
    } else
      visual.append(
        node("span", "media-symbol", memory.media_kind === "video" ? "▷" : "♫"),
      );
    visual.append(
      node("span", "media-kind", names[memory.media_kind] || "Kenangan"),
    );
    copy.append(node("h3", "", memory.title), node("p", "", memory.caption));
    const time = node("time", "", formatDate(memory.occurred_on));
    time.dateTime = memory.occurred_on;
    copy.append(time);
    if (memory.unlock_at && Date.parse(memory.unlock_at) > now())
      copy.append(
        node("span", "capsule-note", "Kapsul · belum waktunya dibuka"),
      );
    button.append(visual, copy);
    card.append(button);
    if (window.VaultFeatures)
      card.append(window.VaultFeatures.reactionBar("memory", memory.id));
    button.addEventListener("click", () => openMemory(memory));
    return card;
  }
  async function loadGallery(reset = false, options = {}) {
    if (galleryBusy || !state.user) return;
    galleryBusy = true;
    const epoch = state.epoch;
    let page = reset ? 0 : Math.max(0, options.page ?? state.galleryPage);
    const gallery = $("gallery");
    const next = $("load-more"), previous = $("gallery-previous");
    next.disabled = previous.disabled = true;
    gallery.setAttribute("aria-busy", "true");
    $("gallery-status").textContent = "Membuka halaman kenangan…";
    try {
      let rows, reachedEnd = false;
      // If deletions empty the last page, walk back to the nearest available page.
      do {
        const offset = page * GALLERY_PAGE_SIZE;
        rows = await local.cached(`gallery:${offset}`, () => unwrap(
          db.rpc("list_memories", { p_offset: offset, p_limit: GALLERY_PAGE_SIZE }),
        ));
        if (!alive(epoch)) return;
        if (!rows.length && page > 0) { reachedEnd = true; page--; }
        else break;
      } while (true);
      rows = rows.slice(0, GALLERY_PAGE_SIZE);
      const changed = page !== state.galleryPage || JSON.stringify(rows) !== JSON.stringify(state.memories);
      state.galleryPage = page;
      state.galleryOffset = page * GALLERY_PAGE_SIZE + rows.length;
      state.more = !reachedEnd && rows.length === GALLERY_PAGE_SIZE;
      if (changed || reset || !gallery.children.length) {
        const focusedId = gallery.contains(document.activeElement)
          ? document.activeElement.closest("[data-memory-id]")?.dataset.memoryId : null;
        galleryGeneration++;
        observer?.disconnect();
        downloadQueue = [];
        state.memories = rows;
        gallery.replaceChildren(...rows.map(memoryCard));
        pruneMediaURLs();
        if (focusedId && !options.focus)
          gallery.querySelector(`[data-memory-id="${CSS.escape(focusedId)}"] .memory-open`)?.focus({ preventScroll: true });
      }
      $("gallery-empty").hidden = rows.length > 0;
      $("gallery-page").textContent = `Halaman ${page + 1}`;
      $("gallery-status").textContent = rows.length
        ? `Kenangan ${page * GALLERY_PAGE_SIZE + 1}–${state.galleryOffset}${state.more ? "" : " · halaman terakhir"}.`
        : "Belum ada kenangan tersimpan.";
      if (options.focus && gallery.isConnected) {
        const heading = $("gallery-heading");
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
        heading.scrollIntoView({ block: "start", behavior: "instant" });
      }
      observeGalleryPhotos();
    } catch (error) {
      if (alive(epoch)) $("gallery-status").textContent = errorText(error);
      throw error;
    } finally {
      if (alive(epoch)) {
        galleryBusy = false;
        next.disabled = !state.more;
        previous.disabled = state.galleryPage === 0;
        gallery.removeAttribute("aria-busy");
      }
    }
  }
  function setView(view) {
    state.view = view;
    $("gallery").className = `gallery ${view}`;
    $("masonry-button").setAttribute(
      "aria-pressed",
      String(view === "masonry"),
    );
    $("timeline-button").setAttribute(
      "aria-pressed",
      String(view === "timeline"),
    );
    try {
      localStorage.setItem("cmv-gallery-view", view);
      observeGalleryPhotos();
    } catch {
      /* Pilihan tampilan tidak wajib tersimpan. */
    }
  }
  async function openMemory(memory, immersive = false) {
    if (memory.is_locked || !state.user) return;
    memoryOpener = document.activeElement;
    const epoch = state.epoch;
    stopMusic();
    stopMedia($("memory-view-media"));
    currentMemory = memory;
    $("memory-location").onclick = () =>
      window.VaultFeatures.openLocation(memory);
    $("memory-view-title").textContent = memory.title;
    $("memory-view-caption").textContent = memory.caption;
    $("memory-view-date").textContent = formatDate(memory.occurred_on);
    $("memory-view-media").replaceChildren(
      node("p", "loading-placeholder", "Membuka kenangan…"),
    );
    $("memory-reply").hidden = false;
    $("memory-download").hidden = true;
    $("memory-download").removeAttribute("href");
    $("memory-dialog").classList.toggle("immersive", immersive);
    if (!$("memory-dialog").open) $("memory-dialog").showModal();
    try {
      const url = await mediaURL(memory.media_path);
      if (
        !alive(epoch) ||
        !$("memory-dialog").open ||
        currentMemory?.id !== memory.id
      )
        return;
      const media = node(
        memory.media_kind === "image"
          ? "img"
          : memory.media_kind === "video"
            ? "video"
            : "audio",
      );
      if (memory.media_kind === "image") {
        media.alt = memory.title;
        media.loading = "lazy";
        media.decoding = "async";
      }
      else {
        media.controls = true;
        media.setAttribute("aria-label", `Putar ${memory.media_kind === "video" ? "video" : "audio"}: ${memory.title}`);
        media.preload = "none";
        media.setAttribute("playsinline", "");
      }
      media.src = url;
      $("memory-download").href = url;
      $("memory-download").download = memory.media_path.split("/").pop();
      $("memory-download").hidden = false;
      media.addEventListener("error", () => {
        if (alive(epoch))
          $("memory-view-media").replaceChildren(
            node(
              "p",
              "loading-placeholder",
              "Media tidak dapat diputar. Coba format JPG, MP4 H.264, atau MP3.",
            ),
          );
      });
      $("memory-view-media").replaceChildren(media);
    } catch (error) {
      if (alive(epoch) && currentMemory?.id === memory.id)
        $("memory-view-media").replaceChildren(
          node("p", "loading-placeholder", errorText(error)),
        );
    }
  }
  async function loadBuckets() {
    const epoch = state.epoch;
    const rows = await readAll("bucket_list", "*");
    if (!alive(epoch)) return;
    const focusedId = $("bucket-list").contains(document.activeElement) ? document.activeElement.id : null;
    $("bucket-list").replaceChildren();
    $("bucket-empty").hidden = rows.length > 0;
    $("bucket-count").textContent = `${rows.filter((row) => row.is_completed).length}/${rows.length}`;
    rows.forEach((item) => {
      const li = node("li"), label = node("label"), input = node("input");
      input.type = "checkbox";
      input.id = `bucket-${item.id}`;
      input.name = "completed";
      input.setAttribute("aria-describedby", "bucket-help");
      input.setAttribute("aria-disabled", String(!navigator.onLine || pendingBuckets.has(item.id)));
      input.checked = pendingBuckets.get(item.id) ?? item.is_completed;
      label.htmlFor = input.id;
      label.append(input, node("span", "", item.title));
      li.append(label);
      if (item.completed_at) li.append(node("small", "", `Terwujud ${formatDate(item.completed_at)}`));
      input.addEventListener("click", (event) => {
        if (!navigator.onLine || pendingBuckets.has(item.id)) {
          event.preventDefault();
          if (!navigator.onLine) toast("Sambungkan internet untuk menandai impian. Kamu tetap bisa membacanya.");
        }
      });
      input.addEventListener("change", async () => {
        const requested = input.checked;
        pendingBuckets.set(item.id, requested);
        input.setAttribute("aria-disabled", "true");
        try {
          await unwrap(db.rpc("set_bucket_completed", { p_id: item.id, p_completed: requested }));
          if (!alive(epoch)) return;
          pendingBuckets.delete(item.id);
          await loadBuckets();
          toast(requested ? "Satu mimpi lagi jadi nyata. ♡" : "Impian ini kembali kita nantikan.");
        } catch (error) {
          if (alive(epoch)) {
            const current = $(input.id);
            if (current) current.checked = item.is_completed;
            toast(errorText(error));
          }
        } finally {
          if (alive(epoch)) {
            pendingBuckets.delete(item.id);
            $(input.id)?.setAttribute("aria-disabled", String(!navigator.onLine));
          }
        }
      });
      $("bucket-list").append(li);
    });
    if (focusedId) $(focusedId)?.focus({ preventScroll: true });
  }
  async function loadLetters() {
    const epoch = state.epoch;
    const old = await readAll("love_letters", "*");
    const rows = [
      ...old,
      ...(window.VaultFeatures?.entries || []).filter(
        (e) => e.kind === "letter",
      ),
    ].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    if (!alive(epoch)) return;
    const previous = $("letter-select").value;
    state.letters = rows;
    $("letter-select").replaceChildren(
      ...rows.map((letter) => {
        const option = node(
          "option",
          "",
          letter.is_locked
            ? `🔒 Buka ${formatDate(letter.unlock_at, true)}`
            : letter.title,
        );
        option.value = letter.id;
        return option;
      }),
    );
    if (rows.some((letter) => letter.id === previous))
      $("letter-select").value = previous;
    $("envelope-button").disabled = rows.length === 0;
    $("letter-select").hidden = rows.length <= 1;
    $("letter-select-label").hidden = rows.length <= 1;
    $("letter-teaser").textContent = rows.length
      ? "Ketuk amplopnya. Ada sesuatu yang ingin kusampaikan."
      : "Surat pertama kita belum ditulis.";
  }
  async function openLetter() {
    if (
      !$("letter-select").value ||
      $("envelope-button").classList.contains("is-open")
    )
      return;
    const epoch = state.epoch;
    $("envelope-button").classList.add("is-open");
    try {
      const [letter] = await Promise.all([
        Promise.resolve(
          state.letters.find((e) => e.id === $("letter-select").value),
        ),
        new Promise((resolve) => {
          envelopeTimer = setTimeout(
            resolve,
            matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 700,
          );
        }),
      ]);
      if (!alive(epoch)) return;
      if (!letter) throw new Error("Surat belum tersedia. Muat ulang dahulu.");
      if (letter.is_locked) {
        toast(
          `Kapsul masih terkunci sampai ${formatDate(letter.unlock_at, true)}. Sambungkan internet saat waktunya tiba.`,
        );
        return;
      }
      $("letter-reactions").replaceChildren(
        window.VaultFeatures.reactionBar(
          letter.kind ? "entry" : "letter",
          letter.id,
        ),
      );
      $("letter-view-title").textContent = letter.title;
      $("letter-view-date").textContent = formatDate(letter.created_at);
      $("letter-view-body").textContent = letter.body;
      $("letter-dialog").showModal();
    } catch (error) {
      if (alive(epoch)) toast(errorText(error));
    } finally {
      if (alive(epoch)) $("envelope-button").classList.remove("is-open");
    }
  }
  async function loadDaily() {
    const epoch = state.epoch;
    let prompt = await local.cached("daily-prompt", () =>
      unwrap(db.rpc("get_daily_prompt")),
    );
    const today = window.VaultFeatures?.today();
    if (today && prompt.date !== today)
      prompt = {
        date: today,
        question: "Hal kecil apa yang ingin kamu ingat hari ini?",
        answer: "",
      };
    if (!alive(epoch)) return;
    const restored = window.VaultFeatures?.journalDraft;
    if (restored) prompt = { ...prompt, ...restored };
    if (state.prompt && state.prompt.date !== prompt.date && state.journalDirty)
      message(
        "journal-message",
        "Pertanyaan sudah berganti. Tinjau jawabanmu sebelum menyimpan.",
      );
    state.prompt = prompt;
    $("daily-question").textContent = prompt.question;
    $("daily-date").textContent = formatDate(prompt.date);
    // Draf tidak ditimpa ketika arsip dimuat ulang.
    if (!state.journalDirty && !$("journal-answer").value)
      $("journal-answer").value = "";
    const old = await local.cached("journal-history", () =>
      unwrap(
        db
          .from("daily_journals")
          .select("id,author_id,journal_date,question,answer")
          .order("journal_date", { ascending: false })
          .limit(30),
      ),
    );
    const rows = [
      ...old,
      ...(window.VaultFeatures?.entries || [])
        .filter((e) => e.kind === "journal")
        .map((e) => ({
          ...e,
          journal_date: e.occurred_on,
          question: e.title,
          answer: e.body,
        })),
    ].sort((a, b) =>
      String(b.journal_date).localeCompare(String(a.journal_date)),
    );
    if (!alive(epoch)) return;
    $("journal-history").replaceChildren(
      ...rows.map((entry) => {
        const article = node("article", "inbox-item");
        article.append(
          node(
            "time",
            "",
            `${formatDate(entry.journal_date)} · ${entry.author_id === state.user.id ? "Darimu" : "Dari pasanganmu"}`,
          ),
          node("h4", "", entry.question),
          node(
            "p",
            "preserve-lines",
            entry.is_locked
              ? `🔒 Terkunci sampai ${formatDate(entry.unlock_at, true)}. Buka saat online setelah waktunya tiba.`
              : entry.answer,
          ),
        );
        if (!entry.is_locked && window.VaultFeatures)
          article.append(
            window.VaultFeatures.reactionBar(
              entry.kind ? "entry" : "journal",
              entry.id,
            ),
          );
        return article;
      }),
    );
    if (!rows.length)
      $("journal-history").append(
        node("p", "tiny muted", "Cerita kita akan terkumpul di sini."),
      );
  }
  function tick() {
    if (!state.user) return;
    const settings = state.settings;
    if (settings?.relationship_started_at) {
      const delta = now() - Date.parse(settings.relationship_started_at);
      if (delta < 0) {
        $("relationship-days").textContent = "Segera dimulai";
        $("relationship-detail").textContent = formatDate(
          settings.relationship_started_at,
        );
      } else {
        const seconds = Math.floor(delta / 1000);
        $("relationship-days").textContent =
          `${Math.floor(seconds / 86400).toLocaleString("id-ID")} hari`;
        $("relationship-detail").textContent =
          `${Math.floor(seconds / 3600) % 24} jam · ${Math.floor(seconds / 60) % 60} menit · ${seconds % 60} detik`;
      }
    } else {
      $("relationship-days").textContent = "—";
      $("relationship-detail").textContent = "Tanggal jadian belum diatur.";
    }
    pages.query(".legacy-event").hidden = !settings?.event_at;
    $("event-name").textContent = settings?.event_name || "HARI YANG DINANTI";
    if (settings?.event_at) {
      const remaining = Math.max(
        0,
        Math.ceil((Date.parse(settings.event_at) - now()) / 1000),
      );
      $("event-countdown").textContent = remaining
        ? `${Math.floor(remaining / 86400)} hari lagi`
        : "Waktunya tiba!";
      $("event-detail").textContent = remaining
        ? `${Math.floor(remaining / 3600) % 24} jam · ${Math.floor(remaining / 60) % 60} menit · ${remaining % 60} detik`
        : formatDate(settings.event_at, true);
    } else {
      $("event-countdown").textContent = "Belum ada rencana";
      $("event-detail").textContent = "Masih banyak hal indah menanti.";
    }
    if (!navigator.onLine) $("reply-submit").disabled = true;
    const wait = Math.max(0, Math.ceil((state.nextReplyAt - now()) / 1000));
    $("reply-submit").disabled =
      wait > 0 || state.replyBusy || !navigator.onLine;
    $("reply-cooldown").textContent = wait
      ? `Pesan berikutnya bisa dikirim dalam ${wait} detik.`
      : "Satu pesan setiap 30 detik, supaya tiap kata punya ruang.";
  }
  function replyContext(memory) {
    state.replyMemory = memory?.id || null;
    $("reply-context").textContent = memory
      ? `Untuk kenangan: ${memory.title}`
      : "";
    $("reply-context").hidden = !memory;
    $("clear-reply-context").hidden = !memory;
  }
  async function loadMusicTracks() {
    const epoch = state.epoch;
    const rows = await readAll(
      "memories",
      "id,title,media_kind,media_path,unlock_at,created_at",
    );
    if (!alive(epoch)) return;
    state.musicTracks = rows.filter(
      (m) =>
        m.media_kind === "audio" &&
        (!m.unlock_at || Date.parse(m.unlock_at) <= now()),
    );
    const tracks = state.musicTracks;
    if (!tracks.some((track) => track.id === state.musicTrackId)) {
      stopMusic();
      $("background-music").removeAttribute("src");
      state.musicTrackId =
        tracks.find((t) => t.id === state.settings?.music_memory_id)?.id ||
        tracks[0]?.id ||
        null;
    }
    $("music-track").replaceChildren(
      ...(tracks.length
        ? tracks.map((track) => {
            const option = node("option", "", track.title);
            option.value = track.id;
            return option;
          })
        : [node("option", "", "Belum ada lagu")]),
    );
    $("music-track").value = state.musicTrackId || "";
    $("music-note").textContent = tracks.length
      ? "Pilih lagu, lalu tekan putar. Musik menemani dengan pelan."
      : "Ketuk tombol + di kanan bawah untuk menambahkan lagu kita.";
    syncMusicUI();
  }
  async function playMusic() {
    const audio = $("background-music");
    if (!audio.paused) {
      stopMusic();
      return;
    }
    const track = state.musicTracks.find((t) => t.id === state.musicTrackId);
    if (musicBusy || !track || !state.user) return;
    const epoch = state.epoch,
      sequence = ++musicSequence;
    musicBusy = true;
    syncMusicUI();
    try {
      if (!audio.getAttribute("src")) {
        const url = await mediaURL(track.media_path);
        if (!alive(epoch) || sequence !== musicSequence) return;
        audio.src = url;
      }
      audio.volume = Number($("music-volume").value);
      await audio.play();
      if (!alive(epoch) || sequence !== musicSequence) return;
    } catch (error) {
      if (alive(epoch) && sequence === musicSequence)
        toast(
          error.name === "NotAllowedError"
            ? "Browser meminta satu ketukan lagi. Tekan putar untuk memulai musik."
            : "Lagu belum bisa diputar. Coba lagi atau pilih file MP3/M4A.",
        );
    } finally {
      if (sequence === musicSequence) {
        musicBusy = false;
        syncMusicUI();
      }
    }
  }
  function selectMusic(id, shouldPlay = !$("background-music").paused) {
    if (!state.musicTracks.some((track) => track.id === id)) return;
    stopMusic();
    const audio = $("background-music");
    audio.removeAttribute("src");
    audio.load();
    state.musicTrackId = id;
    $("music-track").value = id;
    if (shouldPlay) playMusic();
  }
  function stepMusic(direction, shouldPlay) {
    const tracks = state.musicTracks;
    if (!tracks.length) return;
    const index = tracks.findIndex((track) => track.id === state.musicTrackId);
    selectMusic(
      tracks[(index + direction + tracks.length) % tracks.length].id,
      shouldPlay,
    );
  }
  function setupReveals() {
    if (
      !("IntersectionObserver" in window) ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const reveal = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.remove("reveal-waiting");
            reveal.unobserve(entry.target);
          }
        }),
      { threshold: 0.08 },
    );
    document.querySelectorAll("#app-screen .panel").forEach((panel) => {
      panel.classList.add("reveal-waiting");
      reveal.observe(panel);
    });
  }
  async function setupPWA() {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    try {
      const registration = await navigator.serviceWorker.register(
        new URL("sw.js", pages.base),
        {
          updateViaCache: "none",
        },
      );
      const readyToUpdate = () => {
        const previousWorker = waitingWorker;
        waitingWorker = registration.waiting;
        if (waitingWorker && navigator.serviceWorker.controller) {
          $("update-banner").hidden = false;
          if (state.user && previousWorker !== waitingWorker)
            toast("Versi baru siap. Buka ikon awan untuk memperbarui setelah menyimpan tulisanmu.");
        }
      };
      readyToUpdate();
      registration.addEventListener("updatefound", () => {
        registration.installing?.addEventListener("statechange", readyToUpdate);
      });
      let reloading = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!waitingWorker || reloading) return;
        reloading = true;
        location.reload();
      });
    } catch {
      /* Website tetap berjalan apabila browser tidak mendukung pemasangan. */
    }
  }

  // Modul UI bersama. Semua izin tetap diperiksa oleh RLS di server.
  window.Vault = {
    db,
    cfg,
    local,
    state,
    $,
    all,
    now,
    alive,
    node,
    unwrap,
    readAll,
    message,
    toast,
    errorText,
    formatDate,
    localInput,
    formAction,
    validateForm,
    clearValidation,
    syncTime,
    openMemory,
    loadDaily,
    login,
    refresh,
    loadBuckets,
    loadLetters,
    loadSettings,
    loadMusicTracks,
    stopMedia,
  };

  document
    .querySelectorAll("[data-close]")
    .forEach((button) =>
      button.addEventListener("click", () => $(button.dataset.close).close()),
    );
  $("memory-dialog").addEventListener("close", () => {
    stopMedia($("memory-view-media"));
    $("memory-view-media").replaceChildren();
    const card = document.querySelector(
      `[data-memory-id="${CSS.escape(currentMemory?.id || "")}"] .memory-open`,
    );
    currentMemory = null;
    pruneMediaURLs();
    if (state.user)
      (memoryOpener?.isConnected
        ? memoryOpener
        : card || document.querySelector('.section-nav [aria-current="page"]')
      )?.focus({ preventScroll: true });
    memoryOpener = null;
  });
  let taps = [];
  document.querySelectorAll("[data-admin-unlock]").forEach((button) =>
    button.addEventListener("click", () => {
      const current = performance.now();
      taps = taps.filter((time) => current - time < 900);
      taps.push(current);
      if (taps.length >= 3) {
        taps = [];
        if (state.user) $("admin-open").click();
        else {
          message("admin-login-message");
          $("admin-login-dialog").showModal();
        }
      }
    }),
  );
  $("email-login-open").addEventListener("click", () => {
    message("admin-login-message");
    $("admin-login-dialog").showModal();
  });
  $("viewer-login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const password = $("viewer-password").value;
    formAction(event.currentTarget, "login-message", async () => {
      await login(cfg.VIEWER_EMAIL, password, "viewer");
      message("login-message");
    });
  });
  $("toggle-password").addEventListener("click", () => {
    const show = $("viewer-password").type === "password";
    $("viewer-password").type = show ? "text" : "password";
    $("toggle-password").textContent = show ? "Sembunyikan" : "Lihat";
    $("toggle-password").setAttribute("aria-pressed", String(show));
    $("toggle-password").setAttribute(
      "aria-label",
      show ? "Sembunyikan kata sandi" : "Tampilkan kata sandi",
    );
  });
  $("lock-button").addEventListener("click", lock);
  $("refresh-button").addEventListener("click", refresh);
  $("load-more").addEventListener("click", () =>
    loadGallery(false, { page: state.galleryPage + 1, focus: true }).catch((error) => toast(errorText(error))),
  );
  $("gallery-previous").addEventListener("click", () =>
    loadGallery(false, { page: state.galleryPage - 1, focus: true }).catch((error) => toast(errorText(error))),
  );
  document.addEventListener("cmv:page", observeGalleryPhotos);
  window.addEventListener("scroll", schedulePhotoCheck, { passive: true });
  window.addEventListener("resize", schedulePhotoCheck, { passive: true });
  $("masonry-button").addEventListener("click", () => setView("masonry"));
  $("timeline-button").addEventListener("click", () => setView("timeline"));
  $("surprise-button").addEventListener("click", async () => {
    const epoch = state.epoch;
    $("surprise-button").disabled = true;
    try {
      const rows = navigator.onLine
        ? await unwrap(db.rpc("random_memory"))
        : state.memories
            .filter((m) => !m.is_locked)
            .sort(() => Math.random() - 0.5)
            .slice(0, 1);
      if (!alive(epoch)) return;
      if (rows.length) await openMemory(rows[0], true);
      else toast("Belum ada kenangan terbuka untuk kejutan hari ini.");
    } catch (error) {
      if (alive(epoch)) toast(errorText(error));
    } finally {
      $("surprise-button").disabled = false;
    }
  });
  $("envelope-button").addEventListener("click", openLetter);
  $("journal-answer").addEventListener("input", () => {
    state.journalDirty = true;
  });
  $("journal-form").addEventListener("submit", (event) => {
    event.preventDefault();
    formAction(event.currentTarget, "journal-message", async () => {
      await window.VaultFeatures.saveEntry("journal");
    });
  });
  $("memory-reply").addEventListener("click", async () => {
    replyContext(currentMemory);
    $("memory-dialog").close();
    await pages.navigate("surat", { focusId: "reply-body" });
  });
  $("clear-reply-context").addEventListener("click", () => replyContext(null));
  $("reply-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.replyBusy || state.nextReplyAt > now()) return;
    const epoch = state.epoch,
      body = $("reply-body").value.trim(),
      memoryId = state.replyMemory;
    state.replyBusy = true;
    tick();
    await formAction(event.currentTarget, "reply-message", async () => {
      try {
        const data = await unwrap(
          db.rpc("send_reply", { p_body: body, p_memory_id: memoryId }),
        );
        if (!alive(epoch)) return;
        syncTime(data.server_time);
        state.nextReplyAt = Date.parse(data.next_allowed_at);
        $("reply-body").value = "";
        replyContext(null);
        message("reply-message", "Pesanmu sudah dititipkan. ♡");
      } catch (error) {
        // Sinkronkan cooldown sesudah refresh / pesan dari perangkat lain.
        if (/COOLDOWN/.test(error.message)) {
          const context = await unwrap(db.rpc("get_context"));
          if (alive(epoch)) {
            if (navigator.onLine) syncTime(context.server_time);
            state.nextReplyAt = Date.parse(context.reply_ready_at) || 0;
          }
        }
        throw error;
      }
    });
    if (alive(epoch)) {
      state.replyBusy = false;
      tick();
    }
  });
  $("music-button").addEventListener("click", playMusic);
  $("music-toggle").addEventListener("click", playMusic);
  $("music-track").addEventListener("change", (event) =>
    selectMusic(event.target.value),
  );
  $("music-previous").addEventListener("click", () => stepMusic(-1));
  $("music-next").addEventListener("click", () => stepMusic(1));
  $("background-music").addEventListener("ended", () => stepMusic(1, true));
  $("background-music").addEventListener("pause", syncMusicUI);
  $("background-music").addEventListener("playing", syncMusicUI);
  $("background-music").addEventListener("error", stopMusic);
  $("music-volume").addEventListener("input", (event) => {
    const value = Number(event.target.value);
    $("background-music").volume = value;
    $("music-volume-value").textContent = `${Math.round(value * 100)}%`;
    if (Math.abs($("background-music").volume - value) > 0.01)
      $("music-note").textContent =
        "Di perangkat ini, gunakan tombol volume HP untuk mengatur suara.";
  });
  // The router owns aria-current and keeps the audio element outside page swaps.
  document.addEventListener("cmv:page", setupReveals);
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    $("install-button").hidden = false;
  });
  $("install-button").addEventListener("click", async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $("install-button").hidden = true;
  });
  window.addEventListener("appinstalled", () => {
    $("install-button").hidden = true;
    $("install-help").hidden = true;
  });
  $("update-button").addEventListener("click", () => {
    if (
      window.VaultFeatures?.unsaved ||
      pages.query("form[data-busy]") ||
      $("admin-dialog").open
    ) {
      toast("Simpan pekerjaanmu dan tutup ruang bersama sebelum memuat ulang.");
      return;
    }
    waitingWorker?.postMessage({ type: "ACTIVATE_UPDATE" });
  });
  window.addEventListener("offline", () => {
    window.VaultFeatures?.status();
    $("bucket-list").querySelectorAll("input").forEach((input) => input.setAttribute("aria-disabled", "true"));
  });
  window.addEventListener("online", () => {
    window.VaultFeatures?.status();
    $("bucket-list").querySelectorAll("input").forEach((input) => input.setAttribute("aria-disabled", "false"));
    if (state.user) window.VaultFeatures?.sync().then(refresh);
    else message("login-message", "Koneksi kembali. Silakan masuk.");
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.user && navigator.onLine) refresh();
  });
  window.addEventListener("pagehide", () => stopMusic());
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && state.user) refresh();
  });
  window.addEventListener("beforeunload", (event) => {
    if (window.VaultFeatures?.unsaved || pages.query("form[data-busy]")) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  setInterval(tick, 1000);
  setInterval(() => {
    if (
      state.user &&
      navigator.onLine &&
      !document.hidden &&
      !pages.query("form[data-busy]")
    )
      refresh();
  }, 60000);
  try {
    if (localStorage.getItem("cmv-gallery-view") === "timeline")
      setView("timeline");
  } catch {
    /* Opsional. */
  }
  $("sync-indicator").addEventListener("click", () => {
    $("sync-dialog").showModal();
    window.VaultFeatures?.status();
  });
  navigator.serviceWorker?.addEventListener("message", (event) => {
    if (event.data?.type === "SHELL_READY" && state.user)
      toast("Aplikasi siap dibuka luring. Kenangan yang sudah dimuat dapat dibaca kembali.");
  });
  setupPWA();
  if (!db) message("login-message", window.vaultConfigError, true);
  else {
    // Callback auth harus sinkron; query Supabase dijalankan di luar callback.
    db.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") wipeUI();
    });
    const resume = async () => {
      try {
        let session;
        if (navigator.onLine) {
          const { data, error } = await db.auth.getSession();
          if (error) throw error;
          session = data.session;
        } else {
          session = JSON.parse(localStorage.getItem(cfg.SESSION_KEY) || "null");
        }
        if (session?.user && !state.user && !authenticating)
          await enter(session);
      } catch (error) {
        message("login-message", errorText(error), true);
      }
    };
    // Tunggu fitur dan formulir terpasang sebelum memulihkan akun luring.
    document.addEventListener("cmv:booted", resume, { once: true });
  }
})();