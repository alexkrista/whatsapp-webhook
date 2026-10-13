"use strict";

(() => {
  if (window.__kristaAccessLearnMulti) return;
  window.__kristaAccessLearnMulti = true;

  let session = null;
  let pollTimer = null;
  let tickTimer = null;
  let reviewQueue = [];
  let reviewPos = 0;
  let savingReview = false;
  let originalSaveEditor = null;
  let originalCloseEditor = null;

  function api(path, opts = {}) {
    const token = new URLSearchParams(location.search).get("token") || "";
    const headers = { ...(opts.headers || {}) };
    if (token) headers["X-Admin-Token"] = token;
    const u = path + (token ? (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token) : "");
    return fetch(u, { ...opts, headers, cache:"no-store" }).then(async r => {
      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!r.ok) throw new Error(data?.error || text || r.statusText);
      return data || {};
    });
  }

  function ensureUi() {
    const box = document.getElementById("learnBox");
    const countdown = document.getElementById("learnCountdown");
    if (!box || !countdown) return false;

    let count = document.getElementById("learnFoundCount");
    if (!count) {
      count = document.createElement("div");
      count.id = "learnFoundCount";
      count.className = "learnstate";
      count.style.cssText = "font-weight:900;font-size:16px;margin:8px 0";
      countdown.parentNode.insertBefore(count, countdown);
    }

    let finish = document.getElementById("learnFinishButton");
    const old = box.querySelector("button");
    if (!finish && old) {
      old.id = "learnFinishButton";
      old.textContent = "Einlesen beenden";
      old.onclick = () => finishMultiLearn();
      finish = old;
      finish.style.background = "#173d2a";
      finish.style.color = "#fff";
      finish.style.borderColor = "#173d2a";
    }
    return true;
  }

  function updateUi() {
    if (!session) return;
    const results = Array.isArray(session.results) ? session.results : [];
    const state = document.getElementById("learnState");
    const count = document.getElementById("learnFoundCount");
    const countdown = document.getElementById("learnCountdown");
    if (state) state.textContent = session.state === "reading" ? "Bürotür kehrt in den normalen Betrieb zurück. Chips werden einmalig ausgelesen …" : session.localState === "queued" ? "Warte auf Bestätigung vom Büro-PC …" : "Bürotür zum Einlesen geöffnet. Chips nacheinander an den Leser halten.";
    if (count) count.textContent = `${results.length} Chip${results.length === 1 ? "" : "s"} erkannt`;
    if (countdown) {
      const left = Math.max(0, Math.ceil((Date.parse(session.expiresAt || "") - Date.now()) / 1000));
      countdown.textContent = session.state === "reading" ? "Wird ausgelesen …" : left + " s";
    }
  }

  function stopTimers() {
    clearInterval(pollTimer);
    clearInterval(tickTimer);
    pollTimer = null;
    tickTimer = null;
  }

  function hideLearn() {
    stopTimers();
    const backdrop = document.getElementById("learnBackdrop");
    const box = document.getElementById("learnBox");
    if (backdrop) backdrop.style.display = "none";
    if (box) box.style.display = "none";
  }

  async function startMultiLearn() {
    try {
      ensureUi();
      const d = await api("/admin/api/access/learn/start", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ terminalId:"3" })
      });
      session = d.session;
      const backdrop = document.getElementById("learnBackdrop");
      const box = document.getElementById("learnBox");
      if (backdrop) backdrop.style.display = "block";
      if (box) box.style.display = "block";
      updateUi();
      stopTimers();
      tickTimer = setInterval(updateUi, 500);
      pollTimer = setInterval(pollMultiLearn, 1000);
      pollMultiLearn();
    } catch (e) {
      alert("Chip einlesen: " + e.message);
    }
  }

  async function pollMultiLearn() {
    if (!session) return;
    try {
      const d = await api("/admin/api/access/learn/" + encodeURIComponent(session.id));
      session = d.session;
      updateUi();
      if (session.state === "done") await finalizeSession(session);
      else if (session.state === "error") {
        hideLearn(); const message=session.error||"Einlesen nicht bestätigt"; session=null; alert(message);
      }
      else if (session.state === "expired") {
        hideLearn();
        session = null;
        alert("Kein Chip erkannt. Bitte Einlesen erneut starten.");
      }
    } catch (e) {
      console.warn("Chip-Sammeleinlesen", e);
    }
  }

  async function finishMultiLearn() {
    if (!session) { hideLearn(); return; }
    try {
      const d = await api("/admin/api/access/learn/finish", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ id:session.id })
      });
      session = d.session || session;
      updateUi();
      if (session.state === "done") await finalizeSession(session);
    } catch (e) {
      alert("Einlesen beenden: " + e.message);
    }
  }

  async function finalizeSession(done) {
    hideLearn();
    session = null;
    const results = Array.isArray(done?.results) ? done.results : [];
    const seen = new Set();
    reviewQueue = results.filter(x => {
      const key = String(x.internalChipNo || x.hardwareId || "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    reviewPos = 0;
    if (!reviewQueue.length) {
      alert("Kein Chip erkannt.");
      return;
    }
    if (typeof window.load === "function") await window.load(true);
    openCurrentReview();
  }

  function openCurrentReview() {
    if (reviewPos >= reviewQueue.length) {
      const count = reviewQueue.length;
      reviewQueue = [];
      reviewPos = 0;
      if (count) alert(`${count} Chip${count === 1 ? "" : "s"} eingelesen.`);
      return;
    }
    const row = reviewQueue[reviewPos];
    if (typeof window.openEditor !== "function") return;
    window.openEditor(String(row.internalChipNo || ""));
    setTimeout(() => {
      const sub = document.getElementById("editSub");
      if (sub) sub.textContent = `Chip ${reviewPos + 1} von ${reviewQueue.length} · ${sub.textContent || ""}`;
    }, 30);
  }

  function advanceReview() {
    if (!reviewQueue.length) return;
    reviewPos += 1;
    setTimeout(openCurrentReview, 80);
  }

  function installEditorQueue() {
    if (originalSaveEditor || typeof window.saveEditor !== "function" || typeof window.closeEditor !== "function") return;
    originalSaveEditor = window.saveEditor;
    originalCloseEditor = window.closeEditor;

    window.closeEditor = function (...args) {
      const hadQueue = reviewQueue.length > 0;
      const out = originalCloseEditor.apply(this, args);
      if (hadQueue && !savingReview) advanceReview();
      return out;
    };

    window.saveEditor = async function (...args) {
      savingReview = true;
      try {
        await originalSaveEditor.apply(this, args);
      } finally {
        savingReview = false;
      }
      const editor = document.getElementById("chipEditor");
      if (reviewQueue.length && editor?.style.display === "none") advanceReview();
    };
  }

  function install() {
    if (typeof window.startLearn !== "function" || typeof window.openEditor !== "function") {
      setTimeout(install, 100);
      return;
    }
    ensureUi();
    const toolbar = document.querySelector("#tab-access-events .toolbar") || document.querySelector("#tab-active .toolbar");
    if (toolbar && !document.getElementById("manualBookingRead")) {
      const button=document.createElement("button");
      button.id="manualBookingRead";
      button.type="button";
      button.textContent="Zutritte jetzt auslesen";
      const updateStatus=text=>{
        const panel=document.getElementById("manualBookingReadStatus");
        if(panel)panel.textContent=text;
      };
      button.onclick=async()=>{
        if(button.disabled)return;
        button.disabled=true;
        button.textContent="GANTNER wird ausgelesen …";
        updateStatus("Leseauftrag an PC-ALEX02 gesendet. Nur dieser Knopfdruck startet den GANTNER-Leser.");
        try {
          await api("/admin/api/access/bookings/read",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
          const deadline=Date.now()+4*60*1000;
          const check=async()=>{
            try {
              const response=await api("/admin/api/access/bookings/read");
              const job=response.job||{};
              if(job.state==="done"||job.state==="error"){
                button.disabled=false;
                button.textContent="Zutritte jetzt auslesen";
                const report=job.result||{},num=Number(report.count||0);
                const partial=(report.limitedTerminals||[]).length>0;
                const uncertain=(report.unverifiedTerminals||[]).length>0;
                const message=job.state==="error"?
                  "Auslesung nicht vollständig: "+(job.error||report.error||"Unbekannter Fehler.") :
                  num+" Chip-Buchungen gelesen · "+Number(report.stored??num)+" neu gesichert."+
                  (partial?" Leselimit erreicht; weitere Buchungen könnten vorhanden sein.":
                   uncertain?" Die alten GANTNER-Leser bestätigen das Ende des Speichers nicht zuverlässig. Auch nach 0 erkannten Chips können weitere System- und Chipereignisse folgen.":
                   " GANTNER hat das Ende seines Puffers bestätigt.");
                updateStatus(message);
                window.dispatchEvent(new Event("krista:access-read-finished"));
                return;
              }
            }catch(error){
              updateStatus("Warte auf Verbindung zum Zutritts-PC … "+error.message);
            }
            if(Date.now()<deadline)setTimeout(check,2000);
            else {
              button.disabled=false;
              button.textContent="Zutritte jetzt auslesen";
              updateStatus("Auftrag noch nicht bestätigt. Der lokale Speicher schützt bereits gelesene Ereignisse. Bitte später den Status prüfen.");
            }
          };
          check();
        }catch(error){
          button.disabled=false;
          button.textContent="Zutritte jetzt auslesen";
          updateStatus("Leseauftrag konnte nicht gestartet werden: "+error.message);
        }
      };
      toolbar.appendChild(button);
    }
    installEditorQueue();
    window.startLearn = startMultiLearn;
    window.finishMultiLearn = finishMultiLearn;
    window.cancelLearn = finishMultiLearn;
    console.log("KRISADMIN Sammeleinlesen: 5 Minuten · mehrere Chips · Einlesen beenden");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once:true });
  else install();
})();
