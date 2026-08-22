"use strict";

// Kleine Line-2-Freigabe für The Brain in KRISTINE GO.
// Die Hauptlogik in kristine-go.js unterstützt bereits brainAccess/canUseBrain.
// Bis dieses Recht im Mitarbeiterstamm editierbar ist, wird Clemens hier sauber
// als zusätzlicher freigegebener Benutzer behandelt.
(() => {
  const BRAIN_URL = "https://pc-alex02.tail610122.ts.net/";

  function normalizedName(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function isClemens() {
    const name = normalizedName(document.getElementById("kgEmployeeName")?.textContent);
    return /(^|\s)clemens(\s|$)/.test(name);
  }

  function syncBrainAccess() {
    const card = document.getElementById("kgBrainCard");
    const button = document.getElementById("kgBrainButton");
    if (!card || !button) return;

    if (isClemens()) {
      if (card.classList.contains("kg-hidden")) card.classList.remove("kg-hidden");
      if (button.disabled) button.disabled = false;
      button.dataset.kgoBrainFallback = "clemens";
      return;
    }

    if (button.dataset.kgoBrainFallback === "clemens") {
      delete button.dataset.kgoBrainFallback;
    }
  }

  function openBrainForClemens(event) {
    if (!isClemens()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.open(BRAIN_URL, "_blank", "noopener");
  }

  function loadInvoiceScanner() {
    if (document.querySelector('script[data-kgo-invoice-scan]')) return;
    const script = document.createElement("script");
    script.src = "/public/ui/kgo-invoice-scan.js?v=20260822-2";
    script.defer = true;
    script.setAttribute("data-kgo-invoice-scan", "1");
    document.head.appendChild(script);
  }

  function install() {
    const employeeName = document.getElementById("kgEmployeeName");
    const card = document.getElementById("kgBrainCard");
    const button = document.getElementById("kgBrainButton");

    if (!employeeName || !card || !button) {
      window.setTimeout(install, 100);
      return;
    }

    button.addEventListener("click", openBrainForClemens, true);

    const observer = new MutationObserver(syncBrainAccess);
    observer.observe(employeeName, { childList: true, characterData: true, subtree: true });
    observer.observe(card, { attributes: true, attributeFilter: ["class"] });
    observer.observe(button, { attributes: true, attributeFilter: ["disabled"] });

    syncBrainAccess();
    loadInvoiceScanner();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
