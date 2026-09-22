/* Isi HANYA tiga nilai pertama. File ini terlihat oleh pengunjung. */
window.VAULT_CONFIG = Object.freeze({
  SUPABASE_URL: "https://kukwahhnhlmygybhsijm.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_AVRGLnlvfTrI-mhH9fM7kw_oytDf6pv",
  VIEWER_EMAIL: "nidaamiroh2004@gmail.com",
  BUCKET: "couple-vault",
  MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
  PAGE_SIZE: 24,
  SESSION_KEY: "cmv-auth-session-v1",
});

(() => {
  const c = window.VAULT_CONFIG;
  window.vaultClient = null;
  window.vaultConfigError = "";
  try {
    if (
      c.SUPABASE_URL.includes("GANTI_") ||
      c.SUPABASE_PUBLISHABLE_KEY.includes("GANTI_")
    ) {
      throw new Error(
        "Isi URL proyek, publishable key, dan email pasangan di supabase-config.js terlebih dahulu.",
      );
    }
    if (c.SUPABASE_PUBLISHABLE_KEY.startsWith("sb_secret_")) {
      throw new Error("Gunakan publishable key, bukan secret key.");
    }
    if (c.SUPABASE_PUBLISHABLE_KEY.startsWith("eyJ")) {
      // Dukungan anon key lama; tolak service_role yang tidak boleh dikirim ke browser.
      const payload = JSON.parse(
        atob(
          c.SUPABASE_PUBLISHABLE_KEY.split(".")[1]
            .replace(/-/g, "+")
            .replace(/_/g, "/"),
        ),
      );
      if (payload.role !== "anon")
        throw new Error(
          "Hanya publishable key atau anon key yang boleh dipakai.",
        );
    }
    if (!window.supabase)
      throw new Error(
        "Supabase belum termuat. Periksa internet, lalu muat ulang halaman.",
      );
    window.vaultClient = window.supabase.createClient(
      c.SUPABASE_URL,
      c.SUPABASE_PUBLISHABLE_KEY,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
          storage: window.sessionStorage,
          storageKey: c.SESSION_KEY,
        },
        global: {
          fetch: async (input, options = {}) => {
            const controller = new AbortController();
            const forwardAbort = () => controller.abort();
            if (options.signal?.aborted) controller.abort();
            options.signal?.addEventListener("abort", forwardAbort, {
              once: true,
            });
            const isUpload =
              String(input).includes("/storage/v1/object") &&
              options.method === "POST";
            const timer = setTimeout(
              () => controller.abort(),
              isUpload ? 180000 : 30000,
            );
            try {
              return await fetch(input, {
                ...options,
                cache: "no-store",
                signal: controller.signal,
              });
            } finally {
              clearTimeout(timer);
              options.signal?.removeEventListener("abort", forwardAbort);
            }
          },
        },
      },
    );
  } catch (error) {
    window.vaultConfigError = error.message;
  }
})();