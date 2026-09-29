/* Pure helpers shared by upload, filters and offline tests. No network or DOM. */
(function (root) {
  "use strict";
  function normalizeTags(value) {
    const parts = Array.isArray(value) ? value : String(value || "").split(/[\s,]+/u);
    const tags = [...new Set(parts.map(t => String(t).normalize("NFC").replace(/^#+/, "").trim().toLowerCase()).filter(Boolean))];
    if (tags.length > 8) throw Error("Pilih maksimal delapan label.");
    if (tags.some(t => Array.from(t).length > 32 || !/^[\p{L}\p{N}_-]+$/u.test(t)))
      throw Error("Label maksimal 32 karakter: huruf, angka, garis bawah, atau tanda hubung.");
    return tags.sort();
  }
  function audioType(kind, purpose) { return kind === "audio" ? (purpose === "music" ? "music" : "voice_note") : kind; }
  function archiveMatch(memory, filters = {}) {
    return (!memory.type || ["image", "video", "voice_note"].includes(memory.type)) &&
      (!filters.tag || (memory.tags || []).includes(filters.tag)) && (!filters.kind || memory.type === filters.kind);
  }
  function gpsFromExif(buffer) {
    try {
      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const str = (p, n) => String.fromCharCode(...bytes.subarray(p, p + n));
      let start = -1, end = bytes.length;
      if (d.getUint16(0) === 0xffd8) {
        let p = 2;
        while (p + 4 <= end) {
          if (bytes[p] !== 0xff) break;
          const marker = bytes[p + 1];
          if (marker === 0xda || marker === 0xd9) break;
          const size = d.getUint16(p + 2);
          if (size < 2 || p + size + 2 > end) break;
          if (marker === 0xe1 && str(p + 4, 6) === "Exif\0\0") { start = p + 10; end = p + size + 2; break; }
          p += size + 2;
        }
      } else if (str(0, 4) === "RIFF" && str(8, 4) === "WEBP") {
        for (let p = 12; p + 8 <= end;) {
          const size = d.getUint32(p + 4, true);
          if (p + 8 + size > end) break;
          if (str(p, 4) === "EXIF") { start = p + 8; end = start + size; if (str(start, 6) === "Exif\0\0") start += 6; break; }
          p += 8 + size + (size % 2);
        }
      } else if (str(1, 3) === "PNG") {
        for (let p = 8; p + 12 <= end;) {
          const size = d.getUint32(p);
          if (p + 12 + size > end) break;
          if (str(p + 4, 4) === "eXIf") { start = p + 8; end = start + size; break; }
          p += size + 12;
        }
      }
      if (start < 0 || start + 8 > end) return null;
      const order = str(start, 2), little = order === "II";
      if (!["II", "MM"].includes(order)) return null;
      const valid = (p, n) => Number.isSafeInteger(p) && p >= start && p + n <= end;
      const u16 = p => { if (!valid(p, 2)) throw Error(); return d.getUint16(p, little); };
      const u32 = p => { if (!valid(p, 4)) throw Error(); return d.getUint32(p, little); };
      if (u16(start + 2) !== 42) return null;
      function entries(offset) {
        const p = start + offset, count = u16(p);
        if (count > 512 || !valid(p + 2, count * 12)) throw Error();
        return Array.from({length: count}, (_, i) => p + 2 + i * 12);
      }
      const gps = entries(u32(start + 4)).find(p => u16(p) === 0x8825 && u16(p + 2) === 4 && u32(p + 4) === 1);
      if (gps === undefined) return null;
      const tags = new Map(entries(u32(gps + 8)).map(p => [u16(p), p]));
      function ref(id) {
        const p = tags.get(id);
        return p !== undefined && u16(p + 2) === 2 && u32(p + 4) === 2 ? str(p + 8, 1) : "";
      }
      function deg(id) {
        const p = tags.get(id);
        if (p === undefined || u16(p + 2) !== 5 || u32(p + 4) !== 3) throw Error();
        const at = start + u32(p + 8);
        const n = [0, 8, 16].map(i => u32(at + i) / u32(at + i + 4));
        if (n.some(x => !Number.isFinite(x)) || n[1] >= 60 || n[2] >= 60) throw Error();
        return n[0] + n[1] / 60 + n[2] / 3600;
      }
      const ns = ref(1), ew = ref(3);
      if (!["N", "S"].includes(ns) || !["E", "W"].includes(ew)) return null;
      const lat = deg(2) * (ns === "S" ? -1 : 1), lng = deg(4) * (ew === "W" ? -1 : 1);
      return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? {lat, lng} : null;
    } catch { return null; }
  }
  const api = {normalizeTags, audioType, archiveMatch, gpsFromExif};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MemoryCore = api;
})(typeof window !== "undefined" ? window : globalThis);
