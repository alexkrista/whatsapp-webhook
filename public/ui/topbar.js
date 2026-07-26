"use strict";

(function () {
  const WORLDS = [
    { key: "kristower", label: "KRISTOWER", icon: "⌂", href: "/kontrollzentrum", subtitle: "Überblick und Entscheidungen" },
    { key: "kristool", label: "KRISTOOL", icon: "🛠", href: "/kristool-preview/", subtitle: "Informationsfabrik" },
    { key: "kristine", label: "KRISTINE", icon: "✦", href: "/kristine", subtitle: "Assistentin und Kommunikation" },
    { key: "krisplan", label: "KRISPLAN", icon: "▦", href: "/kristine#planning", subtitle: "Planung und Einteilung" },
    { key: "leitstand", label: "LEITSTAND", icon: "◉", href: "/kristine#control", subtitle: "Live-Betrieb und Tagesstatus" },
    { key: "krisadmin", label: "KRISADMIN", icon: "⚙", href: "/admin/ui", subtitle: "Stammdaten und Verwaltung" }
  ];

  function tokenized(href) {
    const url = new URL(href, location.origin);
    const token = new URLSearchParams(location.search).get("token");
    if (token) url.searchParams.set("token", token);
    return url.pathname + url.search + url.hash;
  }

  function inferActive() {
    const path = location.pathname.toLowerCase();
    const hash = location.hash.toLowerCase();
    if (path.includes("kristool")) return "kristool";
    if (path.includes("kontrollzentrum")) return "kristower";
    if (path.includes("/admin")) return "krisadmin";
    if (hash === "#planning") return "krisplan";
    if (hash === "#control") return "leitstand";
    return "kristine";
  }

  function activateKristineHash() {
    const hash = location.hash.replace("#", "");
    if (!hash || typeof window.showTab !== "function") return;
    if (["planning", "control", "tasks", "schedules", "kristool"].includes(hash)) {
      window.showTab(hash);
    }
  }

  function buildTopbar(mount, options) {
    const active = options.active || mount.dataset.kristaActive || inferActive();
    const current = WORLDS.find(item => item.key === active) || WORLDS[0];
    const build = options.build || mount.dataset.kristaBuild || "M3.1";
    const context = options.context || mount.dataset.kristaContext || current.subtitle;

    mount.className = "krista-shell-topbar";
    mount.innerHTML = `
      <div class="krista-shell-main">
        <a class="krista-brand" href="${tokenized("/kontrollzentrum")}" aria-label="KRISTA Start">
          <span class="krista-mark">K</span>
          <span class="krista-brand-copy">
            <strong>KRISTA</strong>
            <small>Einfach. Intuitiv. Gemeinsam.</small>
          </span>
        </a>

        <nav class="krista-world-nav" aria-label="KRISTA Arbeitswelten">
          ${WORLDS.map(item => `
            <a class="krista-world-link ${item.key === active ? "active" : ""}"
               ${item.key === active ? 'aria-current="page"' : ""}
               href="${tokenized(item.href)}">
              <span class="krista-world-icon" aria-hidden="true">${item.icon}</span>
              <span>${item.label}</span>
            </a>`).join("")}
        </nav>

        <div class="krista-user">
          <strong>Alexander Krista</strong>
          <small>${build}</small>
        </div>
      </div>

      <div class="krista-contextbar">
        <div>
          <strong>${current.label}</strong>
          <span>${context}</span>
        </div>
        <div class="krista-context-status" id="kristaContextStatus"></div>
      </div>`;

    document.body.classList.add("krista-ui");
  }

  window.createKristaTopbar = function (options = {}) {
    const mount = document.getElementById(options.mountId || "kristaTopbar");
    if (mount) buildTopbar(mount, options);
  };

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("#kristaTopbar,[data-krista-topbar]").forEach(mount => {
      if (!mount.dataset.kristaRendered) {
        mount.dataset.kristaRendered = "1";
        buildTopbar(mount, {});
      }
    });
    activateKristineHash();
  });

  window.addEventListener("hashchange", function () {
    activateKristineHash();
    const mount = document.getElementById("kristaTopbar");
    if (mount) buildTopbar(mount, {});
  });
})();
