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
    .stock .stockOrder{display:block;width:100%;margin-top:6px;padding:4px 6px;border:0;border-radius:7px;background:#ffffffb8;color:#24402f;font-size:10px;font-weight:850;cursor:pointer}
    .stock .stockOrder:disabled{opacity:.55;cursor:wait}
    .live-note{font-size:12px;color:#6c746b;margin-top:7px}
  `;
  document.head.appendChild(style);

  function currentSystem() {
    try { return String(system || "LG").toUpperCase(); }
    catch { return "LG"; }
  }

  function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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
      row.innerHTML = `<span class="mix-live-pill">● Mischmaschine LIVE</span><span><strong>Innovatint verbunden</strong>${machine} · Lagerbestand kommt aus Render</span>`;
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
    detailEl.innerHTML = `<span class="mix-live-pill">● Live Mischmaschine</span><p class="muted">Mischbare Produkte werden geladen …</p>`;
    try {
      const data = await liveProducts(hit, generation);
      if (generation !== liveGeneration) return;
      renderLiveDetail(data);
    } catch (error) {
      if (String(error?.message || error) === "abgebrochen") return;
      detailEl.innerHTML = `<span class="mix-live-pill offline">● Mischmaschine NICHT LIVE</span><p class="muted">${esc(error?.message || error)}</p>`;
      await refreshBridgeStatus();
    }
  }

  function renderLiveDetail(data) {
    const color = data?.color || {};
    let html = `<div class="selected"><div><h2>${esc(color.name || color.code || "")}</h2><div class="muted">${esc(color.code || "")}</div><div class="live-note">Mischbarkeit + Basis LIVE aus Innovatint · IST/Soll/EAN/Preis aus KRISTINE/Render</div></div><span class="mix-live-pill">● Mischmaschine LIVE</span></div>`;

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
          const orderButton = size.articleId
            ? `<button class="stockOrder" data-article-id="${esc(size.articleId)}">+ Bestellung</button>`
            : "";
          html += `<div class="stock ${stockClass(stock)}" title="EAN ${esc(size.ean || "")}">${esc(size.size)}: ${stockText}<small>${[price,extra].filter(Boolean).join(" · ")}</small>${orderButton}</div>`;
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
        addOneToOrder(button.dataset.articleId, button);
      });
    });
  }

  async function addOneToOrder(articleId, button) {
    if (!articleId) return;
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = "…";
    try {
      const review = await api("/admin/api/paint/order-review");
      const item = (review.items || []).find(row => String(row.articleId) === String(articleId));
      if (!item) throw new Error("Artikel nicht in Bestellstamm");
      const next = Math.max(0, Number(item.quantity || 0)) + 1;
      await api("/admin/api/paint/order-review", {
        method: "POST",
        body: JSON.stringify({ rows: [{ articleId, mode: "manual", quantity: next }] }),
      });
      button.textContent = `Bestellung: ${next}`;
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
        // Für Little Greene KEIN stiller Rückfall mehr auf den alten importierten
        // Katalog: sonst sieht der Benutzer wieder die falsche Basis/Lager-Zuordnung.
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

  // Der alte Excel-Erstimport bleibt nur als Notfall-Backend erhalten.
  // Im laufenden Lagerbetrieb ist Render die einzige Bestandsquelle.
  for (const card of document.querySelectorAll("#tab-admin .card")) {
    if (/Excel-Erstimport/i.test(card.textContent || "")) card.classList.add("hidden");
  }

  ensureStatusLine();
  renderBridgeStatus();
  refreshBridgeStatus();
  setInterval(refreshBridgeStatus, 30000);
})();
