"use strict";
(function () {
  const qs = new URLSearchParams(location.search);
  const token = qs.get("token") || "";
  const api = async (url, opt = {}) => {
    const join = url.includes("?") ? "&" : "?";
    const response = await fetch(url + (token ? join + "token=" + encodeURIComponent(token) : ""), {
      ...opt,
      headers: { "Content-Type": "application/json", ...(opt.headers || {}) },
    });
    const type = String(response.headers.get("content-type") || "");
    if (!type.includes("application/json")) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response;
    }
    const data = await response.json().catch(() => ({ ok: false, error: "Keine JSON-Antwort" }));
    if (!response.ok || data.ok === false) throw new Error(data.error || ("HTTP " + response.status));
    return data;
  };
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const style = document.createElement("style");
  style.textContent = `
    .wall-order-panel{border:1px solid var(--line);border-radius:12px;background:#fff;margin:8px 0 14px;padding:12px}
    .wall-order-panel[hidden]{display:none!important}.wall-order-head{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:8px}
    .wall-order-tools{display:flex;gap:7px;flex-wrap:wrap}.wall-order-note{font-size:12px;color:var(--muted);margin:5px 0 10px}
    .wall-order-row,.wall-order-columns{display:grid;grid-template-columns:1.05fr 1.15fr .9fr 1fr 70px 1fr 34px;gap:7px;align-items:center}
    .wall-order-columns{font-size:10px;font-weight:850;color:var(--muted);padding:4px 0}.wall-order-row{padding:6px 0;border-top:1px solid #eceee8}
    .wall-order-input{width:100%;min-width:0;padding:7px 8px;border:1px solid #b7bdb7;border-radius:8px;background:#fff}.wall-order-rolls{text-align:center;font-weight:900}
    .wall-order-remove{border:0;background:transparent;font-size:18px;cursor:pointer;color:#8b4b45}.wall-order-status{font-size:12px;color:var(--muted);margin-top:8px}
    @media(max-width:900px){.wall-order-columns{display:none}.wall-order-row{grid-template-columns:1fr 1fr}.wall-order-row .wall-order-note-input{grid-column:1/-1}.wall-order-remove{justify-self:end}}
  `;
  document.head.appendChild(style);

  function retailUrl() {
    return `/admin/api/paint/wallpaper-pricelist/retail${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  }

  function cleanRetailOnly() {
    document.getElementById("wallpaperTradeBtn")?.remove();
    const retailBtn = document.getElementById("wallpaperRetailBtn");
    if (retailBtn) retailBtn.textContent = "Tapeten Retail";

    const admin = document.getElementById("wallpaperPriceAdmin");
    if (admin) {
      const tradeInput = document.getElementById("wallTradeFile");
      tradeInput?.closest(".filebox")?.remove();
      const title = admin.querySelector("h2");
      if (title) title.textContent = "LG Tapeten · Retail-Preisliste";
      const desc = admin.querySelector("p.muted");
      if (desc) desc.textContent = "Nur die Retail/RRP-Liste wird in KRISTINE hinterlegt. Das PDF bleibt auf dem Datenlaufwerk und landet nicht im öffentlichen Repo.";
      const grid = admin.querySelector(".wallpaper-admin");
      if (grid) grid.style.gridTemplateColumns = "1fr";
      const retailLabel = document.getElementById("wallRetailFile")?.closest(".filebox")?.querySelector("b");
      if (retailLabel) retailLabel.textContent = "Tapeten Retail / RRP";
      const retailImport = document.getElementById("wallRetailImport");
      if (retailImport) retailImport.textContent = "Retail-PDF importieren";
    }
  }

  function addKpi() {
    const kpis = document.querySelector(".commercialKpis");
    if (!kpis || document.getElementById("wallpaperOrderKpi")) return;
    const span = document.createElement("span");
    span.id = "wallpaperOrderKpi";
    span.className = "fy";
    span.textContent = "Tapeten: 0 Rollen";
    kpis.appendChild(span);
  }

  async function refreshKpi() {
    addKpi();
    try {
      const data = await api("/admin/api/paint/wallpaper-order");
      const el = document.getElementById("wallpaperOrderKpi");
      if (el) el.textContent = `Tapeten: ${Number(data.rollsTotal || 0)} Rollen`;
    } catch {}
  }

  function rowHtml(row = {}) {
    return `<div class="wall-order-row" data-wall-row data-id="${esc(row.id || "")}">
      <input class="wall-order-input" data-wall="collection" placeholder="Kollektion" value="${esc(row.collection || "")}">
      <input class="wall-order-input" data-wall="design" placeholder="Design / Tapete" value="${esc(row.design || "")}">
      <input class="wall-order-input" data-wall="colourway" placeholder="Farbweg" value="${esc(row.colourway || "")}">
      <input class="wall-order-input" data-wall="productCode" placeholder="Product Code" value="${esc(row.productCode || "")}">
      <input class="wall-order-input wall-order-rolls" data-wall="rolls" type="number" min="0" step="1" inputmode="numeric" placeholder="0" value="${Number(row.rolls || 0) || ""}">
      <input class="wall-order-input wall-order-note-input" data-wall="note" placeholder="Notiz" value="${esc(row.note || "")}">
      <button class="wall-order-remove" type="button" title="Zeile löschen">×</button>
    </div>`;
  }

  function ensurePanel() {
    if (document.getElementById("wallpaperOrderPanel")) return document.getElementById("wallpaperOrderPanel");
    const extras = document.querySelector(".order-extras");
    const inventoryCard = document.querySelector("#tab-inventory .card");
    if (!extras && !inventoryCard) return null;

    const button = document.createElement("button");
    button.id = "wallpaperOrderBtn";
    button.className = "btn";
    button.type = "button";
    button.textContent = "Tapeten bestellen";
    if (extras) extras.appendChild(button);

    const panel = document.createElement("div");
    panel.id = "wallpaperOrderPanel";
    panel.className = "wall-order-panel";
    panel.hidden = true;
    panel.innerHTML = `
      <div class="wall-order-head">
        <div><b>Tapeten-Bestellentwurf</b><div class="wall-order-note">Rollen hier eintragen. Retail-Liste daneben öffnen; Farbweg/Product Code bleibt bewusst ein eigenes Feld.</div></div>
        <div class="wall-order-tools"><button id="wallpaperRetailOpen" class="btn" type="button">Retail-Preisliste</button><button id="wallpaperAddRow" class="btn" type="button">+ Zeile</button><button id="wallpaperOrderSave" class="btn primary" type="button">Tapeten speichern</button></div>
      </div>
      <div class="wall-order-columns"><span>Kollektion</span><span>Design</span><span>Farbweg</span><span>Product Code</span><span>Rollen</span><span>Notiz</span><span></span></div>
      <div id="wallpaperOrderRows"></div><div id="wallpaperOrderStatus" class="wall-order-status"></div>`;

    if (extras?.parentNode) extras.parentNode.insertBefore(panel, extras.nextSibling);
    else inventoryCard.appendChild(panel);

    button.onclick = async () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) await loadWallpaperOrder();
    };
    panel.querySelector("#wallpaperRetailOpen").onclick = () => window.open(retailUrl(), "_blank", "noopener");
    panel.querySelector("#wallpaperAddRow").onclick = () => {
      const rows = panel.querySelector("#wallpaperOrderRows");
      rows.insertAdjacentHTML("beforeend", rowHtml());
      bindRemoveButtons();
      rows.querySelector("[data-wall-row]:last-child [data-wall='design']")?.focus();
    };
    panel.querySelector("#wallpaperOrderSave").onclick = saveWallpaperOrder;
    return panel;
  }

  function bindRemoveButtons() {
    document.querySelectorAll("#wallpaperOrderRows .wall-order-remove").forEach(button => {
      button.onclick = () => button.closest("[data-wall-row]")?.remove();
    });
  }

  async function loadWallpaperOrder() {
    const panel = ensurePanel();
    if (!panel) return;
    const rows = panel.querySelector("#wallpaperOrderRows");
    const status = panel.querySelector("#wallpaperOrderStatus");
    status.textContent = "Tapeten-Bestellung wird geladen …";
    try {
      const data = await api("/admin/api/paint/wallpaper-order");
      rows.innerHTML = (data.items || []).map(rowHtml).join("") || rowHtml();
      bindRemoveButtons();
      status.textContent = `${Number(data.rollsTotal || 0)} Rollen im Entwurf`;
    } catch (error) {
      rows.innerHTML = rowHtml();
      bindRemoveButtons();
      status.textContent = error.message;
    }
  }

  async function saveWallpaperOrder() {
    const panel = ensurePanel();
    if (!panel) return;
    const status = panel.querySelector("#wallpaperOrderStatus");
    const items = [...panel.querySelectorAll("[data-wall-row]")].map(row => ({
      id: row.dataset.id || "",
      collection: row.querySelector("[data-wall='collection']")?.value || "",
      design: row.querySelector("[data-wall='design']")?.value || "",
      colourway: row.querySelector("[data-wall='colourway']")?.value || "",
      productCode: row.querySelector("[data-wall='productCode']")?.value || "",
      rolls: row.querySelector("[data-wall='rolls']")?.value || 0,
      note: row.querySelector("[data-wall='note']")?.value || "",
    }));
    status.textContent = "Tapeten-Bestellung wird gespeichert …";
    try {
      const data = await api("/admin/api/paint/wallpaper-order", { method: "POST", body: JSON.stringify({ items }) });
      status.textContent = `Gespeichert: ${Number(data.rollsTotal || 0)} Rollen · ${Number(data.count || 0)} Positionen`;
      await refreshKpi();
      if (typeof window.loadCommercial === "function") window.loadCommercial();
    } catch (error) {
      status.textContent = error.message;
    }
  }

  function addTopOrderButton() {
    const actions = document.querySelector(".commercialActions");
    if (!actions || document.getElementById("wallpaperTopOrderBtn")) return;
    const button = document.createElement("button");
    button.id = "wallpaperTopOrderBtn";
    button.className = "btn";
    button.type = "button";
    button.textContent = "Tapeten bestellen";
    const retail = document.getElementById("wallpaperRetailBtn");
    if (retail?.nextSibling) actions.insertBefore(button, retail.nextSibling);
    else actions.insertBefore(button, actions.firstChild);
    button.onclick = async () => {
      if (typeof window.showTab === "function") window.showTab("inventory");
      const panel = ensurePanel();
      if (panel) {
        panel.hidden = false;
        await loadWallpaperOrder();
        panel.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    };
  }

  cleanRetailOnly();
  ensurePanel();
  addTopOrderButton();
  refreshKpi();
})();
