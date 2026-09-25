/* Progressive multi-page navigation. Real HTML entry points + one persistent audio shell.
   Page DOM is retained off-document, so drafts/listeners survive without hidden long pages. */
(() => {
  "use strict";
  const routes = Object.freeze({
    utama: { path: "", title: "Utama" },
    kenangan: { path: "kenangan/", title: "Rak Kenangan" },
    jurnal: { path: "jurnal/", title: "Jurnal Harian" },
    impian: { path: "impian/", title: "Impian Kita" },
    surat: { path: "surat/", title: "Surat Cinta" },
  });
  const base = new URL(document.baseURI);
  // A relative <base> would otherwise move when pushState changes the pathname.
  document.querySelector("base").href = base.href;
  const outlet = document.getElementById("page-outlet");
  const views = new Map([
    [document.body.dataset.page, outlet.firstElementChild],
  ]);
  const titles = Object.fromEntries(
    Object.entries(routes).map(([id, r]) => [
      id,
      `${r.title} · Couple Memory Vault`,
    ]),
  );
  const legacy = {
    "#memories-section": "kenangan",
    "#journal-section": "jurnal",
    "#dreams-section": "impian",
    "#letters-section": "surat",
    "#reply-panel": "surat",
  };
  let current = document.body.dataset.page,
    sequence = 0,
    animation,
    booting = false,
    started = false;
  const loadedScripts = new Set();
  const navigation = document.querySelector(".section-nav");
  if ("ResizeObserver" in window) new ResizeObserver(() => {
    const height = navigation.getBoundingClientRect().height;
    if (height > 0) document.documentElement.style.setProperty("--bottom-nav-height", `${height}px`);
  }).observe(navigation);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  function all(selector) {
    const found = [...document.querySelectorAll(selector)];
    for (const view of views.values()) {
      if (view.isConnected) continue;
      if (view.matches(selector)) found.push(view);
      found.push(...view.querySelectorAll(selector));
    }
    return found;
  }
  function get(id) {
    return document.getElementById(id) || all(`#${CSS.escape(id)}`)[0] || null;
  }
  function pageFor(url) {
    if (url.origin !== base.origin) return null;
    for (const [id, route] of Object.entries(routes)) {
      const path = new URL(route.path, base).pathname;
      if (
        [path, path + "index.html", path.replace(/\/$/, "")].includes(
          url.pathname,
        )
      )
        return id;
    }
    return null;
  }
  function markPage() {
    document.title = titles[current];
    document.body.dataset.page = current;
    document.querySelectorAll(".section-nav [data-route]").forEach((link) => {
      if (link.dataset.route === current)
        link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
  }
  function focusPage(id) {
    const target = (id && get(id)) || outlet.querySelector("h1,h2");
    if (!target?.isConnected || get("app-screen").hidden) return;
    if (!target.matches("input,textarea,button,select,a")) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    if (id) target.scrollIntoView({ block: "center", behavior: "instant" });
  }
  async function animate(view, keyframes, duration) {
    if (reduced.matches || !view.animate || get("app-screen").hidden) return;
    animation = view.animate(keyframes, {
      duration,
      easing: "cubic-bezier(.2,.65,.3,1)",
    });
    await animation.finished.catch(() => {});
  }
  async function navigate(page, options = {}) {
    if (!routes[page] || !views.has(page)) return false;
    const ticket = ++sequence;
    animation?.cancel();
    const mode = options.history || "push";
    if (mode !== "none") {
      if (mode === "push")
        history.replaceState({ ...history.state, scrollY }, "");
      const url = new URL(routes[page].path, base);
      if (options.hash) url.hash = options.hash;
      history[mode === "replace" ? "replaceState" : "pushState"](
        { cmvPage: page, scrollY: 0 },
        "",
        url,
      );
    }
    outlet.inert = true;
    outlet.setAttribute("aria-busy", "true");
    try {
      if (page !== current) {
        await animate(
          views.get(current),
          [
            { opacity: 1, transform: "scale(1)" },
            { opacity: 0, transform: "scale(.99)" },
          ],
          180,
        );
        if (ticket !== sequence) return false;
        outlet.replaceChildren(views.get(page));
        current = page;
      }
      markPage();
      window.scrollTo({ top: options.scrollY ?? 0, behavior: "instant" });
      document.dispatchEvent(new CustomEvent("cmv:page", { detail: { page } }));
      await animate(
        views.get(page),
        [
          { opacity: 0, transform: "scale(.985)" },
          { opacity: 1, transform: "scale(1)" },
        ],
        320,
      );
      if (ticket !== sequence) return false;
      outlet.inert = false;
      focusPage(options.focusId);
      get("route-status").textContent = `Halaman ${routes[page].title}`;
      return true;
    } finally {
      if (ticket === sequence) {
        outlet.inert = false;
        outlet.removeAttribute("aria-busy");
      }
    }
  }
  window.VaultPages = {
    get,
    all,
    query: (s) => all(s)[0] || null,
    navigate,
    base: base.href,
    get current() {
      return current;
    },
  };
  async function preload(page) {
    if (views.has(page)) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const url = new URL(routes[page].path + "index.html", base);
      const response = await fetch(url, {
        signal: controller.signal,
        credentials: "same-origin",
      });
      if (!response.ok)
        throw Error(
          `Halaman ${routes[page].title} belum tersedia (${response.status}).`,
        );
      const parsed = new DOMParser().parseFromString(
        await response.text(),
        "text/html",
      );
      const view = parsed.getElementById("route-view");
      if (
        view?.dataset.page !== page ||
        parsed.querySelector('meta[name="cmv-build"]')?.content !== "v5.1"
      )
        throw Error(
          `Berkas halaman ${routes[page].title} belum cocok. Salin seluruh isi paket versi 5.1.`,
        );
      views.set(page, document.importNode(view, true));
    } finally {
      clearTimeout(timeout);
    }
  }
  function script(name) {
    if (loadedScripts.has(name)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = new URL(name, base).href;
      el.onload = () => {
        loadedScripts.add(name);
        resolve();
      };
      el.onerror = () => {
        el.remove();
        reject(
          Error(`Berkas ${name} belum termuat. Pastikan semua file disalin.`),
        );
      };
      document.head.append(el);
    });
  }
  async function boot() {
    if (booting || started) return;
    booting = true;
    get("boot-retry").hidden = true;
    get("boot-message").textContent = "Menyiapkan halaman cerita kita…";
    try {
      if (location.protocol === "file:")
        throw Error(
          "Buka folder ini melalui Live Server di VS Code, bukan klik dua kali index.html.",
        );
      // Small static markup is prepared once so the established controllers keep their
      // DOM references. Only the active view is ever mounted/rendered in the outlet.
      await Promise.all(Object.keys(routes).map(preload));
      all("form").forEach((form) => {
        form.noValidate = true;
      });
      for (const name of ["main.js", "features.js", "admin.js"])
        await script(name);
      if (!window.Vault || !window.VaultFeatures)
        throw Error(
          "Modul aplikasi belum lengkap. Pastikan seluruh paket versi 5.1 sudah disalin, lalu muat ulang.",
        );
      started = true;
      get("content").inert = false;
      get("boot-status").hidden = true;
      markPage();
      history.scrollRestoration = "manual";
      const legacyPage = legacy[location.hash];
      if (legacyPage)
        await navigate(legacyPage, {
          history: "replace",
          focusId: location.hash.slice(1),
        });
      else history.replaceState({ cmvPage: current, scrollY: 0 }, "");
      document.dispatchEvent(new CustomEvent("cmv:booted"));
    } catch (error) {
      get("boot-message").textContent =
        error.name === "AbortError"
          ? "Berkas halaman belum selesai dimuat. Periksa koneksi atau kelengkapan folder, lalu coba lagi."
          : error.message;
      get("boot-retry").hidden = false;
    } finally {
      booting = false;
    }
  }
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href]");
    if (
      !link ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      link.download ||
      (link.target && link.target !== "_self")
    )
      return;
    if (link.hasAttribute("data-skip")) {
      event.preventDefault();
      if (get("app-screen").hidden) get("viewer-password").focus();
      else focusPage();
      return;
    }
    const url = new URL(link.href);
    const page = link.dataset.route || legacy[url.hash] || pageFor(url);
    if (
      !started ||
      !page ||
      (url.hash && !legacy[url.hash] && !link.dataset.route)
    )
      return;
    event.preventDefault();
    navigate(page, { hash: url.hash, focusId: url.hash.slice(1) });
  });
  window.addEventListener("popstate", (event) => {
    if (!started) return;
    const page = pageFor(new URL(location.href));
    if (page)
      navigate(page, {
        history: "none",
        scrollY: event.state?.scrollY ?? 0,
        focusId: location.hash.slice(1),
      });
  });
  document.addEventListener("cmv:ready", () => focusPage());
  document.addEventListener("cmv:locked", () => {
    ++sequence;
    animation?.cancel();
    outlet.inert = false;
    outlet.removeAttribute("aria-busy");
  });
  get("boot-retry").addEventListener("click", boot);
  boot();
})();
