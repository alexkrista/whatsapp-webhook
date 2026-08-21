"use strict";
(function(){
  const token = new URLSearchParams(location.search).get("token") || "";
  const SESSION_KEY = "kristine-lg-inventory-scan-session-v1";
  const nativeFetch = window.fetch.bind(window);
  let refreshing = false;

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

  function fixZeroNote(){
    const note = document.getElementById("inventoryCountNote");
    if (!note) return;
    if (/Soll\s*=\s*0.*NICHT zum Inventur-Zähler/i.test(note.textContent || "")) {
      note.textContent = "Soll = 0 · Ist trotzdem erfassen. Diese Position zählt ganz normal zur Inventur.";
      note.classList.remove("zero");
    }
  }

  async function refreshCounter(){
    if (refreshing) return;
    const counter = document.getElementById("inventoryScanCounter");
    if (!counter) return;
    refreshing = true;
    try {
      const since = sessionSince();
      const response = await nativeFetch(urlWithToken("/admin/api/paint/inventory/session-count?since=" + encodeURIComponent(since)), {headers:{"Accept":"application/json"}});
      const data = await response.json().catch(()=>({}));
      if (response.ok && data.ok !== false) {
        counter.textContent = `${Number(data.done || 0)} / ${Number(data.total || 0)} gezählt`;
        counter.title = "Alle Lagerpositionen zählen – unabhängig von Soll/Mindest";
      }
    } catch {} finally {
      refreshing = false;
    }
  }

  // Nach jedem erfolgreichen Inventur-Speichern den echten, serverseitigen Zähler aktualisieren.
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
    fixZeroNote();
    const reset = document.getElementById("inventoryScanReset");
    if (reset && reset.dataset.realCounter !== "1") {
      reset.dataset.realCounter = "1";
      reset.addEventListener("click", () => setTimeout(refreshCounter, 80));
    }
  }

  install();
  refreshCounter();
  new MutationObserver(() => { install(); fixZeroNote(); }).observe(document.body, {childList:true, subtree:true, characterData:true});
  setInterval(refreshCounter, 5000);
})();
