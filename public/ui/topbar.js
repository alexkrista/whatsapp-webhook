"use strict";

(function () {
  const BRAIN_URL = "https://pc-alex02.tail610122.ts.net/";

  const WORLDS = [
    { key: "kristower", label: "KRISTOWER", icon: "⌂", href: "/kontrollzentrum", subtitle: "Überblick, Führung und Entscheidungen" },
    { key: "kriszeit", label: "KRISZEIT", icon: "⏱", href: "/kristool-preview/", subtitle: "Zeitkontrolle, Auswertung und Finkzeit" },
    { key: "brain", label: "THE BRAIN", icon: "🧠", href: BRAIN_URL, external: true, subtitle: "Firmenwissen, Projekte, Dokumente und Rechnungen" },
    { key: "farben", label: "LG", icon: "🎨", href: "/admin/paint?scan=1", subtitle: "Little Greene · Farbsuche, Mischrezepte, Lager und Bestellung" },
    { key: "kristine", label: "KRISTINE", icon: "✦", href: "/kristine#planning", subtitle: "Planung und Leitstand" },
    { key: "krisadmin", label: "KRISADMIN", icon: "⚙", href: "/admin/ui", subtitle: "Mitarbeiter, Fahrzeuge und Stammdaten" },
    { key: "tasks", label: "AUFGABEN", icon: "📌", href: "/kristine#tasks", subtitle: "Offene Aufgaben und Erinnerungen" }
  ];

  function tokenized(href, external = false) {
    const url = new URL(href, window.location.origin);
    if (external || url.origin !== window.location.origin) return url.href;
    const token = new URLSearchParams(window.location.search).get("token");
    if (token) url.searchParams.set("token", token);
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function inferActive() {
    const pathname = window.location.pathname.toLowerCase();
    const hash = window.location.hash.toLowerCase();
    if (hash === "#tasks") return "tasks";
    if (hash === "#schedules") return "kriszeit";
    if (pathname.includes("kristool-preview")) return "kriszeit";
    if (pathname.includes("kontrollzentrum")) return "kristower";
    if (pathname.includes("/admin/paint")) return "farben";
    if (pathname.includes("/admin")) return "krisadmin";
    if (pathname.includes("/kristine")) return "kristine";
    return "kristine";
  }

  function normalizeActive(value) {
    const raw = String(value || "").toLowerCase();
    if (raw === "kristool") return "kriszeit";
    if (raw === "krisplan") return "kristine";
    return raw;
  }

  function activeForLocation(configured) {
    const hash = window.location.hash.toLowerCase();
    if (hash === "#tasks") return "tasks";
    if (hash === "#schedules") return "kriszeit";
    return normalizeActive(configured) || inferActive();
  }

  function activateKristineHash() {
    const pathname = window.location.pathname.toLowerCase();
    if (!pathname.includes("/kristine") || typeof window.showTab !== "function") return;
    const hash = window.location.hash.replace("#", "").toLowerCase();
    const allowed = ["planning", "control", "sites", "tasks", "schedules", "kristool"];
    if (hash && allowed.includes(hash)) {
      window.showTab(hash);
      return;
    }
    window.showTab("planning");
  }

  function cleanKristineModuleNav() {
    const pathname = window.location.pathname.toLowerCase();
    if (!pathname.includes("/kristine")) return;
    const nav = document.querySelector(".krista-module-nav");
    if (!nav) return;
    nav.querySelectorAll("button").forEach((button) => {
      const text = String(button.textContent || "").toLowerCase();
      const remove = text.includes("kristool") || text.includes("aufgaben") || text.includes("zeitmodelle") || text.includes("urlaub") || text.includes("feiertage") || text.includes("baustellen");
      if (remove) button.remove();
    });
  }

  function cleanAdminModuleNav() {
    const pathname = window.location.pathname.toLowerCase();
    if (!pathname.includes("/admin")) return;
    const nav = document.querySelector(".bar.krista-module-nav");
    if (!nav) return;
    nav.querySelectorAll("button").forEach((button) => {
      const text = String(button.textContent || "").toLowerCase();
      if (text.includes("tagesrapport") || text.includes("chefzentrale")) button.remove();
    });
  }

  function renameKriszeitSurface() {
    const pathname = window.location.pathname.toLowerCase();
    if (!pathname.includes("kristool-preview")) return;
    document.title = document.title.replace(/KRISTOOL/gi, "KRISZEIT");
    document.querySelectorAll(".eyebrow").forEach((el) => {
      if (/kristool/i.test(el.textContent || "")) el.textContent = String(el.textContent || "").replace(/KRISTOOL/gi, "KRISZEIT");
    });
  }

  function loadScriptOnce(src, dataKey) {
    if (document.querySelector(`script[${dataKey}]`)) return;
    const script = document.createElement("script");
    script.src = src;
    script.setAttribute(dataKey, "1");
    script.defer = true;
    document.head.appendChild(script);
  }

  function loadKristineEmployeeSort() {
    if (window.location.pathname.toLowerCase().includes("/kristine")) loadScriptOnce("/public/ui/kristine-employee-sort.js", "data-krista-employee-sort");
  }

  function loadKristinePlanningSidebarFix() {
    if (window.location.pathname.toLowerCase().includes("/kristine")) loadScriptOnce("/public/ui/kristine-planning-sidebar-fix.js", "data-krista-planning-sidebar-fix");
  }

  function loadKristineTaskList() {
    if (window.location.pathname.toLowerCase().includes("/kristine")) loadScriptOnce("/public/ui/kristine-task-list.js?v=20260822-msgreader", "data-krista-task-list");
  }

  function loadKristineInbox() {
    if (window.location.pathname.toLowerCase().includes("/kristine")) loadScriptOnce("/public/ui/kristine-inbox-v2.js?v=20260821-0925", "data-krista-inbox-v2");
  }

  function loadAdminEmployeeDocumentCompleteness() {
    if (window.location.pathname.toLowerCase().includes("/admin")) loadScriptOnce("/public/ui/employee-document-completeness.js", "data-krista-employee-document-completeness");
  }

  function loadAdminEmployeePersonnelFile() {
    if (!window.location.pathname.toLowerCase().includes("/admin")) return;
    try {
      Object.defineProperty(window, "employeeMasters", {
        configurable: true,
        get() { return typeof employeeMasters !== "undefined" ? employeeMasters : []; }
      });
    } catch {}
    loadScriptOnce("/public/ui/admin-employee-personnel-file.js", "data-krista-employee-personnel-file");
  }

  function loadKriszeitToolbar() {
    if (window.location.pathname.toLowerCase().includes("kristool-preview")) loadScriptOnce("/public/ui/kriszeit-toolbar.js", "data-krista-kriszeit-toolbar");
  }

  function loadCurrentBeulen() {
    const path = window.location.pathname.toLowerCase();
    if (path.includes("/admin")) loadScriptOnce("/public/ui/admin-employee-beulen.js", "data-krista-admin-employee-beulen");
    if (path.includes("/kristine")) loadScriptOnce("/public/ui/kristine-beulen.js", "data-krista-kristine-beulen");
    if (path.includes("kristool-preview")) loadScriptOnce("/public/ui/kriszeit-beulen.js", "data-krista-kriszeit-beulen");
  }

  function cleanModuleNavigation() {
    cleanKristineModuleNav();
    cleanAdminModuleNav();
    renameKriszeitSurface();
  }

  function setupMobileMenu(mount, active) {
    const button = mount.querySelector(".krista-mobile-menu");
    const nav = mount.querySelector(".krista-world-nav");
    if (!button || !nav) return;
    const activeWorld = WORLDS.find(item => item.key === active) || WORLDS[0];

    const setOpen = (open) => {
      mount.classList.toggle("menu-open", !!open);
      button.setAttribute("aria-expanded", open ? "true" : "false");
      button.innerHTML = open
        ? '<span aria-hidden="true">×</span><span>Schließen</span>'
        : `<span aria-hidden="true">${activeWorld.icon}</span><span>${activeWorld.label}</span><span aria-hidden="true">▾</span>`;
    };

    button.addEventListener("click", () => setOpen(!mount.classList.contains("menu-open")));
    nav.querySelectorAll("a").forEach(link => link.addEventListener("click", () => setOpen(false)));
    window.addEventListener("resize", () => { if (window.innerWidth > 760) setOpen(false); }, { passive: true });
    setOpen(false);
  }

  function buildTopbar(mount, options = {}) {
    const configured = options.active || mount.dataset.kristaActive || "";
    const active = activeForLocation(configured);
    const build = options.build || mount.dataset.kristaBuild || "0023.23";

    mount.className = "krista-shell-topbar";
    mount.innerHTML = `
      <div class="krista-shell-main">
        <a class="krista-brand" href="${tokenized("/kontrollzentrum")}" aria-label="KRISTA Start">
          <span class="krista-mark" aria-hidden="true">K</span>
          <span class="krista-brand-copy"><strong>KRISTA</strong><small>Einfach. Intuitiv. Gemeinsam.</small></span>
        </a>
        <button class="krista-mobile-menu" type="button" aria-expanded="false" aria-controls="kristaWorldNav"></button>
        <nav id="kristaWorldNav" class="krista-world-nav" aria-label="KRISTA Arbeitswelten">
          ${WORLDS.map((item) => `
            <a class="krista-world-link ${item.key === active ? "active" : ""}" ${item.key === active ? 'aria-current="page"' : ""} href="${tokenized(item.href, item.external)}" ${item.external ? 'rel="noopener"' : ""} title="${item.subtitle}">
              <span class="krista-world-icon" aria-hidden="true">${item.icon}</span><span>${item.label}</span>
            </a>`).join("")}
        </nav>
        <div class="krista-user" aria-label="Angemeldeter Benutzer"><strong>Alexander Krista</strong><small>Build ${build}</small></div>
      </div>`;
    document.body.classList.add("krista-ui");
    setupMobileMenu(mount, active);
  }

  window.createKristaTopbar = function createKristaTopbar(options = {}) {
    const mount = document.getElementById(options.mountId || "kristaTopbar");
    if (mount) buildTopbar(mount, options);
  };

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("#kristaTopbar,[data-krista-topbar]").forEach((mount) => {
      if (mount.dataset.kristaRendered) return;
      mount.dataset.kristaRendered = "1";
      buildTopbar(mount);
    });
    cleanModuleNavigation();
    loadKristineEmployeeSort();
    loadKristinePlanningSidebarFix();
    loadKristineTaskList();
    loadKristineInbox();
    loadAdminEmployeeDocumentCompleteness();
    loadAdminEmployeePersonnelFile();
    loadKriszeitToolbar();
    loadCurrentBeulen();
    activateKristineHash();
  });

  window.addEventListener("hashchange", function () {
    activateKristineHash();
    const mount = document.getElementById("kristaTopbar");
    if (mount) buildTopbar(mount);
  });
})();
