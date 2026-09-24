/* Penyimpanan per akun/proyek. Token autentikasi tidak disalin ke IndexedDB. */
(() => {
  "use strict";
  const project = new URL(window.VAULT_CONFIG.SUPABASE_URL).hostname;
  let active = null,
    generation = 0,
    opening;
  const DB_NAME = `cmv-offline-v1-${project}`;
  const MAX_MEDIA = 50 * 1024 * 1024;
  function open() {
    if (!opening)
      opening = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const s = req.result.createObjectStore("records", { keyPath: "key" });
          s.createIndex("account", "account");
        };
        req.onsuccess = () => {
          req.result.onversionchange = () => req.result.close();
          resolve(req.result);
        };
        req.onerror = () => {
          opening = null;
          reject(req.error);
        };
        req.onblocked = () =>
          reject(
            new Error("Tutup tab lama agar penyimpanan luring bisa dibuka."),
          );
      });
    return opening;
  }
  function identity() {
    if (!active) throw new Error("Buka akunmu dahulu.");
    return { account: active, generation };
  }
  async function access(mode, fn, id = identity()) {
    const db = await open();
    if (id.account !== active || id.generation !== generation)
      throw new Error("Sesi sudah dikunci.");
    return new Promise((resolve, reject) => {
      const tx = db.transaction("records", mode);
      let result;
      try {
        const req = fn(tx.objectStore("records"), id.account);
        if (req)
          req.onsuccess = () => {
            result = req.result;
          };
      } catch (e) {
        tx.abort();
        reject(e);
        return;
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(tx.error || new Error("Penyimpanan lokal dibatalkan."));
    });
  }
  const get = async (kind, key) =>
    (await access("readonly", (s, a) => s.get(`${a}:${kind}:${key}`)))?.value;
  const put = (kind, key, value) =>
    access("readwrite", (s, a) =>
      s.put({
        key: `${a}:${kind}:${key}`,
        account: a,
        kind,
        value,
        updated: Date.now(),
      }),
    );
  const remove = (kind, key) =>
    access("readwrite", (s, a) => s.delete(`${a}:${kind}:${key}`));
  async function records(kind) {
    return (
      await access("readonly", (s, a) => s.index("account").getAll(a))
    ).filter((r) => !kind || r.kind === kind);
  }
  async function list(kind) {
    return (await records(kind)).map((r) => r.value);
  }
  function networkError(e) {
    return (
      !navigator.onLine ||
      /fetch|network|timeout|abort|load failed/i.test(String(e?.message || e))
    );
  }
  async function cached(key, action) {
    const id = identity();
    if (!navigator.onLine) {
      const value = await get("cache", key);
      if (value === undefined)
        throw new Error(
          "Arsip ini belum tersimpan di perangkat. Buka sekali saat online.",
        );
      return value;
    }
    try {
      const value = await action();
      if (id.account !== active || id.generation !== generation)
        throw new Error("Sesi sudah dikunci.");
      try {
        await put("cache", key, value);
      } catch {
        document.dispatchEvent(new CustomEvent("cmv:storage-error"));
      }
      return value;
    } catch (e) {
      if (networkError(e)) {
        const value = await get("cache", key);
        if (value !== undefined) return value;
      }
      throw e;
    }
  }
  async function media(path, fetchBlob) {
    const id = identity();
    const old = await get("media", path).catch(() => null);
    if (old) return old;
    if (!navigator.onLine)
      throw new Error(
        "Media ini belum disimpan luring. Sambungkan internet untuk membukanya.",
      );
    const blob = await fetchBlob();
    if (id.account !== active || id.generation !== generation)
      throw new Error("Sesi sudah dikunci.");
    // Batasi media besar agar ruang draf tidak habis. Video besar tetap online.
    if (blob.size <= 8 * 1024 * 1024) {
      try {
        const all = (await records("media")).sort(
          (a, b) => a.updated - b.updated,
        );
        let size = all.reduce((n, r) => n + r.value.size, 0) + blob.size;
        for (const r of all) {
          if (size <= MAX_MEDIA) break;
          await remove("media", r.key.split(":media:")[1]);
          size -= r.value.size;
        }
        await put("media", path, blob);
      } catch {
        /* Membaca online masih tersedia ketika kuota media habis. */
      }
    }
    return blob;
  }
  async function purge() {
    if (!active) return;
    const id = identity();
    await access(
      "readwrite",
      (s, a) => {
        const req = s.index("account").openKeyCursor(IDBKeyRange.only(a));
        req.onsuccess = () => {
          const c = req.result;
          if (c) {
            s.delete(c.primaryKey);
            c.continue();
          }
        };
      },
      id,
    );
  }
  async function wake() {
    try {
      const r = await navigator.serviceWorker?.getRegistration();
      if (r?.sync) await r.sync.register("cmv-outbox");
    } catch {
      /* Safari/Firefox memakai online, focus, dan pembukaan aplikasi. */
    }
  }
  window.VaultLocal = {
    get,
    put,
    remove,
    list,
    cached,
    media,
    purge,
    wake,
    networkError,
    use(account) {
      if (active !== account) {
        active = account;
        generation++;
      }
    },
    release() {
      active = null;
      generation++;
    },
    get account() {
      return active;
    },
  };
})();