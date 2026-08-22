"use strict";
(function(){
  const token = new URLSearchParams(location.search).get("token") || "";
  const SESSION_KEY = "kristine-lg-inventory-scan-session-v1";
  const nativeFetch = window.fetch.bind(window);
  let refreshing = false;
  let latestMissing = [];

  function sessionSince(){
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      if (s?.startedAt) return s.startedAt;
    } catch {}
    return new Date().toISOString();
  }

  function urlWithToken(url){
    const join = url.includes("?") ? "&" : "?";
    return url + (token ? join + "token=" + encodeURIComponent(token) : "");
  }

  async function jsonGet(url){
    const response = await nativeFetch(urlWithToken(url), {headers:{"Accept":"application/json"}});
    const data = await response.json().catch(()=>({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || ("HTTP " + response.status));
    return data;
  }

  function ensureMissingUi(){
    const card = document.getElementById("inventoryScanCard");
    const tools = card?.querySelector(".inventory-scan-tools");
    if (!card || !tools) return;

    let button = document.getElementById("inventoryMissingBtn");
    if (!button) {
      button = document.createElement("button");
      button.id = "inventoryMissingBtn";
      button.className = "btn";
      button.type = "button";
      button.textContent = "Fehlende anzeigen";
      const reset = document.getElementById("inventoryScanReset");
      if (reset?.parentNode === tools) reset.insertAdjacentElement("afterend", button);
      else tools.appendChild(button);
      button.addEventListener("click", () => {
        const panel = document.getElementById("inventoryMissingPanel");
        if (!panel) return;
        panel.hidden = !panel.hidden;
        if (!panel.hidden) renderMissing();
      });
    }

    let panel = document.getElementById("inventoryMissingPanel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "inventoryMissingPanel";
      panel.hidden = true;
      panel.style.cssText = "margin:10px 0 4px;padding:10px 12px;border:1px solid #d7ddd8;border-radius:12px;background:#fff;font-size:13px";
      tools.insertAdjacentElement("afterend", panel);
    }
  }

  function renderMissing(){
    const panel = document.getElementById("inventoryMissingPanel");
    const button = document.getElementById("inventoryMissingBtn");
    if (button) button.textContent = latestMissing.length ? `Fehlende anzeigen (${latestMissing.length})` : "Alles gezählt ✓";
    if (!panel || panel.hidden) return;

    panel.replaceChildren();
    const title = document.createElement("div");
    title.style.cssText = "font-weight:950;margin-bottom:7px";
    title.textContent = latestMissing.length ? `${latestMissing.length} Lagerpositionen fehlen noch:` : "Alle Lagerpositionen mit Soll > 0 sind gezählt. ✓";
    panel.appendChild(title);

    for (const item of latestMissing) {
      const row = document.createElement("div");
      row.style.cssText = "padding:6px 0;border-top:1px solid #eceee8";
      const base = item.baseName || item.baseCode || "";
      row.textContent = [item.product, item.size, base].filter(Boolean).join(" · ");
      panel.appendChild(row);
    }
  }

  async function refreshCounter(){
    if (refreshing) return;
    const counter = document.getElementById("inventoryScanCounter");
    if (!counter) return;
    refreshing = true;
    try {
      ensureMissingUi();
      const since = sessionSince();
      const [sessionData, inventoryData] = await Promise.all([
        jsonGet("/admin/api/paint/inventory/session-count?since=" + encodeURIComponent(since)),
        jsonGet("/admin/api/paint/inventory"),
      ]);

      const counted = new Set((Array.isArray(sessionData.counted) ? sessionData.counted : []).map(String));
      const stockItems = (Array.isArray(inventoryData.items) ? inventoryData.items : [])
        .filter(item => item?.id && Number(item.targetStock || 0) > 0);
      latestMissing = stockItems.filter(item => !counted.has(String(item.id)));
      const done = stockItems.length - latestMissing.length;

      counter.textContent = `${done} / ${stockItems.length} gezählt`;
      counter.title = "Inventur zählt nur Lagerpositionen mit Soll > 0";
      renderMissing();
    } catch {} finally {
      refreshing = false;
    }
  }

  // Nach jedem erfolgreichen Inventur-Speichern Zähler und Fehlenden-Liste aktualisieren.
  window.fetch = async function(input, init){
    const rawUrl = typeof input === "string" ? input : (input?.url || "");
    const method = String(init?.method || "GET").toUpperCase();
    const response = await nativeFetch(input, init);
    if (response.ok && method === "POST" && /\/admin\/api\/paint\/inventory\/count(?:\?|$)/.test(rawUrl)) {
      setTimeout(refreshCounter, 80);
      setTimeout(refreshCounter, 450);
    }
    return response;
  };

  function install(){
    ensureMissingUi();
    const reset = document.getElementById("inventoryScanReset");
    if (reset && reset.dataset.realCounter !== "1") {
      reset.dataset.realCounter = "1";
      reset.addEventListener("click", () => setTimeout(refreshCounter, 80));
    }
  }

  install();
  refreshCounter();
  new MutationObserver(() => { install(); }).observe(document.body, {childList:true, subtree:true});
  setInterval(refreshCounter, 5000);
})();
