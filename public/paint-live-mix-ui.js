(() => {
  "use strict";

  const qEl = document.getElementById("q");
  const resultsEl = document.getElementById("results");
  const detailEl = document.getElementById("detail");
  if (!qEl || !resultsEl || !detailEl || typeof api !== "function") return;

  const fallbackOnInput = qEl.oninput;
  let liveTimer = null;
  let liveGeneration = 0;
  let bridgeStatus = null;

  const style = document.createElement("style");
  style.textContent = `
    .mix-live-pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:5px 9px;background:#e3f2e7;color:#185c35;font-size:12px;font-weight:800}
    .mix-live-pill.offline{background:#fde0de;color:#8e261f}
    .mix-live-pill.wait{background:#fff0cf;color:#8a5a08}
    .mix-status-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:9px;font-size:12px;color:#666}
    .mix-status-line strong{font-weight:850}
    .stock .stockOrder{display:block;width:100%;margin-top:6px;padding:5px 6px;border:0;border-radius:7px;background:#ffffffc9;color:#24402f;font-size:10px;font-weight:850;cursor:pointer}
    .stock .stockOrder.remove{color:#8a2e27;background:#fff7f6}
    .stock .stockOrder:disabled{opacity:.55;cursor:wait}
    .live-note{font-size:12px;color:#6c746b;margin-top:7px}
  `;
  document.head.appendChild(style);

  function currentSystem() {
    try { return String(system || "LG").toUpperCase(); }
    catch { return "LG"; }
  }

  function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  function norm(value) { return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim(); }
  function baseKey(value) {
    const n = norm(value);
    if (["h","hi","hiwhite"].includes(n)) return "hiwhite";
    if (["m","medium"].includes(n)) return "medium";
    if (["d","deep"].includes(n)) return "deep";
    if (["xd","x","extradeep"].includes(n)) return "extradeep";
    if (["t","transparent"].includes(n)) return "transparent";
    if (["y","yellow"].includes(n)) return "yellow";
    if (["p","pastel"].includes(n)) return "pastel";
    if (["w","white","whiteasp"].includes(n)) return "whiteasp";
    return n;
  }
  function sizeKey(value) {
    const raw = String(value ?? "").toLowerCase().replace(/litre|liter|ltr/g,"l").replace(/\s+/g,"").replace(",", ".");
    if (/^250ml$|^0\.25l$/.test(raw)) return "0.25l";
    if (/^500ml$|^0\.5l$/.test(raw)) return "0.5l";
    if (/^750ml$|^0\.75l$/.test(raw)) return "0.75l";
    return raw;
  }
  function identity(product, base, size) { return `${norm(product)}|${baseKey(base)}|${sizeKey(size)}`; }

  function ensureStatusLine() {
    const card = qEl.closest(".card");
    if (!card) return null;
    let row = document.getElementById("liveMixStatusLine");
    if (!row) {
      row = document.createElement("div");
      row.id = "liveMixStatusLine";
      row.className = "mix-status-line";
      qEl.closest(".searchbox")?.insertAdjacentElement("afterend", row);
    }
    return row;
  }

  function renderBridgeStatus(status = bridgeStatus) {
    const row = ensureStatusLine();
    if (!row) return;
    if (currentSystem() !== "LG") {
      row.hidden = true;
      return;
    }
    row.hidden = false;

    if (!status) {
      row.innerHTML = `<span class="mix-live-pill wait">● Mischmaschine wird geprüft …</span>`;
      return;
    }

    if (status.online) {
      const machine = status.bridge?.machine ? ` · ${esc(status.bridge.machine)}` : "";
      row.innerHTML = `<span class="mix-live-pill">● Mischmaschine LIVE</span><span><strong>Innovatint verbunden</strong>${machine} · Lagerbestand aus Inventur/Lagerbuch</span>`;
      return;
    }

    const reason = !status.configured
      ? "Render-Schlüssel fehlt / Deployment noch nicht aktiv"
      : (status.bridge?.heartbeatAt ? "Worker meldet sich nicht aktuell" : "noch kein Heartbeat vom Misch-PC");
    row.innerHTML = `<span class="mix-live-pill offline">● Mischmaschine NICHT LIVE</span><span>${esc(reason)}</span>`;
  }

  async function refreshBridgeStatus() {
    try {
      bridgeStatus = await api("/admin/api/paint/live/status");
    } catch (error) {
      bridgeStatus = { configured: false, online: false, error: String(error?.message || error) };
    }
    renderBridgeStatus();
    return bridgeStatus;
  }

  async function waitForLive(requestId, generation) {
    for (let i = 0; i < 32; i += 1) {
      if (generation !== liveGeneration) throw new Error("abgebrochen");
      const row = await api(`/admin/api/paint/live/request/${encodeURIComponent(requestId)}`);
      if (row.status === "done") {
        if (row.error) throw new Error(row.error);
        return row.result;
      }
      await delay(i < 4 ? 180 : 320);
    }
    throw new Error("Mischmaschine antwortet nicht rechtzeitig");
  }

  async function liveSearch(text, generation) {
    const status = bridgeStatus || await refreshBridgeStatus();
    if (!status?.online) throw new Error("Mischmaschine ist nicht live verbunden");
    const queued = await api("/admin/api/paint/live/search", {
      method: "POST",
      body: JSON.stringify({ query: text }),
    });
    return await waitForLive(queued.requestId, generation);
  }

  async function liveProducts(hit, generation) {
    const queued = await api("/admin/api/paint/live/products", {
      method: "POST",
      body: JSON.stringify({ colourId: Number(hit.id), color: hit }),
    });
    return await waitForLive(queued.requestId, generation);
  }

  async function mergeAuditedStock(data) {
    const ledger = await api("/admin/api/paint/stock-ledger");
    const byIdentity = new Map((ledger.items || []).map(row => [row.identityKey || identity(row.product, row.baseName || row.baseCode, row.size), row]));

    for (const product of data?.products || []) {
      for (const size of product.sizes || []) {
        const key = identity(product.productName, product.baseName || product.baseCode, size.size);
        const row = byIdentity.get(key);
        if (!row) {
          size.stock = null;
          size.articleId = "";
          continue;
        }
        Object.assign(size, row);
      }
    }
    data.stockSource = "movement-ledger";
    return data;
  }

  function renderHits(rows) {
    resultsEl.innerHTML = "";
    for (const hit of rows || []) {
      const div = document.createElement("div");
      div.className = "hit";
      const card = hit.card ? `<span class="alias">${esc(hit.card)}</span>` : "";
      div.innerHTML = `<div><b>${esc(hit.code || hit.name || "")}</b></div><div>${card}</div>`;
      div.onclick = () => chooseLiveHit(hit);
      resultsEl.appendChild(div);
    }
    resultsEl.style.display = (rows || []).length ? "block" : "none";
  }

  async function chooseLiveHit(hit) {
    const generation = ++liveGeneration;
    try { selected = hit; } catch {}
    resultsEl.style.display = "none";
    qEl.value = hit.code || hit.name || "";
    detailEl.classList.remove("hidden");
    detailEl.innerHTML = `<span class="mix-live-pill">● Live Mischmaschine</span><p class="muted">Mischbare Produkte + Inventurbestand werden geladen …</p>`;
    try {
      const raw = await liveProducts(hit, generation);
      if (generation !== liveGeneration) return;
      const data = await mergeAuditedStock(raw);
      if (generation !== liveGeneration) return;
      renderLiveDetail(data);
    } catch (error) {
      if (String(error?.message || error) === "abgebrochen") return;
      detailEl.innerHTML = `<span class="mix-live-pill offline">● Mischmaschine/Lager nicht verfügbar</span><p class="muted">${esc(error?.message || error)}</p>`;
      await refreshBridgeStatus();
    }
  }

  function orderButton(size, product) {
    if (!size.identityKey) return "";
    const qty = Math.max(0, Number(size.effectiveOrderQuantity || 0));
    const removing = qty > 0;
    const label = removing ? `Bestellung: ${qty} · entfernen` : "+ 1 bestellen";
    return `<button class="stockOrder${removing ? " remove" : ""}"
      data-action="${removing ? "remove" : "add"}"
      data-product="${esc(size.product || product.productName || "")}"
      data-base-code="${esc(size.baseCode || product.baseCode || "")}"
      data-base-name="${esc(size.baseName || product.baseName || "")}"
      data-size="${esc(size.size || "")}"
      data-stock-code="${esc(size.stockCode || "")}">${esc(label)}</button>`;
  }

  function renderLiveDetail(data) {
    const color = data?.color || {};
    let html = `<div class="selected"><div><h2>${esc(color.name || color.code || "")}</h2><div class="muted">${esc(color.code || "")}</div><div class="live-note">Mischbarkeit + Basis LIVE aus Innovatint · IST aus Inventur/Lagerbuch · Soll/EAN/Preis aus KRISTINE</div></div><span class="mix-live-pill">● Mischmaschine LIVE</span></div>`;

    if (data?.products?.length) {
      html += `<div style="margin-top:14px">`;
      for (const product of data.products) {
        html += `<div class="product"><div class="prodhead"><div><div class="prodname">${esc(product.productName)}</div><div class="base">${esc(product.baseName || product.baseCode)}</div></div></div><div class="sizes">`;
        for (const size of product.sizes || []) {
          const stock = size.stock === null || size.stock === undefined ? null : Number(size.stock);
          const stockText = stock === null ? "—" : stock;
          const price = Number(size.purchasePrice || 0) > 0 ? `EK ${money(size.purchasePrice)}` : "";
          const target = Number(size.targetStock || 0);
          const extra = target > 0 ? `Soll ${target}` : "";
          const source = size.stockSource === "ledger" ? "Inventur/Lagerbuch" : "";
          html += `<div class="stock ${stockClass(stock)}" title="EAN ${esc(size.ean || "")}">${esc(size.size)}: ${stockText}<small>${[price,extra,source].filter(Boolean).join(" · ")}</small>${orderButton(size, product)}</div>`;
        }
        html += `</div></div>`;
      }
      html += `</div>`;
    } else {
      html += `<p class="muted">Innovatint meldet mischbare Produkte, aber zu dieser Produkt/Basis-Kombination ist kein Lagerartikel auf Render zugeordnet.</p>`;
    }

    detailEl.innerHTML = html;
    detailEl.classList.remove("hidden");
    detailEl.querySelectorAll(".stockOrder").forEach(button => {
      button.addEventListener("click", event => {
        event.stopPropagation();
        changeDirectOrder(button);
      });
    });
  }

  async function changeDirectOrder(button) {
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = "…";
    try {
      const add = button.dataset.action === "add";
      const result = await api("/admin/api/paint/order-direct", {
        method: "POST",
        body: JSON.stringify({
          product: button.dataset.product,
          baseCode: button.dataset.baseCode,
          baseName: button.dataset.baseName,
          size: button.dataset.size,
          stockCode: button.dataset.stockCode,
          mode: "manual",
          quantity: add ? 1 : 0,
        }),
      });
      const qty = Math.max(0, Number(result.item?.effectiveOrderQuantity || 0));
      button.dataset.action = qty > 0 ? "remove" : "add";
      button.classList.toggle("remove", qty > 0);
      button.textContent = qty > 0 ? `Bestellung: ${qty} · entfernen` : "+ 1 bestellen";
      if (typeof loadCommercial === "function") await loadCommercial();
    } catch (error) {
      button.textContent = oldText;
      alert(error?.message || error);
    } finally {
      button.disabled = false;
    }
  }

  qEl.oninput = event => {
    if (currentSystem() !== "LG") {
      renderBridgeStatus();
      if (typeof fallbackOnInput === "function") return fallbackOnInput.call(qEl, event);
      return;
    }

    renderBridgeStatus();
    clearTimeout(liveTimer);
    const text = String(event.target.value || "").trim();
    if (!text) {
      ++liveGeneration;
      resultsEl.style.display = "none";
      return;
    }

    const generation = ++liveGeneration;
    liveTimer = setTimeout(async () => {
      try {
        const rows = await liveSearch(text, generation);
        if (generation !== liveGeneration) return;
        renderHits(rows || []);
      } catch (error) {
        if (String(error?.message || error) === "abgebrochen") return;
        resultsEl.innerHTML = `<div class="hit"><div><b>Mischmaschine nicht live</b><div class="muted">${esc(error?.message || error)}</div></div></div>`;
        resultsEl.style.display = "block";
        detailEl.classList.add("hidden");
        await refreshBridgeStatus();
      }
    }, 180);
  };

  document.querySelectorAll("[data-system]").forEach(button => {
    button.addEventListener("click", () => setTimeout(renderBridgeStatus, 0));
  });

  for (const card of document.querySelectorAll("#tab-admin .card")) {
    if (/Excel-Erstimport/i.test(card.textContent || "")) card.classList.add("hidden");
  }

  ensureStatusLine();
  renderBridgeStatus();
  refreshBridgeStatus();
  setInterval(refreshBridgeStatus, 30000);
})();
