"use strict";

(function () {
  const BRAIN_URL = "https://pc-alex02.tail610122.ts.net/";

  const WORLDS = [
    {
      key: "kristower",
      label: "KRISTOWER",
      icon: "⌂",
      href: "/kontrollzentrum",
      subtitle: "Überblick, Führung und Entscheidungen"
    },
    {
      key: "kriszeit",
      label: "KRISZEIT",
      icon: "⏱",
      href: "/kristool-preview/",
      subtitle: "Zeitkontrolle, Auswertung und Finkzeit"
    },
    {
      key: "brain",
      label: "THE BRAIN",
      icon: "🧠",
      href: BRAIN_URL,
      external: true,
      subtitle: "Firmenwissen, Projekte, Dokumente und Rechnungen"
    },
    {
      key: "kristine",
      label: "KRISTINE",
      icon: "✦",
      href: "/kristine#planning",
      subtitle: "Planung, Leitstand und Baustellen"
    },
    {
      key: "krisadmin",
      label: "KRISADMIN",
      icon: "⚙",
      href: "/admin/ui",
      subtitle: "Mitarbeiter, Fahrzeuge und Stammdaten"
    },
    {
      key: "tasks",
      label: "AUFGABEN",
      icon: "📌",
      href: "/kristine#tasks",
      subtitle: "Offene Aufgaben und Erinnerungen"
    }
  ];

  const SUBNAV = {
    kriszeit: [
      { label: "🧾 Kontrolle", href: "/kristool-preview/" },
      { label: "⏰ Zeitmodelle · Urlaub · Feiertage", href: "/kristine#schedules" }
    ],
    kristine: [
      { label: "📅 Planung", href: "/kristine#planning" },
      { label: "🧾 Leitstand", href: "/kristine#control" },
      { label: "🏗️ Baustellen", href: "/kristine#sites" }
    ]
  };

  function tokenized(href, external = false) {
    const url = new URL(href, window.location.origin);

    if (external || url.origin !== window.location.origin) {
      return url.href;
    }

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
      const remove =
        text.includes("kristool") ||
        text.includes("aufgaben") ||
        text.includes("zeitmodelle") ||
        text.includes("urlaub") ||
        text.includes("feiertage");

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
      const remove =
        text.includes("tagesrapport") ||
        text.includes("chefzentrale");

      if (remove) button.remove();
    });
  }

  function renameKriszeitSurface() {
    const pathname = window.location.pathname.toLowerCase();
    if (!pathname.includes("kristool-preview")) return;

    document.title = document.title.replace(/KRISTOOL/gi, "KRISZEIT");
    document.querySelectorAll(".eyebrow").forEach((el) => {
      if (/kristool/i.test(el.textContent || "")) {
        el.textContent = String(el.textContent || "").replace(/KRISTOOL/gi, "KRISZEIT");
      }
    });
  }

  function loadKristineEmployeeSort() {
    const pathname = window.location.pathname.toLowerCase();
    if (!pathname.includes("/kristine")) return;
    if (document.querySelector('script[data-krista-employee-sort]')) return;

    const script = document.createElement("script");
    script.src = "/public/ui/kristine-employee-sort.js";
    script.dataset.kristaEmployeeSort = "1";
    script.defer = true;
    document.head.appendChild(script);
  }

  function loadAdminEmployeeDocumentCompleteness() {
    const pathname = window.location.pathname.toLowerCase();
    if (!pathname.includes("/admin")) return;
    if (document.querySelector('script[data-krista-employee-document-completeness]')) return;

    const script = document.createElement("script");
    script.src = "/public/ui/employee-document-completeness.js";
    script.dataset.kristaEmployeeDocumentCompleteness = "1";
    script.defer = true;
    document.head.appendChild(script);
  }

  function cleanModuleNavigation() {
    cleanKristineModuleNav();
    cleanAdminModuleNav();
    renameKriszeitSurface();
  }

  function subnavHtml(active) {
    const items = SUBNAV[active] || [];
    if (!items.length) return "";

    return `<div class="krista-shell-subnav" style="display:flex;gap:8px;flex-wrap:wrap;padding:8px 18px;background:#173d2a;border-top:1px solid rgba(255,255,255,.10)">
      ${items.map((item) => `<a href="${tokenized(item.href)}" style="color:#fff;text-decoration:none;padding:7px 10px;border-radius:8px;background:rgba(255,255,255,.08);font-size:13px;font-weight:750">${item.label}</a>`).join("")}
    </div>`;
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
          <span class="krista-brand-copy">
            <strong>KRISTA</strong>
            <small>Einfach. Intuitiv. Gemeinsam.</small>
          </span>
        </a>

        <nav class="krista-world-nav" aria-label="KRISTA Arbeitswelten">
          ${WORLDS.map((item) => `
            <a
              class="krista-world-link ${item.key === active ? "active" : ""}"
              ${item.key === active ? 'aria-current="page"' : ""}
              href="${tokenized(item.href, item.external)}"
              ${item.external ? 'rel="noopener"' : ""}
              title="${item.subtitle}"
            >
              <span class="krista-world-icon" aria-hidden="true">${item.icon}</span>
              <span>${item.label}</span>
            </a>
          `).join("")}
        </nav>

        <div class="krista-user" aria-label="Angemeldeter Benutzer">
          <strong>Alexander Krista</strong>
          <small>Build ${build}</small>
        </div>
      </div>
      ${subnavHtml(active)}
    `;

    document.body.classList.add("krista-ui");
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
    loadAdminEmployeeDocumentCompleteness();
    activateKristineHash();
  });

  window.addEventListener("hashchange", function () {
    activateKristineHash();

    const mount = document.getElementById("kristaTopbar");
    if (mount) buildTopbar(mount);
  });
})();
