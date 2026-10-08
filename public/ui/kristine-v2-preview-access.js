"use strict";

/**
 * Isolated KRISTINE 2.0 header mock for Tor, Eingang, Lager, Büro and Dienste.
 * The production access-status-ui.js is deliberately NOT loaded:
 * that module can submit physical door/gate commands.
 *
 * Every item below is an ordinary navigation link to another static preview
 * page; NO status polling, fetch(), forms or hardware command exists here.
 */
(function () {
  if (window.KRISTINE_V2_SAFE_PREVIEW !== true) return;
  if (window.__kristaV2PreviewAccessInstalled) return;
  window.__kristaV2PreviewAccessInstalled = true;

  const ITEMS = Object.freeze([
    { label: "TOR", target: "tueren", icon: "🚧" },
    { label: "Eingang", target: "tueren", icon: "🚪" },
    { label: "Lager", target: "tueren", icon: "🚪" },
    { label: "Büro", target: "tueren", icon: "🚪" },
    { label: "Dienste", target: "dienste", icon: "🩺" },
  ]);

  function mount() {
    const main = document.querySelector("#kristaTopbar > .krista-shell-main");
    if (!main) return;
    main.classList.add("krista-v2-preview-with-access");
    if (main.querySelector("[data-krista-preview-access]")) return;
    const slot = document.createElement("nav");
    slot.className = "krista-v2-preview-access";
    slot.setAttribute("data-krista-preview-access", "1");
    slot.setAttribute("aria-label", "Türen und Dienste – Test ohne Echtsteuerung");

    const caption = document.createElement("span");
    caption.className = "krista-v2-preview-access-note";
    caption.textContent = "TEST · Kein Live-Status";
    slot.appendChild(caption);

    for (const item of ITEMS) {
      const link = document.createElement("a");
      link.className = "krista-v2-preview-access-link";
      link.href = "/preview?world=" + encodeURIComponent(item.target);
      link.title = item.label + ": im Test nicht verbunden – keine Steuerung möglich";
      link.setAttribute("data-preview-status", "unknown");
      link.setAttribute("aria-label", item.label + " – Test, Status unbekannt");
      const icon = document.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = item.icon;
      const label = document.createElement("span");
      label.textContent = item.label;
      const dot = document.createElement("span");
      dot.className = "krista-v2-preview-access-unknown";
      dot.textContent = "?";
      dot.setAttribute("aria-hidden", "true");
      link.append(icon, label, dot);
      slot.appendChild(link);
    }
    main.appendChild(slot);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
  // The shared topbar can rebuild after a hash change; do not lose this strip.
  window.addEventListener("hashchange", () => queueMicrotask(mount));
})();
