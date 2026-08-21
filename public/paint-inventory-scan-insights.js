"use strict";
(function () {
  const qs = new URLSearchParams(location.search);
  const token = qs.get("token") || "";

  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const qty = value => {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return "0";
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10).replace(".", ",");
  };
  const dateDE = value => {
    const d = new Date(value || 0);
    if (!Number.isFinite(d.getTime())) return "";
    return d.toLocaleDateString("de-AT", { day: "2-digit", month: "2-digit", year: "2-digit" });
  };

  async function api(url, opt = {}) {
    const join = url.includes("?") ? "&" : "?";
    const response = await fetch(url + (token ? join + "token=" + encodeURIComponent(token) : ""), {
      ...opt,
      headers: { "Content-Type": "application/json", ...(opt.headers || {}) },
    });
    const data = await response.json().catch(() => ({ ok: false, error: "Keine JSON-Antwort" }));
    if (!response.ok || data.ok === false) throw new Error(data.error || ("HTTP " + response.status));
    return data;
  }

  function ensureStyle() {
    if (document.getElementById("inventoryScanInsightsStyle")) return;
    const style = document.createElement("style");
    style.id = "inventoryScanInsightsStyle";
    style.textContent = `
      .inventory-insights{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:12px 16px 0;background:#fff}
      .inventory-insight{min-height:88px;border:1px solid #d9ddd8;border-radius:12px;background:#f8faf8;padding:9px 8px;text-align:center;display:flex;flex-direction:column;justify-content:center;align-items:center}
      .inventory-insight b{font-size:11px;color:#697168;text-transform:uppercase;letter-spacing:.055em;margin-bottom:4px}.inventory-insight strong{font-size:27px;line-height:1;font-weight:1000;color:#172018}.inventory-insight small{font-size:10px;color:#737a73;margin-top:5px;line-height:1.2}
      .inventory-insight.stock-ok{background:#eef8f0;border-color:#bad9c0}.inventory-insight.stock-low{background:#fff0ee;border-color:#e4b2aa}.inventory-insight.stock-low strong{color:#a32d21}
      button.inventory-insight{font:inherit;cursor:pointer;width:100%;appearance:none}.inventory-insight.editable{border:2px solid #b9c9bc;background:#f4f8f4}.inventory-insight.editable:active{transform:scale(.985)}.inventory-insight.editable small{font-weight:800;color:#267346}
      .inventory-insight.usage{background:#f3f5f1}.inventory-insight.usage.loading strong{font-size:18px;color:#879087}
      @media(max-width:760px){.inventory-insights{grid-template-columns:1fr 1fr;padding:10px 12px 0;gap:7px}.inventory-insight{min-height:82px}.inventory-insight strong{font-size:29px}}
    `;
    document.head.appendChild(style);
  }

  let lastSignature = "";
  let busy = false;
  let currentItem = null;

  function ensurePanel() {
    const box = document.getElementById("inventoryCountBox");
    const article = document.getElementById("inventoryCountArticle");
    if (!box || !article) return null;
    let panel = document.getElementById("inventoryScanInsights");
    if (!panel) {
      ensureStyle();
      panel = document.createElement("div");
      panel.id = "inventoryScanInsights";
      panel.className = "inventory-insights";
      panel.innerHTML = `
        <div id="inventoryInsightStock" class="inventory-insight"><b>Lager bisher</b><strong>–</strong><small></small></div>
        <button id="inventoryInsightMinimum" class="inventory-insight editable" type="button"><b>Mindest</b><strong>–</strong><small>antippen zum Ändern</small></button>
        <button id="inventoryInsightTarget" class="inventory-insight editable" type="button"><b>Soll</b><strong>–</strong><small>antippen zum Ändern</small></button>
        <div id="inventoryInsightUsage" class="inventory-insight usage loading"><b>Verbraucht 6M</b><strong>…</strong><small>wird geladen</small></div>`;
      article.insertAdjacentElement("afterend", panel);
      panel.querySelector("#inventoryInsightMinimum")?.addEventListener("click", () => editLevel("minimum"));
      panel.querySelector("#inventoryInsightTarget")?.addEventListener("click", () => editLevel("target"));
    }
    return panel;
  }

  function findCurrentItem(items, articleText) {
    const text = String(articleText || "").toLowerCase();
    const withSku = (items || []).find(item => item?.stockCode && text.includes(String(item.stockCode).toLowerCase()));
    if (withSku) return withSku;
    return (items || []).find(item => {
      const product = String(item?.product || "").toLowerCase();
      const size = String(item?.size || "").replace(".", ",").toLowerCase();
      const base = String(item?.baseName || item?.baseCode || "").toLowerCase();
      return product && text.includes(product) && (!size || text.includes(size)) && (!base || text.includes(base));
    }) || null;
  }

  function paintValues(item) {
    const stock = Math.max(0, Number(item?.stock || 0));
    const minimum = Math.max(0, Number(item?.minimumStock || 0));
    const target = Math.max(minimum, Number(item?.targetStock || 0));

    const stockEl = document.getElementById("inventoryInsightStock");
    const minEl = document.getElementById("inventoryInsightMinimum");
    const targetEl = document.getElementById("inventoryInsightTarget");
    if (stockEl) {
      stockEl.querySelector("strong").textContent = qty(stock);
      stockEl.querySelector("small").textContent = stock >= minimum ? "Mindest erreicht" : `unter Mindest ${qty(minimum)}`;
      stockEl.classList.toggle("stock-ok", stock >= minimum);
      stockEl.classList.toggle("stock-low", stock < minimum);
    }
    if (minEl) minEl.querySelector("strong").textContent = qty(minimum);
    if (targetEl) targetEl.querySelector("strong").textContent = qty(target);

    const visibleTarget = document.getElementById("inventoryCountTarget");
    if (visibleTarget) visibleTarget.textContent = qty(target);
    recalcVisibleDifference(target);
  }

  function recalcVisibleDifference(targetOverride = null) {
    const actual = document.getElementById("inventoryActualStock");
    const diff = document.getElementById("inventoryCountDiff");
    if (!actual || !diff) return;
    const target = targetOverride === null
      ? Math.max(0, Number(currentItem?.targetStock || 0))
      : Math.max(0, Number(targetOverride || 0));
    const actualValue = Math.max(0, Number(actual.value || 0));
    const value = actualValue - target;
    diff.textContent = value > 0 ? `+${qty(value)}` : qty(value);
  }

  async function loadUsage(item) {
    const usageEl = document.getElementById("inventoryInsightUsage");
    if (!usageEl || !item?.id) return;
    usageEl.classList.add("loading");
    usageEl.querySelector("strong").textContent = "…";
    usageEl.querySelector("small").textContent = "wird geladen";
    try {
      const data = await api(`/admin/api/paint/inventory/usage?articleId=${encodeURIComponent(item.id)}&months=6`);
      if (String(currentItem?.id || "") !== String(item.id)) return;
      usageEl.classList.remove("loading");
      usageEl.querySelector("strong").textContent = qty(data.consumed || 0);
      if (!data.trackedSince) {
        usageEl.querySelector("small").textContent = "Erfassung startet jetzt";
      } else if (!data.coverageComplete) {
        usageEl.querySelector("small").textContent = `erfasst seit ${dateDE(data.trackedSince)} · Ø ${qty(data.monthlyAverage)}/Monat`;
      } else {
        usageEl.querySelector("small").textContent = `Ø ${qty(data.monthlyAverage)}/Monat`;
      }
    } catch (error) {
      usageEl.classList.remove("loading");
      usageEl.querySelector("strong").textContent = "–";
      usageEl.querySelector("small").textContent = String(error?.message || error);
    }
  }

  async function editLevel(kind) {
    if (!currentItem?.id) return;
    const isMinimum = kind === "minimum";
    const current = Math.max(0, Number(isMinimum ? currentItem.minimumStock : currentItem.targetStock) || 0);
    const label = isMinimum ? "Mindeststand" : "Sollstand";
    const raw = prompt(`${label} für\n${currentItem.product} · ${currentItem.baseName || currentItem.baseCode} · ${currentItem.size}\n\nNeuer Wert:`, String(current));
    if (raw === null) return;
    const next = Number(String(raw).replace(",", "."));
    if (!Number.isFinite(next) || next < 0) { alert("Bitte eine gültige Zahl ab 0 eingeben."); return; }

    const row = { articleId: currentItem.id };
    let confirmText = `${label} wirklich von ${qty(current)} auf ${qty(next)} ändern?`;
    if (isMinimum) {
      row.minimumStock = next;
      const target = Math.max(0, Number(currentItem.targetStock || 0));
      if (next > target) {
        if (!confirm(`Mindest ${qty(next)} ist höher als Soll ${qty(target)}.\nSoll ebenfalls auf ${qty(next)} erhöhen?`)) return;
        row.targetStock = next;
        confirmText = `Mindest und Soll wirklich auf ${qty(next)} ändern?`;
      }
    } else {
      const minimum = Math.max(0, Number(currentItem.minimumStock || 0));
      if (next < minimum) { alert(`Soll darf nicht kleiner als Mindest ${qty(minimum)} sein.`); return; }
      row.targetStock = next;
    }
    if (!confirm(confirmText)) return;

    try {
      await api("/admin/api/paint/inventory/levels", { method: "POST", body: JSON.stringify({ rows: [row] }) });
      if (row.minimumStock !== undefined) currentItem.minimumStock = Number(row.minimumStock);
      if (row.targetStock !== undefined) currentItem.targetStock = Number(row.targetStock);
      paintValues(currentItem);
      const note = document.getElementById("inventoryCountNote");
      if (note) note.textContent = `${label} gespeichert. Ist prüfen und Inventur wie gewohnt bestätigen.`;
    } catch (error) {
      alert(String(error?.message || error));
    }
  }

  async function refreshForVisibleCard() {
    const box = document.getElementById("inventoryCountBox");
    const article = document.getElementById("inventoryCountArticle");
    if (!box || box.hidden || !article) { lastSignature = ""; currentItem = null; return; }
    const signature = String(article.textContent || "").trim();
    if (!signature || signature === lastSignature || busy) return;
    lastSignature = signature;
    busy = true;
    try {
      ensurePanel();
      const inventory = await api("/admin/api/paint/inventory");
      const item = findCurrentItem(Array.isArray(inventory.items) ? inventory.items : [], signature);
      if (!item) return;
      currentItem = item;
      paintValues(item);
      await loadUsage(item);
    } catch {} finally {
      busy = false;
    }
  }

  function install() {
    ensureStyle();
    const actual = document.getElementById("inventoryActualStock");
    if (actual && actual.dataset.insightDiff !== "1") {
      actual.dataset.insightDiff = "1";
      actual.addEventListener("input", () => recalcVisibleDifference(), false);
    }
    refreshForVisibleCard();
  }

  install();
  const observer = new MutationObserver(install);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
})();
