"use strict";

(function () {
  const BRAIN_URL = "https://pc-alex02.tail610122.ts.net/";
  const BRAIN_ORIGIN = new URL(BRAIN_URL).origin;

  const WORLDS = [
    { key: "kristower", label: "KRISTOWER", icon: "⌂", href: "/kontrollzentrum", subtitle: "Überblick, Führung und Entscheidungen" },
    { key: "kriszeit", label: "KRISZEIT", icon: "⏱", href: "/kristool-preview/", subtitle: "Zeitkontrolle, Auswertung und Finkzeit" },
    { key: "brain", label: "THE BRAIN", icon: "🧠", href: BRAIN_URL, external: true, subtitle: "Firmenwissen, Projekte, Dokumente und Rechnungen" },
    { key: "farben", label: "LG", icon: "🎨", href: "/admin/paint?scan=1", subtitle: "Little Greene · Farbsuche, Mischrezepte, Lager und Bestellung" },
    { key: "kristine", label: "KRISTINE", icon: "✦", href: "/kristine#planning", subtitle: "Leitstand, Planung und Baustellen" },
    { key: "krisadmin", label: "KRISADMIN", icon: "⚙", href: "/admin/ui", subtitle: "Mitarbeiter, Fahrzeuge, Stammdaten und Systemeinstellungen" },
    { key: "tasks", label: "AUFGABEN", icon: "📌", href: "/kristine#tasks", subtitle: "Offene Aufgaben und Erinnerungen" }
  ];

  function isKristineMainPath() {
    return window.location.pathname.toLowerCase().replace(/\/+$/, "") === "/kristine";
  }

  function isKristineBaustellenPath() {
    return window.location.pathname.toLowerCase().replace(/\/+$/, "") === "/kristine/baustellen";
  }

  function isBaustellenPath() {
    return isKristineBaustellenPath() || window.location.pathname.toLowerCase().includes("baustellen.html");
  }

  function tokenized(href, external = false) {
    const url = new URL(href, window.location.origin);
    const token = new URLSearchParams(window.location.search).get("token");
    if (external || url.origin !== window.location.origin) {
      if (token && url.origin === BRAIN_ORIGIN) url.searchParams.set("krista_token", token);
      return url.href;
    }
    if (token) url.searchParams.set("token", token);
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function inferActive() {
    const pathname = window.location.pathname.toLowerCase();
    const hash = window.location.hash.toLowerCase();
    if (hash === "#tasks") return "tasks";
    if (hash === "#schedules") return "kriszeit";
    if (isKristineBaustellenPath()) return "kristine";
    if (pathname.includes("baustellen.html")) return "krisadmin";
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
    if (raw === "baustellen") return isKristineBaustellenPath() ? "kristine" : "krisadmin";
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
    if (!isKristineMainPath() || typeof window.showTab !== "function") return;
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
    if (!isKristineMainPath()) return;
    const nav = document.querySelector(".krista-module-nav");
    if (!nav) return;
    nav.querySelectorAll("button").forEach((button) => {
      const text = String(button.textContent || "").toLowerCase();
      const remove = text.includes("kristool") || text.includes("aufgaben") || text.includes("zeitmodelle") || text.includes("urlaub") || text.includes("feiertage");
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
    script.async = false;
    script.defer = true;
    document.head.appendChild(script);
  }

  function loadKristineEmployeeSort() {
    if (isKristineMainPath()) loadScriptOnce("/public/ui/kristine-employee-sort.js", "data-krista-employee-sort");
  }

  function loadKristinePlanningSidebarFix() {
    if (isKristineMainPath()) loadScriptOnce("/public/ui/kristine-planning-sidebar-fix.js", "data-krista-planning-sidebar-fix");
  }

  function loadKristineControlHistoryFix() {
    if (isKristineMainPath()) loadScriptOnce("/public/ui/kristine-control-history-fix.js?v=20260824-1555", "data-krista-control-history-fix");
  }

  function loadKristineTaskList() {
    if (isKristineMainPath()) loadScriptOnce("/public/ui/kristine-task-list.js?v=20260822-msgreader", "data-krista-task-list");
  }

  function loadKristineTaskCreateModal() {
    if (isKristineMainPath()) loadScriptOnce("/public/ui/kristine-task-create-modal.js?v=20260824-1202", "data-krista-task-create-modal");
  }

  function loadKristineFinanceApproval() {
    if (isKristineMainPath()) loadScriptOnce("/public/ui/kristine-finance-approval.js?v=20260822-approval", "data-krista-finance-approval");
  }

  function loadKristineInbox() {
    if (isKristineMainPath()) loadScriptOnce("/public/ui/kristine-inbox-v2.js?v=20260824-1208", "data-krista-inbox-v2");
  }

  function loadKristineCustomerMaster() {
    if (isKristineMainPath()) loadScriptOnce("/public/ui/kristine-customer-master.js?v=20260902-master1", "data-krista-customer-master");
  }

  function loadBaustellenKnowledgeStack() {
    if (!isBaustellenPath()) return;
    loadScriptOnce("/public/ui/baustellen-legacy-id-display.js?v=20260823-legacyid1", "data-krista-baustellen-legacy-id-display");
    loadScriptOnce("/public/ui/baustellen-knowledge-hub.js?v=20260903-documentation2", "data-krista-baustellen-knowledge");
    loadScriptOnce("/public/ui/baustellen-cockpit.js?v=20260902-intake", "data-krista-baustellen-cockpit");
    loadScriptOnce("/public/ui/baustellen-chronik.js?v=20260902-all-knowledge", "data-krista-baustellen-chronik");
    loadScriptOnce("/public/ui/baustellen-intelligence.js?v=20260902-photo-count", "data-krista-baustellen-intelligence");
    loadScriptOnce("/public/ui/baustellen-live-hours.js?v=20260903-livehours8", "data-krista-baustellen-live-hours");
    loadScriptOnce("/public/ui/baustellen-foto-gallery.js?v=20260902-photo-count", "data-krista-baustellen-foto-gallery");
    // Diese vorhandenen Module waren früher indirekt an KRISADMIN gekoppelt.
    // Auf dem neuen KRISTINE-Pfad müssen sie ausdrücklich mitgeladen werden.
    loadScriptOnce("/public/ui/baustellen-calculation-v2.js?v=20260826-kalk1", "data-krista-kalkulation-v1");
    loadScriptOnce("/public/ui/baustellen-calculation-parser-fix.js?v=20260826-flatpos1", "data-krista-kalkulation-parser-fix");
    loadScriptOnce("/public/ui/baustellen-calculation-grid-v2.js?v=20260826-grid2", "data-krista-kalkulation-grid-v2");
    loadScriptOnce("/public/ui/baustellen-offer-builder.js?v=20260902-offer7", "data-krista-angebot-v7");
  }

  function loadTowerSignals() {
    if (window.location.pathname.toLowerCase().includes("kontrollzentrum")) {
      loadScriptOnce("/public/ui/tower-baustellen-signals.js?v=20260902-job-folder-links", "data-krista-tower-signals");
    }
  }

  function loadKrisadminHome() {
    const path = window.location.pathname.toLowerCase();
    if (path.includes("/admin") && !path.includes("/admin/paint") && !path.includes("/admin/akte") && !path.includes("/admin/pdf") && !path.includes("/admin/download")) {
      loadScriptOnce("/public/ui/krisadmin-home.js?v=20260823-home", "data-krista-krisadmin-home");
    }
  }

  function loadKrisadminServices() {
    const path = window.location.pathname.toLowerCase();
    const isKrisadmin = path.includes("baustellen.html") || (path.includes("/admin") && !path.includes("/admin/paint") && !path.includes("/admin/akte") && !path.includes("/admin/pdf") && !path.includes("/admin/download"));
    if (isKrisadmin) loadScriptOnce("/public/ui/krisadmin-services.js?v=20260825-services1", "data-krista-krisadmin-services");
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
    loadScriptOnce("/public/ui/admin-employee-personnel-file.js", "data-krista-admin-employee-personnel-file");
  }

  function loadKriszeitToolbar() {
    if (window.location.pathname.toLowerCase().includes("kristool-preview")) loadScriptOnce("/public/ui/kriszeit-toolbar.js", "data-krista-kriszeit-toolbar");
  }

  function loadCurrentBeulen() {
    const path = window.location.pathname.toLowerCase();
    if (path.includes("/admin")) loadScriptOnce("/public/ui/admin-employee-beulen.js", "data-krista-admin-employee-beulen");
    if (isKristineMainPath()) loadScriptOnce("/public/ui/kristine-beulen.js", "data-krista-kristine-beulen");
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
    const build = options.build || mount.dataset.kristaBuild || "0024.07";

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
    loadKristineControlHistoryFix();
    loadKristineTaskList();
    loadKristineTaskCreateModal();
    loadKristineFinanceApproval();
    loadKristineInbox();
    loadKristineCustomerMaster();
    loadBaustellenKnowledgeStack();
    loadTowerSignals();
    loadKrisadminHome();
    loadKrisadminServices();
    loadAdminEmployeeDocumentCompleteness();
    loadAdminEmployeePersonnelFile();
    loadKriszeitToolbar();
    loadCurrentBeulen();
    loadScriptOnce("/public/ui/access-status-ui.js?v=20260825-accessv3", "data-krista-access-status-v3");
    activateKristineHash();
  });

  window.addEventListener("hashchange", function () {
    activateKristineHash();
    const mount = document.getElementById("kristaTopbar");
    if (mount) buildTopbar(mount);
  });
})();
