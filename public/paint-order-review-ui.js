"use strict";
(function () {
  const qs = new URLSearchParams(location.search);
  const token = qs.get("token") || "";
  let data = null;
  let showAll = false;
  let filterText = "";

  const money = value => new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR" }).format(Number(value || 0));
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

  async function api(url, options = {}) {
    const join = url.includes("?") ? "&" : "?";
    const response = await fetch(url + (token ? join + "token=" + encodeURIComponent(token) : ""), {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const body = await response.json().catch(() => ({ ok: false, error: "Keine JSON-Antwort" }));
    if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  }

  function suggested(stock, minimum, target) {
    stock = Math.max(0, Number(stock || 0));
    minimum = Math.max(0, Number(minimum || 0));
    target = Math.max(minimum, Number(target || 0));
    return stock <= minimum ? Math.max(0, Math.ceil(target - stock)) : 0;
  }

  function installStyle() {
    if (document.getElementById("lgOrderReviewStyle")) return;
    const style = document.createElement("style");
    style.id = "lgOrderReviewStyle";
    style.textContent = `
      .lg-order-modal{position:fixed;inset:0;z-index:120;background:#0009;display:none;align-items:flex-start;justify-content:center;padding:24px}.lg-order-modal.show{display:flex}
      .lg-order-card{width:min(1320px,100%);max-height:calc(100vh - 48px);background:#fff;border-radius:18px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 80px #0005}
      .lg-order-top{padding:16px 18px 12px;border-bottom:1px solid var(--line);display:flex;gap:14px;align-items:flex-start;justify-content:space-between}.lg-order-top h2{margin:0 0 4px;font-size:22px}.lg-order-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}
      .lg-order-summary{display:flex;gap:8px;flex-wrap:wrap;padding:10px 18px;background:#f2f5f1;border-bottom:1px solid var(--line)}.lg-order-summary b{font-size:17px}.lg-order-pill{background:#fff;border:1px solid #d9ddd7;border-radius:999px;padding:6px 10px;font-size:12px}
      .lg-order-filterbar{display:flex;gap:10px;align-items:center;padding:10px 18px}.lg-order-filterbar input[type=search]{flex:1;padding:10px 12px;border:1px solid #cfd1ca;border-radius:10px;font-size:15px}.lg-order-filterbar label{font-size:12px;white-space:nowrap}
      .lg-order-scroll{overflow:auto;padding:0 18px 16px}.lg-order-head,.lg-order-row{display:grid;grid-template-columns:minmax(180px,1.55fr) 85px minmax(120px,1fr) 62px 62px 62px 72px 92px 82px 100px;gap:7px;align-items:center}.lg-order-head{position:sticky;top:0;z-index:2;background:#fff;padding:8px 0 7px;border-bottom:1px solid var(--line);font-size:10px;font-weight:900;color:var(--muted)}.lg-order-row{padding:7px 0;border-bottom:1px solid #eceee8}.lg-order-row.manual{background:#fffaf0}.lg-order-code{font-size:9px;color:var(--muted);margin-top:2px}.lg-order-num{text-align:right}.lg-order-qty{width:70px;padding:7px;border:1px solid #aeb5ad;border-radius:8px;font-weight:900;text-align:center}.lg-order-auto{border:0;background:transparent;font-size:10px;color:#657067;cursor:pointer;text-decoration:underline;padding:2px}.lg-order-total{font-weight:950;text-align:right}.lg-order-empty{padding:28px;text-align:center;color:var(--muted)}
      .lg-order-note{padding:0 18px 14px;color:var(--muted);font-size:12px}.lg-order-note strong{color:#315f45}
      @media(max-width:850px){.lg-order-modal{padding:0}.lg-order-card{height:100vh;max-height:100vh;border-radius:0}.lg-order-top{display:block;padding:12px}.lg-order-actions{justify-content:flex-start;margin-top:9px}.lg-order-actions .btn{flex:1 1 auto}.lg-order-summary,.lg-order-filterbar{padding-left:12px;padding-right:12px}.lg-order-scroll{padding:0 12px 14px}.lg-order-head{display:none}.lg-order-row{grid-template-columns:1fr 70px 92px;gap:5px 8px;padding:10px 0}.lg-order-row>div:nth-child(1){grid-column:1/-1;font-weight:900}.lg-order-row>div:nth-child(2),.lg-order-row>div:nth-child(3){font-size:12px}.lg-order-row>div:nth-child(4),.lg-order-row>div:nth-child(5),.lg-order-row>div:nth-child(6),.lg-order-row>div:nth-child(7){font-size:11px}.lg-order-row>div:nth-child(8){grid-column:2}.lg-order-row>div:nth-child(9){display:none}.lg-order-row>div:nth-child(10){grid-column:3}.lg-order-filterbar{flex-wrap:wrap}.lg-order-filterbar input[type=search]{width:100%;flex-basis:100%}}
    `;
    document.head.appendChild(style);
  }

  function ensureModal() {
    installStyle();
    let modal = document.getElementById("lgOrderReviewModal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "lgOrderReviewModal";
    modal.className = "lg-order-modal";
    modal.innerHTML = `
      <div class="lg-order-card" role="dialog" aria-modal="true" aria-label="Little Greene Bestellung">
        <div class="lg-order-top"><div><h2>Little Greene · Bestellung prüfen</h2><div class="muted">Bestellmenge bleibt frei änderbar. <b>IST ≤ Mindest</b> löst Auffüllen bis Soll aus.</div></div><div class="lg-order-actions"><button id="lgOrderPdf" class="btn" type="button">PDF ansehen</button><button id="lgOrderClose" class="btn" type="button">Schließen</button><button id="lgOrderSave" class="btn primary" type="button">Bestellung speichern</button></div></div>
        <div id="lgOrderSummary" class="lg-order-summary"></div>
        <div class="lg-order-filterbar"><input id="lgOrderFilter" type="search" placeholder="Material, Gebinde, Basis oder SKU filtern …"><label><input id="lgOrderShowAll" type="checkbox"> alle LG-Artikel anzeigen</label></div>
        <div class="lg-order-scroll"><div class="lg-order-head"><span>Material</span><span>Gebinde</span><span>Basis</span><span>IST</span><span>Mindest</span><span>Soll</span><span>Vorschlag</span><span>Bestell</span><span>EK</span><span>Summe</span></div><div id="lgOrderBody"></div></div>
        <div id="lgOrderStatus" class="lg-order-note"><strong>Kein Direktversand:</strong> erst prüfen und speichern, danach PDF ansehen.</div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector("#lgOrderClose").onclick = () => modal.classList.remove("show");
    modal.addEventListener("click", event => { if (event.target === modal) modal.classList.remove("show"); });
    modal.querySelector("#lgOrderFilter").addEventListener("input", event => { filterText = String(event.target.value || "").trim().toLowerCase(); render(); });
    modal.querySelector("#lgOrderShowAll").addEventListener("change", event => { showAll = !!event.target.checked; render(); });
    modal.querySelector("#lgOrderSave").onclick = () => saveDirty(false);
    modal.querySelector("#lgOrderPdf").onclick = openPdf;
    return modal;
  }

  function visibleItems() {
    if (!data?.items) return [];
    return data.items.filter(item => {
      const open = Number(item.quantity || 0) > 0;
      if (!showAll && !open) return false;
      if (!filterText) return true;
      return [item.product, item.size, item.baseCode, item.baseName, item.stockCode, item.ean].join(" ").toLowerCase().includes(filterText);
    });
  }

  function updateItemTotals(item) {
    item.quantity = Math.max(0, Number(item.quantity || 0));
    item.lineTotal = Number((item.quantity * Number(item.purchasePrice || 0)).toFixed(2));
  }

  function recalcSummary() {
    if (!data?.items) return;
    data.openItems = data.items.filter(item => Number(item.quantity || 0) > 0);
    data.openPositions = data.openItems.length;
    data.pieces = data.openItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    data.total = Number(data.openItems.reduce((sum, item) => sum + Number(item.lineTotal || 0), 0).toFixed(2));
    const summary = document.getElementById("lgOrderSummary");
    if (summary) summary.innerHTML = `<span class="lg-order-pill"><b>${data.openPositions}</b> Positionen</span><span class="lg-order-pill"><b>${data.pieces}</b> Stück</span><span class="lg-order-pill">Gesamt netto <b>${money(data.total)}</b></span>`;
    const total = document.getElementById("openOrderTotal");
    if (total) total.textContent = money(data.total);
  }

  function render() {
    const body = document.getElementById("lgOrderBody");
    if (!body || !data) return;
    recalcSummary();
    const items = visibleItems();
    if (!items.length) {
      body.innerHTML = `<div class="lg-order-empty">${showAll ? "Keine Treffer." : "Keine Bestellpositionen. Lager ist innerhalb der Grenzen."}</div>`;
      return;
    }
    body.innerHTML = items.map(item => {
      const manual = item.manualQuantity !== null && item.manualQuantity !== undefined;
      const label = item.baseCode && item.baseName && item.baseCode.toLowerCase() !== item.baseName.toLowerCase() ? `${item.baseCode} · ${item.baseName}` : (item.baseName || item.baseCode || "");
      return `<div class="lg-order-row ${manual ? "manual" : ""}" data-order-id="${esc(item.articleId)}"><div>${esc(item.product)}<div class="lg-order-code">${esc(item.stockCode || item.ean || "")}</div></div><div>${esc(item.size)}</div><div>${esc(label)}</div><div class="lg-order-num">${item.stock}</div><div class="lg-order-num">${item.minimumStock}</div><div class="lg-order-num">${item.targetStock}</div><div class="lg-order-num">${item.suggestedQuantity}</div><div class="lg-order-num"><input class="lg-order-qty" type="number" min="0" step="1" inputmode="numeric" value="${item.quantity}"><button class="lg-order-auto" type="button">Auto</button></div><div class="lg-order-num">${money(item.purchasePrice)}</div><div class="lg-order-total">${money(item.lineTotal)}</div></div>`;
    }).join("");
    body.querySelectorAll("[data-order-id]").forEach(row => {
      const item = data.items.find(entry => entry.articleId === row.dataset.orderId);
      const input = row.querySelector(".lg-order-qty");
      input.addEventListener("input", () => {
        item.quantity = Math.max(0, Number(input.value || 0));
        item.manualQuantity = item.quantity;
        item.orderManual = true;
        item._dirty = true;
        updateItemTotals(item);
        row.classList.add("manual");
        row.querySelector(".lg-order-total").textContent = money(item.lineTotal);
        recalcSummary();
      });
      row.querySelector(".lg-order-auto").addEventListener("click", () => {
        item.manualQuantity = null;
        item.orderManual = false;
        item.quantity = Number(item.suggestedQuantity || 0);
        item._dirty = true;
        updateItemTotals(item);
        render();
      });
    });
  }

  async function loadReview() {
    const status = document.getElementById("lgOrderStatus");
    if (status) status.textContent = "Bestellung wird geladen …";
    data = await api("/admin/api/paint/order-review");
    if (status) status.innerHTML = "<strong>Kein Direktversand:</strong> erst prüfen und speichern, danach PDF ansehen.";
    render();
    return data;
  }

  async function saveDirty(silent) {
    if (!data?.items) return true;
    const dirty = data.items.filter(item => item._dirty);
    if (!dirty.length) {
      if (!silent) document.getElementById("lgOrderStatus").textContent = "Keine Änderungen zum Speichern.";
      return true;
    }
    const status = document.getElementById("lgOrderStatus");
    if (status) status.textContent = "Bestellmengen werden gespeichert …";
    try {
      data = await api("/admin/api/paint/order-review", {
        method: "POST",
        body: JSON.stringify({ rows: dirty.map(item => ({ articleId: item.articleId, mode: item.orderManual ? "manual" : "auto", quantity: item.quantity })) }),
      });
      if (status) status.textContent = `Gespeichert · ${data.openPositions} Positionen · ${money(data.total)}`;
      render();
      return true;
    } catch (error) {
      if (status) status.textContent = error.message;
      return false;
    }
  }

  async function openPdf() {
    const popup = window.open("about:blank", "_blank");
    const ok = await saveDirty(true);
    if (!ok) { try { popup?.close(); } catch {} return; }
    const url = "/admin/api/paint/order-review/pdf" + (token ? "?token=" + encodeURIComponent(token) : "");
    if (popup) popup.location.href = url; else window.location.href = url;
  }

  async function openReview() {
    const modal = ensureModal();
    modal.classList.add("show");
    try { await loadReview(); } catch (error) { document.getElementById("lgOrderStatus").textContent = error.message; }
  }

  function installButton() {
    const button = document.getElementById("orderMailBtn");
    if (!button || button.dataset.orderReview === "1") return;
    button.dataset.orderReview = "1";
    button.textContent = "Bestellung bearbeiten";
    button.title = "Bestellpositionen prüfen und bearbeiten. Kein automatischer Mailversand.";
    button.onclick = event => { event.preventDefault(); event.stopImmediatePropagation(); openReview(); };
  }

  function patchInventoryRow(row) {
    if (!row) return;
    const stockInput = row.querySelector(".inventory-ist");
    const minInput = row.querySelector(".inventory-min");
    const targetInput = row.querySelector(".inventory-target");
    const suggestEl = row.querySelector("[data-suggest]");
    const suggestCell = row.querySelector(".inventory-suggest");
    const orderInput = row.querySelector(".inventory-order-input");
    if (!minInput || !targetInput || !suggestEl) return;
    const stock = stockInput && stockInput.value !== "" ? Number(stockInput.value) : Number(row.dataset.stock || 0);
    const value = suggested(stock, minInput.value, targetInput.value);
    const nextText = String(value);
    if (suggestEl.textContent !== nextText) suggestEl.textContent = nextText;
    if (suggestCell) suggestCell.className = "inv-num inventory-suggest " + (value > 0 ? "need" : "ok");
    if (orderInput && row.dataset.orderMode !== "manual") orderInput.value = String(value);
  }

  function patchInventory() {
    document.querySelectorAll("[data-inv-row]").forEach(patchInventoryRow);
    const note = document.querySelector("#tab-inventory .inventory-note");
    if (note && /fällt Ist unter Mindest/i.test(note.textContent || "")) {
      note.innerHTML = note.innerHTML.replace(/fällt Ist unter Mindest/i, "erreicht Ist den Mindestbestand oder liegt darunter");
    }
  }

  document.addEventListener("input", event => {
    if (event.target?.matches?.(".inventory-ist,.inventory-min,.inventory-target")) setTimeout(() => patchInventoryRow(event.target.closest("[data-inv-row]")), 0);
  }, true);
  document.addEventListener("click", event => {
    if (event.target?.matches?.("#inventoryReload,#inventorySave,#inventoryPlanListSave")) setTimeout(patchInventory, 700);
  }, true);

  const observer = new MutationObserver(() => { installButton(); patchInventory(); });
  observer.observe(document.body, { childList: true, subtree: true });
  installButton();
  patchInventory();
  ensureModal();
  api("/admin/api/paint/order-review").then(result => { data = result; recalcSummary(); }).catch(() => {});
})();
