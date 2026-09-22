/* Vanilla JS. Semua aturan otorisasi tetap diperiksa ulang oleh Supabase. */
(() => {
  "use strict";
  const db = window.vaultClient;
  const cfg = window.VAULT_CONFIG;
  const $ = (id) => document.getElementById(id);
  const state = {
    user: null,
    role: null,
    epoch: 0,
    settings: null,
    memories: [],
    letters: [],
    more: false,
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
  let toastTimer,
    envelopeTimer,
    refreshing = false,
    galleryBusy = false;
  let authenticating = false,
    currentMemory = null,
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
  function toast(text) {
    clearTimeout(toastTimer);
    $("toast").textContent = text;
    $("toast").hidden = false;
    toastTimer = setTimeout(() => {
      $("toast").hidden = true;
    }, 4500);
  }
  function errorText(error) {
    const raw = String(error?.message || error || "Terjadi kesalahan.");
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
      return "Konfigurasi database belum lengkap. Jalankan setup.sql dahulu.";
    if (/COOLDOWN:/.test(raw)) return raw.replace("COOLDOWN: ", "");
    return raw;
  }
  async function unwrap(query) {
    const { data, error } = await query;
    if (error) throw error;
    return data;
  }
  async function readAll(table, fields, order = "created_at") {
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
  async function formAction(form, messageId, action) {
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
    state.epoch++;
    state.user = null;
    state.role = null;
    state.settings = null;
    state.memories = [];
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
    document.querySelectorAll("form").forEach((form) => form.reset());
    $("viewer-password").type = "password";
    $("toggle-password").textContent = "Lihat";
    $("toggle-password").setAttribute("aria-pressed", "false");
    $("toggle-password").setAttribute("aria-label", "Tampilkan kata sandi");
    document.querySelectorAll(".form-message").forEach((element) => {
      element.textContent = "";
    });
    $("app-screen").hidden = true;
    $("lock-screen").hidden = false;
    $("admin-open").hidden = true;
    $("lock-button").hidden = true;
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
  async function lock() {
    authenticating = true;
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
    try {
      context = await unwrap(db.rpc("get_context"));
      if (expectedRole && context.role !== expectedRole)
        throw new Error("Akun ini tidak memiliki peran yang sesuai.");
    } catch (error) {
      await db.auth.signOut({ scope: "local" });
      throw error;
    }
    if (epoch !== state.epoch) return;
    state.epoch++;
    state.user = session.user;
    state.role = context.role;
    syncTime(context.server_time);
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
    $("viewer-journal").hidden = false;
    $("reply-panel").hidden = false;
    $("admin-journal-note").hidden = true;
    setupReveals();
    await refresh();
    document.dispatchEvent(new CustomEvent("cmv:ready"));
  }
  async function loadSettings() {
    const epoch = state.epoch;
    const settings = await unwrap(
      db.from("app_settings").select("*").eq("id", 1).single(),
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
      const context = await unwrap(db.rpc("get_context"));
      if (!alive(epoch)) return;
      if (context.role !== state.role) {
        await lock();
        return;
      }
      syncTime(context.server_time);
      state.nextReplyAt = Date.parse(context.reply_ready_at) || 0;
      await loadSettings();
      const tasks = [
        loadGallery(true),
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
        await lock();
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
      const blob = await unwrap(db.storage.from(cfg.BUCKET).download(path));
      if (!alive(epoch)) throw new Error("Sesi sudah dikunci.");
      cached.url = URL.createObjectURL(blob);
      return cached.url;
    })().catch((error) => {
      if (objectURLs.get(path) === cached) objectURLs.delete(path);
      throw error;
    });
    objectURLs.set(path, cached);
    return cached.promise;
  }
  function queuePhoto(visual, memory) {
    downloadQueue.push({ visual, memory, epoch: state.epoch });
    pumpPhotos();
  }
  function pumpPhotos() {
    while (activeDownloads < 3 && downloadQueue.length) {
      const task = downloadQueue.shift();
      if (!alive(task.epoch) || !task.visual.isConnected) continue;
      activeDownloads++;
      mediaURL(task.memory.preview_path || task.memory.media_path)
        .then((url) => {
          if (!alive(task.epoch) || !task.visual.isConnected) return;
          const img = node("img");
          img.src = url;
          img.alt = task.memory.title;
          img.decoding = "async";
          img.addEventListener("error", () => {
            img.remove();
            task.visual.append(
              node(
                "span",
                "loading-placeholder",
                "Pratinjau tidak tersedia. Ketuk untuk membuka.",
              ),
            );
          });
          task.visual.querySelector(".loading-placeholder")?.remove();
          task.visual.classList.add("has-photo");
          task.visual.prepend(img);
        })
        .catch(() => {
          if (alive(task.epoch) && task.visual.isConnected) {
            const label = task.visual.querySelector(".loading-placeholder");
            if (label)
              label.textContent = "Belum termuat. Ketuk untuk mencoba lagi.";
          }
        })
        .finally(() => {
          activeDownloads--;
          pumpPhotos();
        });
    }
  }
  function memoryCard(memory) {
    const card = node(
      "article",
      `memory-card${memory.is_locked ? " capsule" : ""}`,
    );
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
    button.addEventListener("click", () => openMemory(memory));
    return card;
  }
  async function loadGallery(reset = false) {
    if (galleryBusy || !state.user) return;
    galleryBusy = true;
    const epoch = state.epoch;
    $("load-more").disabled = true;
    try {
      const offset = reset ? 0 : state.memories.length;
      const rows = await unwrap(
        db.rpc("list_memories", { p_offset: offset, p_limit: cfg.PAGE_SIZE }),
      );
      if (!alive(epoch)) return;
      if (reset) {
        state.memories = [];
        $("gallery").replaceChildren();
        observer?.disconnect();
      }
      const known = new Set(state.memories.map((m) => m.id));
      const fresh = rows.filter((m) => !known.has(m.id));
      state.memories.push(...fresh);
      fresh.forEach((memory) => $("gallery").append(memoryCard(memory)));
      state.more = rows.length === cfg.PAGE_SIZE;
      $("load-more").hidden = !state.more;
      $("gallery-empty").hidden = state.memories.length > 0;
      if (!observer && "IntersectionObserver" in window)
        observer = new IntersectionObserver(
          (entries) => {
            entries.forEach((entry) => {
              if (entry.isIntersecting) {
                observer.unobserve(entry.target);
                queuePhoto(entry.target, entry.target._memory);
              }
            });
          },
          { rootMargin: "180px" },
        );
      $("gallery")
        .querySelectorAll(".memory-visual")
        .forEach((visual) => {
          if (!visual._memory || visual.dataset.observed) return;
          visual.dataset.observed = "true";
          if (observer) observer.observe(visual);
          else queuePhoto(visual, visual._memory);
        });
    } finally {
      if (alive(epoch)) {
        galleryBusy = false;
        $("load-more").disabled = false;
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
    } catch {
      /* Pilihan tampilan tidak wajib tersimpan. */
    }
  }
  async function openMemory(memory, immersive = false) {
    if (memory.is_locked || !state.user) return;
    const epoch = state.epoch;
    stopMusic();
    stopMedia($("memory-view-media"));
    currentMemory = memory;
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
      if (memory.media_kind === "image") media.alt = memory.title;
      else {
        media.controls = true;
        media.preload = "metadata";
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
    $("bucket-list").replaceChildren();
    $("bucket-empty").hidden = rows.length > 0;
    $("bucket-count").textContent =
      `${rows.filter((row) => row.is_completed).length}/${rows.length}`;
    rows.forEach((item) => {
      const li = node("li");
      const label = node("label");
      const input = node("input");
      input.type = "checkbox";
      input.checked = item.is_completed;
      label.append(input, node("span", "", item.title));
      li.append(label);
      if (item.completed_at)
        li.append(
          node("small", "", `Terwujud ${formatDate(item.completed_at)}`),
        );
      input.addEventListener("change", async () => {
        const requested = input.checked;
        input.disabled = true;
        try {
          await unwrap(
            db.rpc("set_bucket_completed", {
              p_id: item.id,
              p_completed: requested,
            }),
          );
          if (!alive(epoch)) return;
          await loadBuckets();
          toast(
            requested
              ? "Satu mimpi lagi jadi nyata. ♡"
              : "Impian ini kembali kita nantikan.",
          );
        } catch (error) {
          if (alive(epoch)) {
            input.checked = item.is_completed;
            toast(errorText(error));
          }
        } finally {
          input.disabled = false;
        }
      });
      $("bucket-list").append(li);
    });
  }
  async function loadLetters() {
    const epoch = state.epoch;
    const rows = await readAll("love_letters", "id,title,created_at");
    if (!alive(epoch)) return;
    const previous = $("letter-select").value;
    state.letters = rows;
    $("letter-select").replaceChildren(
      ...rows.map((letter) => {
        const option = node("option", "", letter.title);
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
        unwrap(
          db
            .from("love_letters")
            .select("*")
            .eq("id", $("letter-select").value)
            .single(),
        ),
        new Promise((resolve) => {
          envelopeTimer = setTimeout(
            resolve,
            matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 700,
          );
        }),
      ]);
      if (!alive(epoch)) return;
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
    const prompt = await unwrap(db.rpc("get_daily_prompt"));
    if (!alive(epoch)) return;
    if (state.prompt && state.prompt.date !== prompt.date && state.journalDirty)
      message(
        "journal-message",
        "Pertanyaan sudah berganti. Tinjau jawabanmu sebelum menyimpan.",
      );
    state.prompt = prompt;
    $("daily-question").textContent = prompt.question;
    $("daily-date").textContent = formatDate(prompt.date);
    if (!state.journalDirty) $("journal-answer").value = prompt.answer || "";
    const rows = await unwrap(
      db
        .from("daily_journals")
        .select("id,author_id,journal_date,question,answer")
        .order("journal_date", { ascending: false })
        .limit(7),
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
          node("p", "", entry.answer),
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
    const wait = Math.max(0, Math.ceil((state.nextReplyAt - now()) / 1000));
    $("reply-submit").disabled = wait > 0 || state.replyBusy;
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
      : "Unggah audio lewat + Tambah untuk mengisi daftar lagu kita.";
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
      const registration = await navigator.serviceWorker.register("./sw.js", {
        updateViaCache: "none",
      });
      const readyToUpdate = () => {
        waitingWorker = registration.waiting;
        if (waitingWorker && navigator.serviceWorker.controller)
          $("update-banner").hidden = false;
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
    state,
    $,
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
    currentMemory = null;
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
    loadGallery().catch((error) => toast(errorText(error))),
  );
  $("masonry-button").addEventListener("click", () => setView("masonry"));
  $("timeline-button").addEventListener("click", () => setView("timeline"));
  $("surprise-button").addEventListener("click", async () => {
    const epoch = state.epoch;
    $("surprise-button").disabled = true;
    try {
      const rows = await unwrap(db.rpc("random_memory"));
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
    const epoch = state.epoch,
      answer = $("journal-answer").value.trim(),
      day = state.prompt?.date;
    formAction(event.currentTarget, "journal-message", async () => {
      if (!day)
        throw new Error("Muat pertanyaan dahulu dengan tombol muat ulang.");
      await unwrap(
        db.rpc("save_daily_journal", { p_answer: answer, p_day: day }),
      );
      if (!alive(epoch)) return;
      state.journalDirty = false;
      message("journal-message", "Cerita hari ini sudah tersimpan. ♡");
      await loadDaily();
    });
  });
  $("memory-reply").addEventListener("click", () => {
    replyContext(currentMemory);
    $("memory-dialog").close();
    $("reply-panel").scrollIntoView({ behavior: "smooth", block: "center" });
    $("reply-body").focus({ preventScroll: true });
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
            syncTime(context.server_time);
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
  document.querySelectorAll(".section-nav a").forEach((link) =>
    link.addEventListener("click", () => {
      document
        .querySelectorAll(".section-nav a")
        .forEach((other) => other.removeAttribute("aria-current"));
      link.setAttribute("aria-current", "location");
    }),
  );
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
      state.journalDirty ||
      document.querySelector("form[data-busy]") ||
      $("admin-dialog").open
    ) {
      toast("Simpan pekerjaanmu dan tutup ruang bersama sebelum memuat ulang.");
      return;
    }
    waitingWorker?.postMessage({ type: "ACTIVATE_UPDATE" });
  });
  window.addEventListener("offline", () => {
    $("network-banner").hidden = false;
    wipeUI();
    message("login-message", "Sambungkan internet, lalu buka kenangan lagi.");
  });
  window.addEventListener("online", () => {
    $("network-banner").hidden = true;
    message("login-message", "Koneksi kembali. Silakan masuk.");
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.user && navigator.onLine) refresh();
  });
  window.addEventListener("pagehide", () => stopMusic());
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && state.user) lock();
  });
  window.addEventListener("beforeunload", (event) => {
    if (state.journalDirty || document.querySelector("form[data-busy]")) {
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
      !document.querySelector("form[data-busy]")
    )
      refresh();
  }, 60000);
  try {
    if (localStorage.getItem("cmv-gallery-view") === "timeline")
      setView("timeline");
  } catch {
    /* Opsional. */
  }
  $("network-banner").hidden = navigator.onLine;
  setupPWA();
  if (!db) message("login-message", window.vaultConfigError, true);
  else {
    // Callback auth harus sinkron; query Supabase dijalankan di luar callback.
    db.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") wipeUI();
    });
    if (navigator.onLine)
      db.auth
        .getSession()
        .then(async ({ data, error }) => {
          if (error) throw error;
          if (data.session && !state.user && !authenticating)
            await enter(data.session);
        })
        .catch((error) => message("login-message", errorText(error), true));
  }
})();

/* Formulir kontribusi bersama dan pengaturan Admin. */
(() => {
  "use strict";
  const V = window.Vault;
  const { $, db, cfg, state, unwrap, message, node } = V;
  let previewURL = null,
    inboxBusy = false;
  const pageSize = 20;
  const offsets = { replies: 0, daily_journals: 0 };
  const formats = Object.freeze({
    "image/jpeg": ["jpg", "image"],
    "image/png": ["png", "image"],
    "image/webp": ["webp", "image"],
    "image/gif": ["gif", "image"],
    "video/mp4": ["mp4", "video"],
    "video/webm": ["webm", "video"],
    "video/quicktime": ["mov", "video"],
    "audio/mpeg": ["mp3", "audio"],
    "audio/mp4": ["m4a", "audio"],
    "audio/ogg": ["ogg", "audio"],
    "audio/wav": ["wav", "audio"],
    "audio/x-wav": ["wav", "audio"],
    "audio/webm": ["webm", "audio"],
  });
  function requireMember() {
    if (!db || !state.user || !["admin", "viewer"].includes(state.role))
      throw new Error("Silakan masuk ke akunmu dahulu.");
    if (!navigator.onLine)
      throw new Error("Sambungkan internet sebelum menyimpan.");
  }
  function requireAdmin() {
    if (!db || state.role !== "admin" || !state.user)
      throw new Error("Silakan masuk sebagai Admin dahulu.");
    if (!navigator.onLine)
      throw new Error("Sambungkan internet sebelum menyimpan.");
  }
  function fileFormat(file) {
    if (!file || !file.size)
      throw new Error("Pilih file yang berisi foto, video, atau audio.");
    if (file.size > cfg.MAX_UPLOAD_BYTES)
      throw new Error(
        "Ukuran file melebihi 25 MB. Kompres dahulu, lalu coba lagi.",
      );
    if (!formats[file.type])
      throw new Error(
        "Format belum didukung. Pilih JPG, PNG, WebP, GIF, MP4, WebM, MOV, MP3, M4A, OGG, atau WAV.",
      );
    return formats[file.type];
  }
  async function makePreview(file) {
    // File asli tidak diubah. Versi WebP hanya untuk galeri yang lebih ringan.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const scale = Math.min(
        1,
        1600 / Math.max(img.naturalWidth, img.naturalHeight),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/webp", 0.9),
      );
      return blob?.type === "image/webp" ? blob : null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  function clearPreview() {
    V.stopMedia($("upload-preview"));
    $("upload-preview").replaceChildren();
    $("upload-preview").hidden = true;
    if (previewURL) URL.revokeObjectURL(previewURL);
    previewURL = null;
  }
  function bindForm(id, messageId, action) {
    $(id).addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form); // Sebelum form dinonaktifkan.
      V.formAction(form, messageId, async () => {
        requireMember();
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
      "memories",
      "id,title,media_kind,unlock_at,created_at",
    );
    if (!V.alive(epoch)) return;
    const settings = state.settings;
    $("settings-names").value = settings.couple_names;
    $("settings-start").value = settings.relationship_started_at
      ? V.localInput(settings.relationship_started_at)
      : "";
    $("settings-timezone").value = settings.timezone;
    $("settings-event").value = settings.event_name;
    $("settings-event-at").value = settings.event_at
      ? V.localInput(settings.event_at)
      : "";
    const empty = node("option", "", "Tanpa musik");
    empty.value = "";
    $("settings-music").replaceChildren(empty);
    rows
      .filter(
        (memory) =>
          memory.media_kind === "audio" &&
          (!memory.unlock_at || Date.parse(memory.unlock_at) <= V.now()),
      )
      .forEach((memory) => {
        const option = node("option", "", memory.title);
        option.value = memory.id;
        $("settings-music").append(option);
      });
    $("settings-music").value = settings.music_memory_id || "";
  }
  function inboxCard(entry, isJournal) {
    const article = node("article", "inbox-item");
    article.append(
      node(
        "time",
        "",
        V.formatDate(
          isJournal ? entry.journal_date : entry.created_at,
          !isJournal,
        ),
      ),
    );
    article.append(
      node(
        "span",
        "author-badge",
        entry.author_id === state.user.id ? "Darimu" : "Dari pasanganmu",
      ),
    );
    if (isJournal) article.append(node("h4", "", entry.question));
    else if (entry.memory_id)
      article.append(node("p", "context", "Balasan untuk sebuah kenangan"));
    article.append(node("p", "", isJournal ? entry.answer : entry.body));
    return article;
  }
  async function inboxPage(table, reset = false) {
    requireMember();
    const epoch = state.epoch;
    const isJournal = table === "daily_journals";
    const target = $(isJournal ? "admin-journals" : "admin-replies");
    const moreButton = $(isJournal ? "more-journals" : "more-replies");
    const offset = reset ? 0 : offsets[table];
    const fields = isJournal
      ? "id,author_id,journal_date,question,answer,created_at"
      : "id,author_id,body,memory_id,created_at";
    const rows = await unwrap(
      db
        .from(table)
        .select(fields)
        .order("created_at", { ascending: false })
        .order("id")
        .range(offset, offset + pageSize - 1),
    );
    if (!V.alive(epoch)) return;
    if (reset) target.replaceChildren();
    offsets[table] = offset + rows.length;
    rows.forEach((entry) => target.append(inboxCard(entry, isJournal)));
    if (!offsets[table])
      target.append(
        node(
          "p",
          "muted tiny",
          isJournal ? "Belum ada jurnal harian." : "Belum ada pesan masuk.",
        ),
      );
    moreButton.hidden = rows.length < pageSize;
  }
  async function loadInbox() {
    if (inboxBusy) return;
    const epoch = state.epoch;
    inboxBusy = true;
    message("inbox-message", "Memuat cerita pasanganmu…");
    try {
      const results = await Promise.allSettled([
        inboxPage("replies", true),
        inboxPage("daily_journals", true),
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
      if (V.alive(epoch)) message("inbox-message");
    } catch (error) {
      if (V.alive(epoch)) message("inbox-message", V.errorText(error), true);
    } finally {
      inboxBusy = false;
    }
  }

  $("admin-login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const email = $("admin-email").value,
      password = $("admin-password").value;
    V.formAction(event.currentTarget, "admin-login-message", async () => {
      await V.login(email, password);
      message("admin-login-message");
    });
  });
  $("admin-open").addEventListener("click", async () => {
    try {
      requireMember();
      if (!$("admin-dialog").open) $("admin-dialog").showModal();
      if (!$("memory-date").value)
        $("memory-date").value = V.localInput().slice(0, 10);
      if (state.role === "admin") await fillSettings();
      if ($("inbox-details").open) await loadInbox();
    } catch (error) {
      V.toast(V.errorText(error));
    }
  });
  $("memory-file").addEventListener("change", () => {
    clearPreview();
    message("upload-message");
    const file = $("memory-file").files[0];
    if (!file) return;
    try {
      const [, kind] = fileFormat(file);
      previewURL = URL.createObjectURL(file);
      const media = node(
        kind === "image" ? "img" : kind === "video" ? "video" : "audio",
      );
      media.src = previewURL;
      if (kind === "image") media.alt = "Pratinjau unggahan";
      else {
        media.controls = true;
        media.preload = "metadata";
        media.setAttribute("playsinline", "");
      }
      $("upload-preview").append(media);
      $("upload-preview").hidden = false;
    } catch (error) {
      message("upload-message", V.errorText(error), true);
      $("memory-file").value = "";
    }
  });
  bindForm("upload-form", "upload-message", async (formData, form, epoch) => {
    const file = formData.get("file");
    const [extension, kind] = fileFormat(file);
    const title = String(formData.get("title")).trim();
    if (!title) throw new Error("Judul kenangan tidak boleh kosong.");
    const unlockValue = formData.get("unlock");
    const unlockAt = unlockValue ? new Date(unlockValue).toISOString() : null;
    const id = crypto.randomUUID();
    const path = `${state.user.id}/${id}.${extension}`;
    const thumbnail =
      kind === "image" && file.type !== "image/gif"
        ? await makePreview(file).catch(() => null)
        : null;
    if (!V.alive(epoch)) return;
    const previewPath = thumbnail
      ? `${state.user.id}/${id}-preview.webp`
      : null;
    const uploadedPaths = [path];
    const memory = {
      id,
      title,
      caption: String(formData.get("caption")).trim(),
      media_path: path,
      preview_path: null,
      media_kind: kind,
      occurred_on: formData.get("date"),
      unlock_at: unlockAt,
    };
    let uploaded = false;
    $("upload-progress").hidden = false;
    try {
      message(
        "upload-message",
        "Mengunggah media… Jangan tutup halaman dahulu.",
      );
      await unwrap(
        db.storage.from(cfg.BUCKET).upload(path, file, {
          upsert: false,
          contentType: file.type,
          cacheControl: "0",
        }),
      );
      uploaded = true;
      if (!V.alive(epoch)) return;
      if (thumbnail) {
        const previewResult = await db.storage
          .from(cfg.BUCKET)
          .upload(previewPath, thumbnail, {
            upsert: false,
            contentType: "image/webp",
            cacheControl: "0",
          });
        if (!V.alive(epoch)) return;
        if (!previewResult.error) {
          memory.preview_path = previewPath;
          uploadedPaths.push(previewPath);
        } else {
          // Foto asli tetap dapat disimpan jika pembuatan/unggah pratinjau gagal.
          await db.storage.from(cfg.BUCKET).remove([previewPath]);
        }
      }
      message("upload-message", "Media terunggah. Menyimpan ceritanya…");
      const { error: insertError } = await db
        .from("memories")
        .insert(memory)
        .select("id")
        .single();
      if (insertError) {
        // Timeout bisa terjadi SETELAH commit. Periksa ID yang sama sebelum cleanup.
        const check = await db
          .from("memories")
          .select("id")
          .eq("id", id)
          .maybeSingle();
        if (check.error)
          throw new Error(
            "Hasil penyimpanan belum dapat dipastikan. Muat ulang galeri sebelum mengunggah ulang. File masih disimpan di Storage.",
          );
        if (!check.data) {
          const cleanup = await db.storage
            .from(cfg.BUCKET)
            .remove(uploadedPaths);
          if (cleanup.error)
            throw new Error(
              "Cerita gagal tersimpan dan file belum dapat dibersihkan. Periksa Storage sebelum mencoba lagi.",
            );
          throw insertError;
        }
      }
      if (!V.alive(epoch)) return;
      form.reset();
      clearPreview();
      $("memory-date").value = V.localInput().slice(0, 10);
      await refreshAfterSave(
        "upload-message",
        unlockAt && Date.parse(unlockAt) > V.now()
          ? "Kapsul waktumu sudah disimpan. ♡"
          : "Kenangan baru sudah tersimpan. ♡",
      );
      // Jangan menimpa pengaturan lain yang sedang diketik saat memperbarui opsi musik.
      if (kind === "audio" && (!unlockAt || Date.parse(unlockAt) <= V.now())) {
        const option = node("option", "", title);
        option.value = id;
        $("settings-music").append(option);
      }
    } catch (error) {
      if (
        !uploaded &&
        /fetch|network|abort|timeout/i.test(error.message || "")
      ) {
        throw new Error(
          "Koneksi terputus saat unggah. Periksa galeri dan Storage sebelum mencoba lagi; file mungkin sudah terunggah.",
        );
      }
      throw error;
    } finally {
      $("upload-progress").hidden = true;
    }
  });
  bindForm("bucket-form", "bucket-message", async (data, form, epoch) => {
    const title = String(data.get("title")).trim();
    if (!title) throw new Error("Tulis impianmu terlebih dahulu.");
    await unwrap(
      db.from("bucket_list").insert({ title }).select("id").single(),
    );
    if (!V.alive(epoch)) return;
    form.reset();
    message("bucket-message", "Impian baru sudah ditambahkan.");
    await V.loadBuckets();
  });
  bindForm("letter-form", "letter-message", async (data, form, epoch) => {
    const title = String(data.get("title")).trim(),
      body = String(data.get("body")).trim();
    if (!title || !body) throw new Error("Isi judul dan suratmu dahulu.");
    await unwrap(
      db.from("love_letters").insert({ title, body }).select("id").single(),
    );
    if (!V.alive(epoch)) return;
    form.reset();
    message("letter-message", "Suratmu sudah tersimpan di dalam amplop.");
    await V.loadLetters();
  });
  bindForm("settings-form", "settings-message", async (data, form, epoch) => {
    requireAdmin();
    const names = String(data.get("names")).trim();
    if (!names) throw new Error("Isi nama kalian dahulu.");
    const eventName = String(data.get("event")).trim();
    if (data.get("eventAt") && !eventName)
      throw new Error("Beri nama untuk hari spesialmu.");
    const settings = {
      couple_names: names,
      relationship_started_at: data.get("start")
        ? new Date(data.get("start")).toISOString()
        : null,
      timezone: data.get("timezone"),
      event_name: eventName,
      event_at: data.get("eventAt")
        ? new Date(data.get("eventAt")).toISOString()
        : null,
      music_memory_id: data.get("music") || null,
    };
    await unwrap(
      db
        .from("app_settings")
        .update(settings)
        .eq("id", 1)
        .select("id")
        .single(),
    );
    if (!V.alive(epoch)) return;
    await refreshAfterSave(
      "settings-message",
      "Pengaturan cerita kita sudah diperbarui.",
    );
  });
  $("inbox-details").addEventListener("toggle", () => {
    if ($("inbox-details").open && state.user) loadInbox();
  });
  $("inbox-refresh").addEventListener("click", loadInbox);
  for (const [id, table] of [
    ["more-replies", "replies"],
    ["more-journals", "daily_journals"],
  ]) {
    $(id).addEventListener("click", async () => {
      $(id).disabled = true;
      try {
        await inboxPage(table);
      } catch (error) {
        message("inbox-message", V.errorText(error), true);
      } finally {
        $(id).disabled = false;
      }
    });
  }
  $("admin-dialog").addEventListener("close", () => {
    $("upload-preview")
      .querySelectorAll("video,audio")
      .forEach((media) => media.pause());
  });
  document.addEventListener("cmv:locked", () => {
    clearPreview();
    offsets.replies = 0;
    offsets.daily_journals = 0;
    inboxBusy = false;
    const option = node("option", "", "Tanpa musik");
    option.value = "";
    $("settings-music").replaceChildren(option);
  });
})();