"use strict";
(function () {
  const qs = new URLSearchParams(location.search);
  const token = qs.get("token") || "";
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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

  function labelFrom(element) {
    if (!element) return "";
    const clone = element.cloneNode(true);
    clone.querySelectorAll(".inv-code").forEach(x => x.remove());
    return String(clone.textContent || "").trim();
  }

  function sourceRows() {
    return [...document.querySelectorAll("[data-inv-row]")].map(row => {
      const product = row.closest("[data-inv-product]")?.querySelector("summary span")?.textContent?.trim() || "";
      const size = row.closest("[data-inv-size]")?.querySelector(".inv-size-title")?.textContent?.trim() || "";
      const base = labelFrom(row.querySelector(".inv-base"));
      const code = row.querySelector(".inv-code")?.textContent?.trim() || "";
      const minimum = row.querySelector(".inventory-min")?.value || "0";
      const target = row.querySelector(".inventory-target")?.value || "0";
      const cells = [...row.querySelectorAll(".inv-num")];
      const ek = cells.length ? String(cells[cells.length - 1].textContent || "").replace(/^EK\s*/i, "").trim() : "";
      return { row, articleId: row.dataset.id || "", product, size, base, code, minimum, target, ek };
    });
  }

  function ensureStyle() {
    if (document.getElementById("inventoryPlanListStyle")) return;
    const style = document.createElement("style");
    style.id = "inventoryPlanListStyle";
    style.textContent = `
      .plan-list-modal{position:fixed;inset:0;z-index:80;background:#0008;display:none;align-items:flex-start;justify-content:center;padding:24px}
      .plan-list-modal.show{display:flex}.plan-list-card{width:min(1120px,100%);max-height:calc(100vh - 48px);background:#fff;border-radius:16px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 18px 60px #0004}
      .plan-list-top{padding:16px 18px 12px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:flex-start;justify-content:space-between}.plan-list-top h2{margin:0 0 4px;font-size:21px}.plan-list-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}
      .plan-list-filter{margin:10px 18px 8px;width:calc(100% - 36px);padding:10px 12px;border:1px solid #cfd1ca;border-radius:10px;font-size:15px}
      .plan-list-scroll{overflow:auto;padding:0 18px 16px}.plan-list-head,.plan-list-row{display:grid;grid-template-columns:minmax(210px,1.55fr) 95px minmax(160px,1.15fr) 84px 84px 100px;gap:8px;align-items:center}.plan-list-head{position:sticky;top:0;z-index:2;background:#fff;padding:8px 0 7px;border-bottom:1px solid var(--line);font-size:11px;font-weight:900;color:var(--muted)}.plan-list-row{padding:6px 0;border-bottom:1px solid #eceee8}.plan-list-row.dirty{background:#fffaf0}.plan-list-code{font-size:10px;color:var(--muted);margin-top:2px}.plan-list-num{width:74px;padding:7px;border:1px solid #aeb5ad;border-radius:8px;font-weight:900;text-align:center}.plan-list-ek{text-align:right;font-weight:800}.plan-list-status{padding:0 18px 14px;font-size:12px;color:var(--muted)}
      @media(max-width:760px){.plan-list-modal{padding:0}.plan-list-card{max-height:100vh;height:100vh;border-radius:0}.plan-list-top{padding:12px}.plan-list-filter{margin:8px 12px;width:calc(100% - 24px)}.plan-list-scroll{padding:0 12px 14px}.plan-list-head{display:none}.plan-list-row{grid-template-columns:1fr 72px 72px;gap:5px 8px;padding:10px 0}.plan-list-row>div:nth-child(1){grid-column:1/-1;font-weight:900}.plan-list-row>div:nth-child(2),.plan-list-row>div:nth-child(3){font-size:12px}.plan-list-row>div:nth-child(6){display:none}.plan-list-num{width:68px}.plan-list-row:before{content:""}}
    `;
    document.head.appendChild(style);
  }

  function ensureModal() {
    ensureStyle();
    let modal = document.getElementById("inventoryPlanListModal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "inventoryPlanListModal";
    modal.className = "plan-list-modal";
    modal.innerHTML = `
      <div class="plan-list-card" role="dialog" aria-modal="true" aria-label="Lager-Sollwerte">
        <div class="plan-list-top"><div><h2>Lager-Sollwerte</h2><div class="muted">Schnellliste zum Eintippen · Mindest = Bestellschwelle · Soll = Auffüllziel</div></div><div class="plan-list-actions"><button id="inventoryPlanListClose" class="btn" type="button">Schließen</button><button id="inventoryPlanListSave" class="btn primary" type="button">Sollwerte speichern</button></div></div>
        <input id="inventoryPlanListFilter" class="plan-list-filter" placeholder="Material, Gebinde, Basis oder SKU filtern …">
        <div class="plan-list-scroll"><div class="plan-list-head"><span>Material</span><span>Gebinde</span><span>Basis</span><span>Mindest</span><span>Soll</span><span>EK</span></div><div id="inventoryPlanListBody"></div></div>
        <div id="inventoryPlanListStatus" class="plan-list-status"></div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector("#inventoryPlanListClose").onclick = () => modal.classList.remove("show");
    modal.addEventListener("click", event => { if (event.target === modal) modal.classList.remove("show"); });
    modal.querySelector("#inventoryPlanListFilter").addEventListener("input", event => {
      const q = String(event.target.value || "").trim().toLowerCase();
      modal.querySelectorAll("[data-plan-list-row]").forEach(row => { row.hidden = !!q && !String(row.dataset.search || "").includes(q); });
    });
    modal.querySelector("#inventoryPlanListSave").onclick = savePlanList;
    return modal;
  }

  function renderPlanList() {
    const modal = ensureModal();
    const body = modal.querySelector("#inventoryPlanListBody");
    const rows = sourceRows();
    body.innerHTML = rows.map(item => `<div class="plan-list-row" data-plan-list-row data-id="${esc(item.articleId)}" data-search="${esc([item.product,item.size,item.base,item.code].join(" ").toLowerCase())}"><div>${esc(item.product)}<div class="plan-list-code">${esc(item.code)}</div></div><div>${esc(item.size)}</div><div>${esc(item.base)}</div><div><input class="plan-list-num" data-plan="minimum" type="number" min="0" step="1" inputmode="numeric" value="${esc(item.minimum)}"></div><div><input class="plan-list-num" data-plan="target" type="number" min="0" step="1" inputmode="numeric" value="${esc(item.target)}"></div><div class="plan-list-ek">${esc(item.ek)}</div></div>`).join("");
    body.querySelectorAll(".plan-list-num").forEach(input => input.addEventListener("input", () => input.closest("[data-plan-list-row]")?.classList.add("dirty")));
    modal.querySelector("#inventoryPlanListStatus").textContent = `${rows.length} Lagerpositionen`;
    return modal;
  }

  function findSourceRow(articleId) {
    return [...document.querySelectorAll("[data-inv-row]")].find(row => String(row.dataset.id || "") === String(articleId || "")) || null;
  }

  async function savePlanList() {
    const modal = ensureModal();
    const status = modal.querySelector("#inventoryPlanListStatus");
    const dirty = [...modal.querySelectorAll("[data-plan-list-row].dirty")];
    if (!dirty.length) { status.textContent = "Keine Änderungen zum Speichern."; return; }
    const rows = dirty.map(row => ({
      articleId: row.dataset.id || "",
      minimumStock: row.querySelector("[data-plan='minimum']")?.value || 0,
      targetStock: row.querySelector("[data-plan='target']")?.value || 0,
    }));
    status.textContent = "Sollwerte werden gespeichert …";
    try {
      const result = await api("/admin/api/paint/inventory/levels", { method: "POST", body: JSON.stringify({ rows }) });
      rows.forEach(change => {
        const source = findSourceRow(change.articleId);
        if (!source) return;
        const min = source.querySelector(".inventory-min");
        const target = source.querySelector(".inventory-target");
        if (min) min.value = String(change.minimumStock);
        if (target) target.value = String(change.targetStock);
        source.dataset.levelDirty = "0";
        recalcRow(source);
      });
      dirty.forEach(row => row.classList.remove("dirty"));
      status.textContent = `Gespeichert: ${Number(result.changed || 0)} Soll/Mindest-Werte`;
    } catch (error) {
      status.textContent = error.message;
    }
  }

  function installPlanButton() {
    const oldButton = document.getElementById("inventoryPlanToggle");
    if (!oldButton || oldButton.dataset.planList === "1") return;
    const button = oldButton.cloneNode(true);
    button.type = "button";
    button.dataset.planList = "1";
    button.textContent = "Soll/Mindest bearbeiten";
    oldButton.replaceWith(button);
    document.querySelectorAll(".inventory-plan").forEach(input => { input.disabled = true; });
    button.addEventListener("click", () => {
      const modal = renderPlanList();
      modal.classList.add("show");
      modal.querySelector("#inventoryPlanListFilter").value = "";
      modal.querySelector("[data-plan-list-row] .plan-list-num")?.focus();
    });
  }

  installPlanButton();
  const observer = new MutationObserver(() => installPlanButton());
  observer.observe(document.body, { childList: true, subtree: true });
})();
