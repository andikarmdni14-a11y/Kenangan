/* Kapsul, kalender, peta, reaksi, serta antrean draf milik akun yang aktif. */
(() => {
  "use strict";
  const V = window.Vault,
    { $, state, db, local, node, unwrap } = V;
  let entries = [],
    shared = { events: [], locations: [], reactions: [] },
    jobs = [];
  let syncing = false,
    loading = false,
    lastError = "",
    storageError = false;
  let lastStatusKey = null, previousStatus = null;
  let selected = "",
    month = "",
    editEvent = null,
    map,
    pins,
    picker,
    pickMarker,
    picked = null;
  let locationMemory = null;
  let draftTimers = new Map(),
    writing = 0,
    offlineTiles = new Set();
  const draftIds = new Map(),
    draftDays = new Map(),
    draftTitles = new Map();
  function today() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: state.settings?.timezone || "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }
  function confirmAction(text, label = "Lanjutkan") {
    return new Promise((resolve) => {
      const dialog = $("confirm-dialog");
      $("confirm-copy").textContent = text;
      $("confirm-ok").textContent = label;
      const finish = (value) => {
        dialog.removeEventListener("cancel", cancel);
        $("confirm-cancel").onclick = null;
        $("confirm-ok").onclick = null;
        dialog.close();
        resolve(value);
      };
      const cancel = (event) => {
        event.preventDefault();
        finish(false);
      };
      dialog.addEventListener("cancel", cancel);
      $("confirm-cancel").onclick = () => finish(false);
      $("confirm-ok").onclick = () => finish(true);
      dialog.showModal();
    });
  }
  async function status() {
    if (!state.user) return;
    const epoch = state.epoch;
    try {
      jobs = await local.list("queue");
    } catch {
      storageError = true;
    }
    if (!V.alive(epoch)) return;
    const failed = jobs.filter((j) => j.error).length;
    const kind = storageError ? "error"
      : failed ? "error"
      : !navigator.onLine ? "offline"
      : syncing && jobs.length ? "syncing"
      : jobs.length ? "pending"
      : lastError ? "error" : "online";
    const detail = storageError
      ? "Penyimpanan perangkat belum tersedia. Jangan tutup tulisanmu."
      : failed
        ? `${failed} perubahan perlu ditinjau. Buka Draf & antrean.`
        : !navigator.onLine
          ? `Kamu sedang luring. Baca kenangan tersimpan atau lanjutkan drafmu.${jobs.length ? ` ${jobs.length} perubahan menunggu koneksi.` : ""}`
          : syncing && jobs.length
            ? `Mengirim ${jobs.length} perubahan…`
            : jobs.length
              ? `${jobs.length} perubahan menunggu pengiriman dan tersimpan di perangkat.`
              : lastError || "Tersambung. Tidak ada perubahan yang menunggu pengiriman.";
    const names = { online: "Tersambung", offline: "Luring", syncing: "Menyinkronkan", pending: "Perubahan menunggu", error: "Perlu diperiksa" };
    const indicator = $("sync-indicator");
    indicator.dataset.status = kind;
    indicator.setAttribute("aria-label", `${names[kind]}. Buka status sinkronisasi dan draf.`);
    indicator.title = `${names[kind]} · status dan draf`;
    $("sync-status").textContent = detail;
    $("sync-status").classList.toggle("error", kind === "error");
    $("sync-now").disabled = syncing || !navigator.onLine;
    // Empty queue checks (focus/30-second timer) must never produce repeated toasts.
    const key = `${kind}:${kind === "error" ? detail : ""}`;
    if (key !== lastStatusKey) {
      if (lastStatusKey !== null || kind !== "online") {
        const text = kind === "online" && ["syncing", "pending"].includes(previousStatus)
          ? "Perubahanmu sudah tersimpan. ♡"
          : kind === "online" && previousStatus === "offline"
            ? "Koneksi kembali. Cerita siap diperbarui."
            : detail;
        V.toast(text, 3000);
      }
      lastStatusKey = key;
      previousStatus = kind;
    }
    if ($("drafts-dialog").open) await renderDrafts();
  }
  async function load() {
    if (loading || !state.user) return;
    loading = true;
    const epoch = state.epoch;
    try {
      const result = await Promise.allSettled([
        local.cached("entries", async () => {
          const all = [];
          for (let offset = 0; ; offset += 100) {
            const rows = await unwrap(
              db.rpc("cmv_list_entries", { p_offset: offset, p_limit: 100 }),
            );
            all.push(...rows);
            if (rows.length < 100) return all;
          }
        }),
        local.cached("shared-v6", () => unwrap(db.rpc("cmv_shared_state"))),
      ]);
      if (!V.alive(epoch)) return;
      if (result[0].status === "fulfilled") entries = result[0].value;
      if (result[1].status === "fulfilled") {
        shared = result[1].value;
        if (navigator.onLine) V.syncTime(shared.server_time);
      }
      const failed = result.find((r) => r.status === "rejected");
      lastError = failed ? V.errorText(failed.reason) : "";
      if (!selected) {
        selected = today();
        month = selected.slice(0, 7);
      }
      await status();
      renderCalendar();
      renderMap();
      paintReactions();
    } finally {
      loading = false;
    }
  }
  async function enqueue(action, data) {
    if (!state.user) throw new Error("Buka akunmu dahulu.");
    const job = {
      id: crypto.randomUUID(),
      action,
      data,
      created: Date.now(),
      error: null,
    };
    await local.put("queue", job.id, job);
    await local.wake();
    await status();
    return job;
  }
  async function sync(retry = false) {
    if (syncing || !state.user || !navigator.onLine) return;
    const epoch = state.epoch;
    const run = async () => {
      if (!V.alive(epoch)) return;
      syncing = true;
      await status();
      let changed = false;
      try {
        const queue = (await local.list("queue")).sort(
          (a, b) => a.created - b.created,
        );
        for (const job of queue) {
          if (!V.alive(epoch) || !navigator.onLine) break;
          if (job.error && !retry) continue;
          try {
            await unwrap(
              db.rpc("cmv_apply", {
                p_request_id: job.id,
                p_action: job.action,
                p_data: job.data,
              }),
            );
            if (!V.alive(epoch)) return;
            await local.remove("queue", job.id);
            changed = true;
          } catch (error) {
            if (!V.alive(epoch)) return;
            if (local.networkError(error)) {
              lastError =
                "Koneksi belum stabil. Antrean tersimpan dan akan dicoba lagi.";
              break;
            }
            job.error = V.errorText(error);
            job.code = error.code;
            await local.put("queue", job.id, job);
            if (error.code === "42501") break;
          }
        }
        if (changed && V.alive(epoch)) {
          lastError = "";
          await load();
          await Promise.allSettled([V.loadLetters(), V.loadDaily()]);
        }
      } finally {
        syncing = false;
        if (V.alive(epoch)) {
          await status();
          renderCalendar();
          paintReactions();
        }
      }
    };
    try {
      if (navigator.locks)
        await navigator.locks.request(
          `cmv-sync:${local.account}`,
          { ifAvailable: true },
          (lock) => (lock ? run() : undefined),
        );
      else await run();
    } catch (error) {
      if (V.alive(epoch)) {
        lastError = V.errorText(error);
        await status();
      }
    }
  }
  function readDraft(kind) {
    const journal = kind === "journal";
    return {
      id: draftIds.get(kind) || crypto.randomUUID(),
      kind,
      title: journal
        ? draftTitles.get(kind) ||
          state.prompt?.question ||
          "Cerita kecil hari ini"
        : $("letter-title").value,
      body: $(journal ? "journal-answer" : "letter-body").value,
      date: draftDays.get(kind) || state.prompt?.date || today(),
      capsule: $(kind + "-capsule").checked,
      unlock: $(kind + "-unlock").value,
      updated: Date.now(),
    };
  }
  async function storeDraft(kind) {
    if (!state.user) return;
    const d = readDraft(kind),
      epoch = state.epoch;
    draftIds.set(kind, d.id);
    draftDays.set(kind, d.date);
    draftTitles.set(kind, d.title);
    writing++;
    try {
      if (d.body.trim() || (!d.kind.startsWith("journal") && d.title.trim()))
        await local.put("draft", kind, d);
      else {
        await local.remove("draft", kind);
        draftIds.delete(kind);
        draftDays.delete(kind);
        draftTitles.delete(kind);
      }
      if (V.alive(epoch)) {
        const el = $(kind === "journal" ? "journal-message" : "letter-message");
        if (!el.closest("form").dataset.busy)
          V.message(el.id, "Draf tersimpan di perangkat.");
      }
    } catch {
      storageError = true;
      if (V.alive(epoch))
        V.message(
          kind + "-message",
          "Draf belum tersimpan. Jangan tutup halaman dahulu.",
          true,
        );
    } finally {
      writing--;
    }
  }
  function scheduleDraft(kind) {
    clearTimeout(draftTimers.get(kind));
    draftTimers.set(
      kind,
      setTimeout(() => {
        draftTimers.delete(kind);
        storeDraft(kind);
      }, 300),
    );
  }
  function capsuleUI(kind) {
    const checked = $(kind + "-capsule").checked;
    $(kind + "-unlock-wrap").hidden = !checked;
    $(kind + "-unlock").required = checked;
    $(kind + "-unlock").disabled = !checked;
  }
  async function applyDraft(d) {
    const journal = d.kind === "journal";
    draftIds.set(d.kind, d.id);
    draftDays.set(d.kind, d.date);
    draftTitles.set(d.kind, d.title);
    if (journal) {
      $("daily-date").textContent = V.formatDate(d.date);
      $("daily-question").textContent = d.title;
    }
    V.message(d.kind + "-message", "Drafmu dipulihkan. Belum dibagikan.");
    $(journal ? "journal-answer" : "letter-body").value = d.body;
    if (!journal) $("letter-title").value = d.title;
    $(d.kind + "-capsule").checked = d.capsule;
    $(d.kind + "-unlock").value = d.unlock || "";
    capsuleUI(d.kind);
    if (journal) state.journalDirty = true;
  }
  async function saveEntry(kind) {
    const epoch = state.epoch;
    clearTimeout(draftTimers.get(kind));
    draftTimers.delete(kind);
    const d = readDraft(kind);
    const data = {
      id: d.id,
      kind,
      title: d.title.trim(),
      body: d.body.trim(),
      occurred_on: d.date,
      unlock_at: d.capsule ? new Date(d.unlock).toISOString() : null,
    };
    const job = await enqueue("entry", data);
    if (!V.alive(epoch)) return;
    await local.remove("draft", kind);
    draftIds.delete(kind);
    draftDays.delete(kind);
    draftTitles.delete(kind);
    $(kind + "-form").reset();
    capsuleUI(kind);
    if (kind === "journal") state.journalDirty = false;
    V.message(
      kind + "-message",
      "Tersimpan di antrean perangkat. Akan dikirim saat tersambung.",
    );
    await sync();
    if (!V.alive(epoch)) return;
    const pending = await local.get("queue", job.id);
    V.message(
      kind + "-message",
      pending?.error
        ? `Tulisan tetap aman di antrean. ${pending.error}`
        : pending
          ? "Draf siap dikirim otomatis saat koneksi kembali."
          : d.capsule
            ? "Kapsul sudah ditutup. Sampai bertemu pada waktunya. ♡"
            : "Cerita sudah tersimpan untuk kita berdua. ♡",
      !!pending?.error,
    );
  }
  async function renderDrafts() {
    const epoch = state.epoch,
      drafts = await local.list("draft"),
      queue = await local.list("queue");
    if (!V.alive(epoch)) return;
    $("drafts-list").replaceChildren(node("h3", "", "Draf pribadi"));
    if (!drafts.length)
      $("drafts-list").append(
        node(
          "p",
          "tiny muted",
          "Belum ada draf. Mulai menulis jurnal atau surat.",
        ),
      );
    for (const d of drafts) {
      const row = node("article", "inbox-item");
      row.append(
        node(
          "p",
          "",
          d.kind === "journal"
            ? "Jurnal yang belum dibagikan"
            : d.title || "Surat yang belum selesai",
        ),
      );
      const b = node("button", "text-button", "Lanjut menulis");
      b.type = "button";
      b.onclick = async () => {
        await applyDraft(d);
        $("drafts-dialog").close();
        if (d.kind === "letter") {
          $("admin-open").click();
          $("letter-form").closest("details").open = true;
        } else {
          await window.VaultPages.navigate("jurnal", {
            focusId: "journal-answer",
          });
        }
      };
      row.append(b);
      $("drafts-list").append(row);
    }
    $("queue-list").replaceChildren(node("h3", "", "Menunggu terkirim"));
    if (!queue.length)
      $("queue-list").append(
        node("p", "tiny muted", "Semua yang dikirim sudah tersinkron."),
      );
    for (const job of queue) {
      const row = node("article", "inbox-item");
      row.append(
        node(
          "strong",
          "",
          {
            entry: "Cerita",
            calendar: "Rencana",
            location: "Lokasi",
            reaction: "Reaksi",
          }[job.action],
        ),
        node("p", "tiny", job.error || "Menunggu koneksi untuk dikirim."),
      );
      if (job.action === "entry") {
        const b = node("button", "text-button", "Pulihkan sebagai draf");
        b.type = "button";
        b.disabled = syncing;
        b.onclick = async () => {
          const old = await local.get("draft", job.data.kind);
          if (
            old &&
            !(await confirmAction(
              "Draf yang sedang kamu tulis akan diganti dengan tulisan dari antrean ini.",
              "Ganti draf",
            ))
          )
            return;
          const d = {
            id: crypto.randomUUID(),
            kind: job.data.kind,
            title: job.data.title,
            body: job.data.body,
            date: job.data.occurred_on,
            capsule: !!job.data.unlock_at,
            unlock: job.data.unlock_at ? V.localInput(job.data.unlock_at) : "",
            updated: Date.now(),
          };
          await local.put("draft", d.kind, d);
          await applyDraft(d);
          await local.remove("queue", job.id);
          await status();
        };
        row.append(b);
      }
      if (job.code === "40001")
        row.append(
          node(
            "p",
            "tiny muted",
            "Salin catatanmu, hapus antrean yang bentrok, lalu buka jadwal terbaru untuk mengedit ulang.",
          ),
          node(
            "p",
            "preserve-lines",
            `${job.data.title || ""}\n${job.data.note || ""}`,
          ),
        );
      const cancel = node("button", "text-button", "Hapus dari antrean");
      cancel.type = "button";
      cancel.disabled = syncing;
      cancel.onclick = async () => {
        if (
          !(await confirmAction(
            "Hapus perubahan yang belum terkirim ini?",
            "Hapus antrean",
          ))
        )
          return;
        await local.remove("queue", job.id);
        await status();
        renderCalendar();
        paintReactions();
      };
      row.append(cancel);
      $("queue-list").append(row);
    }
  }
  function effectiveReactions() {
    const r = [...shared.reactions];
    for (const j of jobs
      .filter((j) => j.action === "reaction" && !j.error)
      .sort((a, b) => a.created - b.created)) {
      const i = r.findIndex(
        (x) =>
          x.author_id === state.user?.id &&
          x.target_id === j.data.id &&
          x.target_kind === j.data.target_kind,
      );
      if (i >= 0) r.splice(i, 1);
      if (j.data.emoji)
        r.push({
          author_id: state.user?.id,
          target_id: j.data.id,
          target_kind: j.data.target_kind,
          emoji: j.data.emoji,
        });
    }
    return r;
  }
  function paintBar(bar) {
    const kind = bar.dataset.reactionKind,
      id = bar.dataset.reactionId;
    const rows = effectiveReactions().filter(
      (r) => r.target_kind === kind && r.target_id === id,
    );
    const own = rows.find((r) => r.author_id === state.user?.id);
    bar.replaceChildren();
    for (const [emoji, name] of [
      ["❤️", "Sayang"],
      ["✨", "Istimewa"],
      ["🥰", "Peluk"],
    ]) {
      const button = node(
        "button",
        "reaction",
        `${emoji} ${rows.filter((r) => r.emoji === emoji).length || ""}`.trim(),
      );
      button.type = "button";
      button.setAttribute(
        "aria-label",
        `${name}, ${rows.filter((r) => r.emoji === emoji).length} reaksi`,
      );
      button.setAttribute("aria-pressed", String(own?.emoji === emoji));
      button.onclick = async () => {
        const epoch = state.epoch;
        button.disabled = true;
        try {
          await enqueue("reaction", {
            id,
            target_kind: kind,
            emoji: own?.emoji === emoji ? null : emoji,
          });
          if (!V.alive(epoch)) return;
          paintReactions();
          if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
            const burst = node("span", "reaction-burst", emoji);
            bar.append(burst);
            setTimeout(() => burst.remove(), 900);
          }
          await sync();
        } catch (e) {
          if (V.alive(epoch)) V.toast(V.errorText(e));
        } finally {
          button.disabled = false;
        }
      };
      bar.append(button);
    }
  }
  function reactionBar(kind, id) {
    const bar = node("div", "reactions");
    bar.dataset.reactionKind = kind;
    bar.dataset.reactionId = id;
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Reaksi untuk cerita ini");
    paintBar(bar);
    return bar;
  }
  function paintReactions() {
    V.all("[data-reaction-kind]").forEach(paintBar);
  }
  function effectiveEvents() {
    const all = new Map(shared.events.map((e) => [e.id, e]));
    for (const job of jobs.filter((j) => j.action === "calendar" && !j.error)) {
      if (job.data.deleted) all.delete(job.data.id);
      else all.set(job.data.id, { ...job.data, pending: true });
    }
    return [...all.values()];
  }
  function renderCalendar() {
    if (!month) return;
    const [year, m] = month.split("-").map(Number),
      date = new Date(Date.UTC(year, m - 1, 1));
    $("calendar-month").textContent = new Intl.DateTimeFormat("id-ID", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(date);
    const days = new Date(Date.UTC(year, m, 0)).getUTCDate(),
      start = (date.getUTCDay() + 6) % 7,
      events = effectiveEvents();
    $("calendar-days").replaceChildren();
    for (let i = 0; i < start; i++)
      $("calendar-days").append(node("span", "calendar-blank"));
    for (let d = 1; d <= days; d++) {
      const key = `${month}-${String(d).padStart(2, "0")}`,
        count = events.filter((e) => e.event_date === key).length;
      const b = node(
        "button",
        `calendar-day${key === today() ? " is-today" : ""}${count ? " has-event" : ""}`,
        String(d),
      );
      b.type = "button";
      b.setAttribute(
        "aria-label",
        `${V.formatDate(key)}${count ? `, ${count} rencana` : ""}`,
      );
      b.setAttribute("aria-pressed", String(selected === key));
      if (key === today()) b.setAttribute("aria-current", "date");
      b.onclick = () => {
        selected = key;
        renderCalendar();
      };
      $("calendar-days").append(b);
    }
    $("calendar-selected").textContent = V.formatDate(selected);
    const rows = events
      .filter((e) => e.event_date === selected)
      .sort((a, b) =>
        String(a.event_time || "").localeCompare(String(b.event_time || "")),
      );
    $("calendar-agenda").replaceChildren();
    if (!rows.length)
      $("calendar-agenda").append(
        node(
          "p",
          "tiny muted",
          "Belum ada rencana. Sisihkan waktu untuk kita?",
        ),
      );
    rows.forEach((e) => {
      const b = node("button", "agenda-item");
      b.type = "button";
      b.append(
        node("span", "", e.title),
        node(
          "small",
          "muted",
          `${e.event_time ? e.event_time.slice(0, 5) : "Seharian"}${e.pending ? " · menunggu sinkron" : ""}`,
        ),
      );
      b.onclick = () =>
        e.pending
          ? V.toast(
              "Rencana ini masih di antrean. Tunggu tersinkron sebelum mengedit.",
            )
          : openEvent(e);
      $("calendar-agenda").append(b);
    });
  }
  function openEvent(event = null) {
    editEvent = event;
    $("calendar-form").reset();
    V.clearValidation($("calendar-form"));
    V.message("calendar-message");
    $("calendar-title").value = event?.title || "";
    $("calendar-date").value = event?.event_date || selected || today();
    $("calendar-time").value = event?.event_time?.slice(0, 5) || "";
    $("calendar-note").value = event?.note || "";
    $("calendar-delete").hidden = !event;
    $("calendar-timezone").textContent =
      `Jam rencana mengikuti ${state.settings?.timezone || "Asia/Jakarta"}. Kalian berdua bisa mengeditnya.`;
    $("calendar-dialog").showModal();
  }
  async function saveEvent(deleted = false) {
    const epoch = state.epoch;
    const data = {
      id: editEvent?.id || crypto.randomUUID(),
      version: editEvent?.version || 0,
      title: $("calendar-title").value.trim(),
      event_date: $("calendar-date").value,
      event_time: $("calendar-time").value || null,
      note: $("calendar-note").value.trim(),
      deleted,
    };
    const job = await enqueue("calendar", data);
    await sync();
    if (!V.alive(epoch)) return;
    const pending = await local.get("queue", job.id);
    selected = data.event_date;
    month = selected.slice(0, 7);
    renderCalendar();
    if (pending?.error) {
      V.message(
        "calendar-message",
        pending.error + " Periksa Draf & antrean.",
        true,
      );
      return;
    }
    $("calendar-dialog").close();
    $("calendar-add").focus({ preventScroll: true });
    V.toast(
      pending
        ? "Rencana tersimpan di antrean."
        : "Kalender kita sudah diperbarui. ♡",
    );
  }
  function markerIcon() {
    return L.divIcon({
      className: "memory-pin",
      html: '<span aria-hidden="true">♡</span>',
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
  }
  function tiles(target) {
    const layer = L.tileLayer(
      "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        referrerPolicy: "strict-origin-when-cross-origin",
      },
    );
    offlineTiles.add({ target, layer });
    if (navigator.onLine) layer.addTo(target);
  }
  function renderMap() {
    if (!state.user) return;
    const locations = shared.locations.filter(l => !window.VaultEpic || window.VaultEpic.matches(l.memory));
    $("map-list").replaceChildren();
    for (const loc of locations) {
      const b = node(
        "button",
        "text-button",
        `⌖ ${loc.label || loc.memory.title}`,
      );
      b.type = "button";
      b.onclick = () => V.openMemory(loc.memory);
      $("map-list").append(b);
    }
    $("map-status").textContent = navigator.onLine
      ? `${locations.length} tempat sesuai filter · ketuk pin atau nama tempat untuk membuka kenangan.`
      : "Luring · daftar lokasi tetap tersedia; peta dasar membutuhkan internet.";
    if (!$("map-details").isConnected || !$("map-details").open || !window.L)
      return;
    if (!map) {
      map = L.map("memory-map", { scrollWheelZoom: false }).setView(
        [-6.2, 106.85],
        11,
      );
      tiles(map);
      pins = L.featureGroup().addTo(map);
    }
    map.invalidateSize();
    pins.clearLayers();
    for (const loc of locations) {
      const content = node("div");
      content.append(node("strong", "", loc.label || loc.memory.title));
      const open = node("button", "text-button", "Buka kenangan");
      open.type = "button";
      open.onclick = () => V.openMemory(loc.memory);
      content.append(open);
      L.marker([loc.lat, loc.lng], {
        icon: markerIcon(),
        title: loc.label || loc.memory.title,
      })
        .bindPopup(content)
        .addTo(pins);
    }
    if (locations.length)
      map.fitBounds(pins.getBounds(), {
        padding: [32, 32],
        maxZoom: 14,
        animate: false,
      });
  }
  function locationData() {
    const lat = $("memory-lat").value,
      lng = $("memory-lng").value;
    if (!lat && !lng) return null;
    if (
      !lat ||
      !lng ||
      !Number.isFinite(Number(lat)) ||
      !Number.isFinite(Number(lng)) ||
      Math.abs(Number(lat)) > 90 ||
      Math.abs(Number(lng)) > 180
    )
      throw new Error("Isi koordinat yang valid atau pilih titik di peta.");
    return {
      label: $("memory-place").value.trim(),
      lat: Number(lat),
      lng: Number(lng),
    };
  }
  async function saveLocation(id, point) {
    if (!point) return;
    await enqueue("location", { id, ...point });
    await sync();
  }
  function pick(point) {
    picked = point;
    $("location-lat").value = point.lat.toFixed(6);
    $("location-lng").value = point.lng.toFixed(6);
    $("location-preview").textContent =
      `Titik dipilih: ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
    if (pickMarker) pickMarker.setLatLng(point);
    else pickMarker = L.marker(point, { icon: markerIcon() }).addTo(picker);
  }
  function openLocation(memory = null) {
    locationMemory = memory;
    $("location-form").reset();
    V.clearValidation($("location-form"));
    V.message("location-message");
    const point = memory
      ? shared.locations.find((l) => l.memory_id === memory.id)
      : $("memory-lat").value && $("memory-lng").value
        ? {
            lat: Number($("memory-lat").value),
            lng: Number($("memory-lng").value),
            label: $("memory-place").value,
          }
        : null;
    $("location-label").value = point?.label || "";
    $("location-dialog").showModal();
    if (!window.L) {
      V.message(
        "location-message",
        "Peta belum termuat. Isi koordinat secara manual.",
      );
      return;
    }
    if (!picker) {
      picker = L.map("location-map", { scrollWheelZoom: false });
      tiles(picker);
      picker.on("click", (e) => pick(e.latlng));
    }
    const center = point || { lat: -6.2, lng: 106.85 };
    picker.setView([center.lat, center.lng], 13);
    picker.invalidateSize();
    picked = null;
    $("location-preview").textContent =
      "Ketuk peta untuk memilih titik atau isi koordinat di bawah.";
    if (pickMarker) {
      picker.removeLayer(pickMarker);
      pickMarker = null;
    }
    if (point) pick(point);
  }
  $("location-pick").onclick = () => openLocation();
  $("location-form").onsubmit = (event) => {
    event.preventDefault();
    V.formAction(event.currentTarget, "location-message", async () => {
      const point = {
        lat: Number($("location-lat").value),
        lng: Number($("location-lng").value),
        label: $("location-label").value.trim(),
      };
      if (locationMemory) {
        await saveLocation(locationMemory.id, point);
        V.toast("Lokasi tersimpan. Lihat peta kenangan untuk membukanya.");
      } else {
        $("memory-lat").value = point.lat;
        $("memory-lng").value = point.lng;
        $("memory-place").value = point.label;
      }
      $("location-dialog").close();
      $(locationMemory ? "memory-location" : "location-pick").focus({
        preventScroll: true,
      });
    });
  };
  $("location-current").onclick = () => {
    if (!navigator.geolocation) {
      V.toast("Perangkat ini belum mendukung lokasi. Pilih titik di peta.");
      return;
    }
    $("location-current").disabled = true;
    navigator.geolocation.getCurrentPosition(
      (p) => {
        if (state.user) {
          $("memory-lat").value = p.coords.latitude.toFixed(6);
          $("memory-lng").value = p.coords.longitude.toFixed(6);
          V.toast("Lokasi sekarang terisi. Periksa sebelum menyimpan.");
        }
        $("location-current").disabled = false;
      },
      () => {
        $("location-current").disabled = false;
        V.toast(
          "Lokasi belum diizinkan atau tidak tersedia. Pilih titik di peta.",
        );
      },
      { timeout: 10000, maximumAge: 60000 },
    );
  };
  $("location-clear").onclick = () =>
    ["memory-place", "memory-lat", "memory-lng"].forEach(
      (id) => ($(id).value = ""),
    );
  $("map-details").addEventListener("toggle", renderMap);
  document.addEventListener("cmv:page", () => {
    if (window.VaultPages.current === "kenangan") renderMap();
  });
  for (const dir of [-1, 1])
    $(dir < 0 ? "calendar-prev" : "calendar-next").onclick = () => {
      const [y, m] = month.split("-").map(Number),
        d = new Date(Date.UTC(y, m - 1 + dir, 1));
      month = d.toISOString().slice(0, 7);
      selected = month + "-01";
      renderCalendar();
    };
  $("calendar-add").onclick = () => openEvent();
  $("calendar-form").addEventListener("submit", (e) => {
    e.preventDefault();
    V.formAction(e.currentTarget, "calendar-message", () => saveEvent());
  });
  $("calendar-delete").onclick = async () => {
    if (
      await confirmAction(
        "Hapus rencana ini dari kalender bersama?",
        "Hapus rencana",
      )
    )
      V.formAction($("calendar-form"), "calendar-message", () =>
        saveEvent(true),
      );
  };
  for (const kind of ["journal", "letter"]) {
    capsuleUI(kind);
    $(kind + "-capsule").onchange = () => {
      capsuleUI(kind);
      scheduleDraft(kind);
    };
    $(kind + "-form").addEventListener("input", () => scheduleDraft(kind));
  }
  $("sync-now").onclick = () => sync(true).then(() => V.refresh());
  $("drafts-open").onclick = () => {
    $("sync-dialog").close();
    $("drafts-dialog").showModal();
    renderDrafts().catch((e) => V.toast(V.errorText(e)));
  };
  document.addEventListener("cmv:storage-error", () => {
    storageError = true;
    status();
  });
  document.addEventListener("cmv:ready", async () => {
    const epoch = state.epoch;
    try {
      for (const d of await local.list("draft")) {
        if (!V.alive(epoch)) return;
        await applyDraft(d);
      }
      await sync();
      await status();
    } catch {
      storageError = true;
      status();
    }
  });
  document.addEventListener("cmv:locked", () => {
    for (const t of draftTimers.values()) clearTimeout(t);
    draftTimers.clear();
    draftIds.clear();
    draftDays.clear();
    draftTitles.clear();
    entries = [];
    shared = { events: [], locations: [], reactions: [] };
    jobs = [];
    selected = "";
    month = "";
    lastError = "";
    storageError = false;
    lastStatusKey = previousStatus = null;
    if (map) map.remove();
    if (picker) picker.remove();
    map = null;
    picker = null;
    pins = null;
    pickMarker = null;
    offlineTiles.clear();
    [
      "calendar-days",
      "calendar-agenda",
      "map-list",
      "drafts-list",
      "queue-list",
      "letter-reactions",
    ].forEach((id) => $(id).replaceChildren());
  });
  function tileNetwork() {
    for (const { target, layer } of offlineTiles) {
      if (navigator.onLine && !target.hasLayer(layer)) layer.addTo(target);
      if (!navigator.onLine && target.hasLayer(layer))
        target.removeLayer(layer);
    }
    renderMap();
  }
  window.addEventListener("online", tileNetwork);
  window.addEventListener("offline", tileNetwork);
  window.addEventListener("focus", () => {
    if (state.user && navigator.onLine) sync();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden)
      for (const kind of draftTimers.keys()) {
        clearTimeout(draftTimers.get(kind));
        draftTimers.delete(kind);
        storeDraft(kind);
      }
  });
  navigator.serviceWorker?.addEventListener("message", (event) => {
    if (event.data?.type === "SYNC_OUTBOX") sync();
  });
  setInterval(() => {
    if (state.user && !document.hidden && navigator.onLine)
      sync().then(() => V.refresh());
  }, 30000);
  window.VaultFeatures = {
    load,
    sync,
    status,
    today,
    saveEntry,
    reactionBar,
    paintReactions,
    renderMap,
    locationData,
    saveLocation,
    confirmAction,
    openLocation,
    formDone(id) {
      if (id === "journal-form" || id === "letter-form")
        capsuleUI(id.split("-")[0]);
    },
    get journalDraft() {
      return draftDays.has("journal")
        ? {
            date: draftDays.get("journal"),
            question: draftTitles.get("journal"),
          }
        : null;
    },
    get entries() {
      return entries;
    },
    get unsaved() {
      return !!draftTimers.size || writing > 0;
    },
    async canLock() {
      if (syncing) {
        V.toast("Tunggu pengiriman selesai sebelum mengunci.");
        return false;
      }
      for (const kind of draftTimers.keys()) {
        clearTimeout(draftTimers.get(kind));
        draftTimers.delete(kind);
        await storeDraft(kind);
      }
      const drafts = await local.list("draft").catch(() => []),
        queue = await local.list("queue").catch(() => []);
      return confirmAction(
        drafts.length || queue.length
          ? `Ada ${drafts.length} draf dan ${queue.length} perubahan belum terkirim. Kunci & keluar akan menghapus salinan lokal ini. Kembali untuk menyinkronkannya dahulu.`
          : "Kunci & keluar? Salinan arsip di perangkat ini akan dihapus. Cerita yang sudah terkirim tetap tersimpan.",
        "Kunci & keluar",
      );
    },
  };
})();
