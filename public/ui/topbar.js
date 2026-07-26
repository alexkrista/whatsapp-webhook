"use strict";

(function () {
  const WORLDS = [
    {
      key: "kristower",
      label: "KRISTOWER",
      icon: "⌂",
      href: "/kontrollzentrum",
      subtitle: "Überblick und Entscheidungen"
    },
    {
      key: "kristool",
      label: "KRISTOOL",
      icon: "🛠",
      href: "/kristool-preview/",
      subtitle: "Informationsfabrik"
    },
    {
      key: "kristine",
      label: "KRISTINE",
      icon: "✦",
      href: "/kristine",
      subtitle: "Assistentin und Kommunikation"
    },
    {
      key: "krisplan",
      label: "KRISPLAN",
      icon: "▦",
      href: "/kristine#planning",
      subtitle: "Planung und Einteilung"
    },
    {
      key: "krisadmin",
      label: "KRISADMIN",
      icon: "⚙",
      href: "/admin/ui",
      subtitle: "Stammdaten und Verwaltung"
    }
  ];

  function tokenized(href) {
    const url = new URL(href, window.location.origin);
    const token = new URLSearchParams(window.location.search).get("token");

    if (token) {
      url.searchParams.set("token", token);
    }

    return `${url.pathname}${url.search}${url.hash}`;
  }

  function inferActive() {
    const pathname = window.location.pathname.toLowerCase();
    const hash = window.location.hash.toLowerCase();

    if (pathname.includes("kristool")) return "kristool";
    if (pathname.includes("kontrollzentrum")) return "kristower";
    if (pathname.includes("/admin")) return "krisadmin";
    if (hash === "#planning") return "krisplan";

    return "kristine";
  }

  function activateKristineHash() {
    const hash = window.location.hash.replace("#", "");

    if (!hash || typeof window.showTab !== "function") {
      return;
    }

    if (["planning", "control", "tasks", "schedules", "kristool"].includes(hash)) {
      window.showTab(hash);
    }
  }

  function buildTopbar(mount, options = {}) {
    const active = options.active || mount.dataset.kristaActive || inferActive();
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
              href="${tokenized(item.href)}"
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
    `;

    document.body.classList.add("krista-ui");
  }

  window.createKristaTopbar = function createKristaTopbar(options = {}) {
    const mount = document.getElementById(options.mountId || "kristaTopbar");

    if (mount) {
      buildTopbar(mount, options);
    }
  };

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("#kristaTopbar,[data-krista-topbar]").forEach((mount) => {
      if (mount.dataset.kristaRendered) return;

      mount.dataset.kristaRendered = "1";
      buildTopbar(mount);
    });

    activateKristineHash();
  });

  window.addEventListener("hashchange", function () {
    activateKristineHash();

    const mount = document.getElementById("kristaTopbar");
    if (mount) {
      buildTopbar(mount);
    }
  });
})();
