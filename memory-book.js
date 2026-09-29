/* A4 scrapbook renderer. One canvas at a time; original photos stay private. */
(function (root) {
  "use strict";
  const WIDTH = 1600, HEIGHT = 2263, MARGIN = 112, BOTTOM = 2060;
  let loading;
  async function dependency() {
    if (root.PDFLib) return root.PDFLib;
    if (!loading) loading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL("vendor/pdf-lib.min.js", document.baseURI).href;
      script.onload = () => resolve(root.PDFLib);
      script.onerror = () => { loading = null; script.remove(); reject(Error("Pembuat PDF belum termuat. Sambungkan internet lalu coba lagi.")); };
      document.head.append(script);
    });
    return loading;
  }
  function wrap(ctx, value, width) {
    const lines = [];
    for (const paragraph of String(value || "").replace(/\r\n?/g, "\n").split("\n")) {
      if (!paragraph) { lines.push(""); continue; }
      let line = "";
      for (const word of paragraph.split(/\s+/u)) {
        const candidate = line ? `${line} ${word}` : word;
        if (ctx.measureText(candidate).width <= width) { line = candidate; continue; }
        if (line) { lines.push(line); line = ""; }
        for (const character of Array.from(word)) {
          if (line && ctx.measureText(line + character).width > width) { lines.push(line); line = ""; }
          line += character;
        }
      }
      lines.push(line);
    }
    return lines;
  }
  const date = value => new Intl.DateTimeFormat("id-ID", {day: "numeric", month: "long", year: "numeric", timeZone: "UTC"}).format(new Date(`${value}T12:00:00Z`));
  async function create(options) {
    const {items, title, from, to, image, active = () => true, progress = () => {}} = options;
    const PDF = options.pdfLib || await dependency(), doc = await PDF.PDFDocument.create();
    doc.setTitle(`Buku Kenangan - ${title}`); doc.setAuthor(title); doc.setLanguage("id-ID");
    doc.setSubject(`${from} - ${to}`); doc.setCreator("Couple Memory Vault");
    const canvas = options.createCanvas ? options.createCanvas(WIDTH, HEIGHT) : document.createElement("canvas");
    canvas.width = WIDTH; canvas.height = HEIGHT;
    const ctx = canvas.getContext("2d"), contentWidth = WIDTH - MARGIN * 2;
    let number = 0;
    const check = () => { if (!active()) throw Error("Pembuatan dibatalkan."); };
    function base(kicker) {
      check(); ctx.fillStyle = "#fcf7ef"; ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.strokeStyle = "#dacbbb"; ctx.lineWidth = 2; ctx.strokeRect(54, 54, WIDTH - 108, HEIGHT - 108);
      ctx.fillStyle = "#83536a"; ctx.font = "500 26px sans-serif";
      ctx.fillText(kicker.toUpperCase(), MARGIN, 141);
      ctx.fillStyle = "#3c2d36";
    }
    function lines(text, y, size = 36, family = "sans-serif", weight = "400") {
      ctx.font = `${weight} ${size}px ${family}`;
      const result = wrap(ctx, text, contentWidth);
      for (const value of result) { ctx.fillText(value, MARGIN, y); y += size * 1.48; }
      return y;
    }
    async function save() {
      check(); if (++number > 120) throw Error("Buku lebih dari 120 halaman. Pilih rentang tanggal yang lebih pendek.");
      ctx.fillStyle = "#715663"; ctx.font = "25px sans-serif";
      ctx.fillText("COUPLE MEMORY VAULT", MARGIN, HEIGHT - 120);
      ctx.textAlign = "right"; ctx.fillText(String(number).padStart(2, "0"), WIDTH - MARGIN, HEIGHT - 120); ctx.textAlign = "left";
      const bytes = options.jpeg ? await options.jpeg(canvas) : new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .91))).arrayBuffer());
      check(); const embedded = await doc.embedJpg(bytes);
      doc.addPage([595.28, 841.89]).drawImage(embedded, {x: 0, y: 0, width: 595.28, height: 841.89});
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    base("Sebuah buku untuk kita");
    ctx.fillStyle = "#f0dbe3"; ctx.fillRect(MARGIN, 340, contentWidth, 1000);
    ctx.fillStyle = "#4b3040";
    let y = lines("Kenangan yang\ningin kita simpan", 530, 94, "serif", "600");
    y = lines(title, y + 120, 60, "serif");
    lines(`${date(from)}\nsampai ${date(to)}`, Math.max(1470, y + 180), 34);
    lines(`${items.length} catatan, dirangkai dari perjalanan kita.`, 1930, 30);
    await save();
    for (let i = 0; i < items.length; i++) {
      check(); const item = items[i]; progress(`Menyusun catatan ${i + 1} dari ${items.length}…`);
      const kind = {image: "Foto", video: "Kenangan video", voice_note: "Pesan Suara", journal: "Jurnal"}[item.kind] || "Kenangan";
      base(`${kind} / ${date(item.occurred_on)}`);
      y = lines(item.title, 260, 60, "serif", "600") + 44;
      if (item.kind === "image") {
        const photo = await image(item); check();
        const w = photo.naturalWidth || photo.width, h = photo.naturalHeight || photo.height;
        if (!w || !h) throw Error(`Foto “${item.title}” belum dapat dibaca.`);
        const boxHeight = Math.min(1050, BOTTOM - y - 180), photoWidth = contentWidth - 44;
        if (boxHeight < 150) { await save(); base(`${kind} / ${date(item.occurred_on)}`); y = 240; }
        const availableHeight = Math.min(1050, BOTTOM - y - 180);
        const scale = Math.min(photoWidth / w, availableHeight / h);
        const dw = w * scale, dh = h * scale;
        ctx.fillStyle = "#e6ddce"; ctx.fillRect(MARGIN + 10, y + 12, contentWidth, dh + 64);
        ctx.fillStyle = "#fffefd"; ctx.fillRect(MARGIN, y, contentWidth, dh + 64);
        ctx.drawImage(photo, MARGIN + (contentWidth - dw) / 2, y + 22, dw, dh);
        ctx.fillStyle = "#3c2d36"; y += dh + 132;
      } else if (item.kind === "voice_note" || item.kind === "video") {
        ctx.fillStyle = "#e1e9df"; ctx.fillRect(MARGIN, y, contentWidth, 180);
        ctx.fillStyle = "#3c5142"; lines(item.kind === "voice_note" ? "Suaramu tersimpan di ruang kenangan kita." : "Momen bergerak ini tersimpan di ruang kenangan kita.", y + 62, 32);
        ctx.fillStyle = "#3c2d36"; y += 248;
      }
      ctx.font = "36px sans-serif";
      const text = wrap(ctx, item.body, contentWidth);
      for (const line of text) {
        if (y + 54 > BOTTOM) { await save(); base(`${kind} / lanjutan`); y = 260; ctx.font = "36px sans-serif"; }
        ctx.fillText(line, MARGIN, y); y += 54;
      }
      await save();
    }
    check(); progress("Menyiapkan file PDF…");
    const bytes = await doc.save(); canvas.width = canvas.height = 1; check(); return bytes;
  }
  const api = {create, wrap, WIDTH, HEIGHT};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MemoryBook = api;
})(typeof window !== "undefined" ? window : globalThis);
