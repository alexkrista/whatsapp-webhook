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

    if (pathname.includes("kristool-preview")) return "kriszeit";
    if (pathname.includes("kontrollzentrum")) return "kristower";
    if (pathname.includes("/admin")) return "krisadmin";
    if (hash === "#tasks") return "tasks";
    if (pathname.includes("/kristine")) return "kristine";

    return "kristine";
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

    // KRISTINE startet künftig in der Planung. Das alte KRISTOOL-Dashboard
    // bleibt technisch vorhanden, ist aber keine eigene Navigationsebene mehr.
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
        text.includes("chefzentrale") ||
        text.includes("ideen");

      if (remove) button.remove();
    });
  }

  function cleanModuleNavigation() {
    cleanKristineModuleNav();
    cleanAdminModuleNav();
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
    activateKristineHash();
  });

  window.addEventListener("hashchange", function () {
    activateKristineHash();

    const mount = document.getElementById("kristaTopbar");
    if (mount) buildTopbar(mount);
  });
})();
