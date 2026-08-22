"use strict";
(function () {
  function orderRows() {
    return Array.from(document.querySelectorAll("#lgOrderBody .lg-order-row[data-order-id]"));
  }

  function numberFromCell(row, index) {
    const text = String(row.children[index]?.textContent || "")
      .trim()
      .replace(/\s/g, "")
      .replace(",", ".");
    const value = Number(text);
    return Number.isFinite(value) ? value : 0;
  }

  function setStatus(text) {
    const status = document.getElementById("lgOrderStatus");
    if (status) status.textContent = text;
  }

  function applyMinimum(button) {
    const rows = orderRows();
    let changed = 0;
    for (const row of rows) {
      const stock = Math.max(0, numberFromCell(row, 3));
      const minimum = Math.max(0, numberFromCell(row, 4));
      const quantity = Math.max(0, Math.ceil(minimum - stock));
      const input = row.querySelector(".lg-order-qty");
      if (!input) continue;
      if (Number(input.value || 0) !== quantity) changed += 1;
      input.value = String(quantity);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    button.dataset.mode = "minimum";
    button.textContent = "Bis Soll";
    button.title = "Automatische Bestellmengen wieder auf Auffüllen bis Soll zurückstellen";
    setStatus(`Nur Mindest gesetzt · ${changed} Mengen geändert · noch nicht gespeichert.`);
  }

  function restoreTarget(button) {
    const ids = orderRows().map(row => row.dataset.orderId).filter(Boolean);
    for (const id of ids) {
      const row = orderRows().find(entry => entry.dataset.orderId === id);
      const auto = row?.querySelector(".lg-order-auto");
      if (auto) auto.click();
    }
    button.dataset.mode = "target";
    button.textContent = "Nur Mindest";
    button.title = "Alle aktuellen Bestellpositionen nur bis zum Mindestbestand auffüllen";
    setStatus("Auffüllen bis Soll wiederhergestellt · noch nicht gespeichert.");
  }

  function ensureButton() {
    const modal = document.getElementById("lgOrderReviewModal");
    const actions = modal?.querySelector(".lg-order-actions");
    if (!actions || document.getElementById("lgOrderMinimum")) return;

    const button = document.createElement("button");
    button.id = "lgOrderMinimum";
    button.className = "btn";
    button.type = "button";
    button.dataset.mode = "target";
    button.textContent = "Nur Mindest";
    button.title = "Alle aktuellen Bestellpositionen nur bis zum Mindestbestand auffüllen";
    button.addEventListener("click", () => {
      if (button.dataset.mode === "minimum") restoreTarget(button);
      else applyMinimum(button);
    });

    const excel = document.getElementById("lgOrderExcel");
    const pdf = document.getElementById("lgOrderPdf");
    actions.insertBefore(button, excel || pdf || actions.firstChild);
  }

  const observer = new MutationObserver(ensureButton);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureButton();
})();
