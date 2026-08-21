"use strict";
(function () {
  function suggested(stock, minimum, target) {
    stock = Math.max(0, Number(stock || 0));
    minimum = Math.max(0, Number(minimum || 0));
    target = Math.max(minimum, Number(target || 0));
    return stock < minimum ? Math.max(0, Math.ceil(target - stock)) : 0;
  }

  function recalcRow(row) {
    if (!row) return;
    const stockInput = row.querySelector(".inventory-ist");
    const minimumInput = row.querySelector(".inventory-min");
    const targetInput = row.querySelector(".inventory-target");
    const suggestEl = row.querySelector("[data-suggest]");
    const suggestCell = row.querySelector(".inventory-suggest");
    const orderInput = row.querySelector(".inventory-order-input");
    if (!minimumInput || !targetInput || !suggestEl) return;

    const stock = stockInput && stockInput.value !== "" ? Number(stockInput.value) : Number(row.dataset.stock || 0);
    const value = suggested(stock, minimumInput.value, targetInput.value);
    suggestEl.textContent = String(value);
    if (suggestCell) suggestCell.className = "inv-num inventory-suggest " + (value > 0 ? "need" : "ok");
    if (orderInput && row.dataset.orderMode !== "manual") orderInput.value = String(value);
  }

  function installPlanToggle() {
    const oldButton = document.getElementById("inventoryPlanToggle");
    if (!oldButton || oldButton.dataset.planFix === "1") return;

    // Durch Ersetzen entfernen wir eventuell alte/defekte Listener und haben exakt einen sauberen Handler.
    const button = oldButton.cloneNode(true);
    button.type = "button";
    button.dataset.planFix = "1";
    oldButton.replaceWith(button);

    let open = false;
    const apply = () => {
      document.querySelectorAll(".inventory-plan").forEach(input => {
        input.disabled = !open;
      });
      button.textContent = open ? "Soll/Mindest offen" : "Soll/Mindest bearbeiten";
      button.classList.toggle("primary", open);
      button.setAttribute("aria-pressed", open ? "true" : "false");
    };

    button.addEventListener("click", () => {
      open = !open;
      apply();
      if (open) document.querySelector(".inventory-min, .inventory-target")?.focus();
    });
    apply();
  }

  // Delegiert, damit auch nach "Neu laden" neu gerenderte Zeilen sicher funktionieren.
  document.addEventListener("input", event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (!input.matches(".inventory-min, .inventory-target")) return;
    const row = input.closest("[data-inv-row]");
    if (!row) return;
    row.dataset.levelDirty = "1";
    recalcRow(row);
  });

  installPlanToggle();
  // Falls das Inventur-UI erst kurz nach diesem Script aufgebaut wird.
  const observer = new MutationObserver(() => installPlanToggle());
  observer.observe(document.body, { childList: true, subtree: true });
})();
