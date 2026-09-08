"use strict";

(function installKristineNfon(){
  const token = new URLSearchParams(location.search).get("token") || "";
  const tapiBaseUrl = "http://127.0.0.1:17834";
  let status = null;
  let tapiStatus = null;
  let pendingPhone = "";
  let lastIncomingEventId = 0;
  let incomingPollBusy = false;
  const incomingCalls = new Map();

  function endpoint(path) {
    return path + (token ? `${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : "");
  }
  async function request(path, options = {}) {
    const response = await fetch(endpoint(path), options);
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) throw new Error(body?.error || text || `HTTP ${response.status}`);
    return body;
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>\"]/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" })[char]);
  }
  async function tapiRequest(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    try {
      const response = await fetch(tapiBaseUrl + path, {
        ...options,
        mode: "cors",
        cache: "no-store",
        signal: controller.signal,
        headers: { "X-Kristine-TAPI": "1", ...(options.headers || {}) },
      });
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch {}
      if (!response.ok) throw new Error(body?.error || text || `HTTP ${response.status}`);
      return body;
    } finally {
      clearTimeout(timeout);
    }
  }
  function ensureDialog() {
    let dialog = document.getElementById("kristineNfonDialog");
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.id = "kristineNfonDialog";
    dialog.style.cssText = "border:0;border-radius:16px;padding:0;box-shadow:0 24px 80px #0005;width:min(460px,calc(100% - 24px))";
    dialog.innerHTML = `<div style="padding:18px"><h3 style="margin:0 0 8px">Über NFON anrufen</h3><div id="kristineNfonNumber" style="font-weight:800;margin-bottom:14px"></div><div id="kristineNfonChoices" style="display:grid;gap:8px"></div><div id="kristineNfonMessage" class="small" style="margin-top:12px"></div><div class="actions" style="margin-top:14px"><button type="button" class="secondary" data-nfon-close>Schließen</button></div></div>`;
    dialog.querySelector("[data-nfon-close]").onclick = () => dialog.close();
    document.body.appendChild(dialog);
    return dialog;
  }
  function ensureIncomingDialog() {
    let dialog = document.getElementById("kristineIncomingCallDialog");
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.id = "kristineIncomingCallDialog";
    dialog.style.cssText = "border:0;border-radius:18px;padding:0;box-shadow:0 24px 90px #0007;width:min(520px,calc(100% - 24px));z-index:10001";
    dialog.innerHTML = `<div style="padding:20px"><div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px"><div><div style="color:#16844b;font-weight:800;font-size:13px;text-transform:uppercase;letter-spacing:.05em">📞 Eingehender Anruf</div><h3 id="kristineIncomingNumber" style="margin:5px 0 2px;font-size:25px"></h3><div id="kristineIncomingState" class="small"></div></div><button type="button" class="secondary" data-incoming-close aria-label="Schließen">✕</button></div><div id="kristineIncomingMatches" style="display:grid;gap:9px;margin-top:16px"></div><div id="kristineIncomingMessage" class="small" style="margin-top:12px"></div></div>`;
    dialog.querySelector("[data-incoming-close]").onclick = () => dialog.close();
    document.body.appendChild(dialog);
    return dialog;
  }
  function incomingCallKey(event) {
    return String(event.callId || `${event.phone}:${event.extension || ""}`);
  }
  function stateLabel(state) {
    return ({ RING:"Es läutet", CONN:"Gespräch verbunden", BUSY:"Besetzt", DISC:"Anruf beendet", IDLE:"Anruf beendet", DIAL:"Anruf wird aufgebaut" })[state] || state || "Eingehender Anruf";
  }
  function openJob(jobId) {
    if (!jobId) return;
    location.href = endpoint(`/admin/akte/${encodeURIComponent(jobId)}`);
  }
  function openTask(taskId) {
    const dialog = ensureIncomingDialog();
    dialog.close();
    if (typeof window.openTaskListModal === "function") window.openTaskListModal(taskId || "");
    else if (typeof window.showTab === "function") window.showTab("tasks");
  }
  function prepareCallbackTask(phone) {
    ensureIncomingDialog().close();
    if (typeof window.showTab === "function") window.showTab("tasks");
    const title = document.getElementById("tTitle");
    const contactPhone = document.getElementById("tContactPhone");
    if (title && !title.value.trim()) title.value = "Rückruf – unbekannte Nummer";
    if (contactPhone) contactPhone.value = phone;
    const callbackType = document.querySelector('input[name="taskType"][value="Rückruf"]');
    if (callbackType) callbackType.checked = true;
    if (typeof window.updateTaskSelectionInfo === "function") window.updateTaskSelectionInfo();
    document.getElementById("tContactName")?.focus();
  }
  async function showIncomingCall(event) {
    const key = incomingCallKey(event);
    incomingCalls.set(key, event);
    const dialog = ensureIncomingDialog();
    dialog.dataset.callKey = key;
    dialog.querySelector("#kristineIncomingNumber").textContent = event.phone || "Unbekannte Nummer";
    dialog.querySelector("#kristineIncomingState").textContent = `${stateLabel(event.state)}${event.extension ? ` · Nebenstelle ${event.extension}` : ""}`;
    const matches = dialog.querySelector("#kristineIncomingMatches");
    const message = dialog.querySelector("#kristineIncomingMessage");
    matches.innerHTML = "";
    message.textContent = "Suche Kunden, Lieferanten und Aufgaben …";
    if (!dialog.open) dialog.showModal();
    try {
      const result = await request(`/kristine/api/nfon/lookup?phone=${encodeURIComponent(event.phone || "")}`);
      if (dialog.dataset.callKey !== key) return;
      const rows = Array.isArray(result.matches) ? result.matches : [];
      message.textContent = rows.length ? `${rows.length} passende Zuordnung${rows.length === 1 ? "" : "en"}` : "Nummer ist noch keinem Kontakt zugeordnet.";
      for (const row of rows) {
        const button = document.createElement("button");
        button.type = "button";
        button.style.cssText = "text-align:left;padding:11px 13px";
        const context = row.jobName || row.taskTitle || row.address || "";
        button.innerHTML = `<strong>${escapeHtml(row.name)}</strong><br><span class="small">${escapeHtml(row.role)}${context ? ` · ${escapeHtml(context)}` : ""}</span>`;
        button.onclick = () => row.jobId ? openJob(row.jobId) : openTask(row.taskId);
        matches.appendChild(button);
      }
      const callback = document.createElement("button");
      callback.type = "button";
      callback.className = "secondary";
      callback.textContent = rows.length ? "Andere Zuordnung / Rückruf-Aufgabe" : "Als Rückruf-Aufgabe erfassen";
      callback.onclick = () => prepareCallbackTask(event.phone || "");
      matches.appendChild(callback);
    } catch (error) {
      message.textContent = `Zuordnung konnte nicht geladen werden: ${error.message}`;
    }
  }
  function updateIncomingCall(event) {
    const key = incomingCallKey(event);
    incomingCalls.set(key, event);
    const dialog = ensureIncomingDialog();
    if (dialog.open && dialog.dataset.callKey === key) {
      dialog.querySelector("#kristineIncomingState").textContent = `${stateLabel(event.state)}${event.extension ? ` · Nebenstelle ${event.extension}` : ""}`;
    }
  }
  async function pollIncomingEvents() {
    if (!tapiStatus?.ready || incomingPollBusy) return;
    incomingPollBusy = true;
    try {
      const result = await tapiRequest(`/events?after=${lastIncomingEventId}`);
      if (Number(result.latestId || 0) < lastIncomingEventId) lastIncomingEventId = 0;
      const events = Array.isArray(result.events) ? result.events : [];
      for (const event of events) {
        lastIncomingEventId = Math.max(lastIncomingEventId, Number(event.id || 0));
        const state = String(event.state || "").toUpperCase();
        const age = Date.now() - Date.parse(event.receivedAt || 0);
        if ((state === "RING" || state === "DIAL") && age < 30000) await showIncomingCall(event);
        else updateIncomingCall(event);
      }
    } catch {
      // Der normale Statuscheck zeigt an, falls der lokale Connector beendet wurde.
    } finally {
      incomingPollBusy = false;
    }
  }
  async function callFrom(extension) {
    const dialog = ensureDialog();
    const message = dialog.querySelector("#kristineNfonMessage");
    const buttons = [...dialog.querySelectorAll("[data-nfon-extension]")];
    buttons.forEach(button => button.disabled = true);
    message.textContent = "NFON ruft zuerst die gewählte Nebenstelle an …";
    try {
      await request("/kristine/api/nfon/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extension, phone: pendingPhone }),
      });
      message.textContent = "✓ Anruf wurde gestartet. Bitte Hörer abnehmen.";
    } catch (error) {
      message.textContent = `Anruf konnte nicht gestartet werden: ${error.message}`;
      buttons.forEach(button => button.disabled = false);
    }
  }
  async function callViaTapi(phone) {
    const dialog = ensureDialog();
    pendingPhone = String(phone || "").trim();
    dialog.querySelector("h3").textContent = "Direkt über das Bürotelefon";
    dialog.querySelector("#kristineNfonNumber").textContent = pendingPhone;
    dialog.querySelector("#kristineNfonChoices").innerHTML = "";
    dialog.querySelector("#kristineNfonMessage").textContent = `Wähle über ${tapiStatus?.lineName || "TAPI"} …`;
    dialog.showModal();
    try {
      const result = await tapiRequest("/dial", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: pendingPhone }),
      });
      dialog.querySelector("#kristineNfonMessage").textContent = `✓ ${result.lineName || "Das Telefon"} wählt direkt.`;
    } catch (error) {
      tapiStatus = null;
      document.documentElement.dataset.tapiReady = "0";
      dialog.querySelector("#kristineNfonMessage").textContent = `Direktwahl nicht erreichbar: ${error.message}`;
      if (status?.ready) {
        const fallback = document.createElement("button");
        fallback.type = "button";
        fallback.textContent = "Stattdessen über NFON anrufen";
        fallback.onclick = () => openDialer(pendingPhone);
        dialog.querySelector("#kristineNfonChoices").replaceChildren(fallback);
      }
    }
  }
  function openDialer(phone) {
    if (!status?.ready) return;
    pendingPhone = String(phone || "").trim();
    const dialog = ensureDialog();
    dialog.querySelector("h3").textContent = "Über NFON anrufen";
    dialog.querySelector("#kristineNfonNumber").textContent = pendingPhone;
    dialog.querySelector("#kristineNfonMessage").textContent = "";
    dialog.querySelector("#kristineNfonChoices").innerHTML = status.officeExtensions.map(row =>
      `<button type="button" data-nfon-extension="${escapeHtml(row.extension)}">📞 ${escapeHtml(row.name)} · ${escapeHtml(row.extension)}</button>`
    ).join("");
    dialog.querySelectorAll("[data-nfon-extension]").forEach(button => {
      button.onclick = () => callFrom(button.dataset.nfonExtension);
    });
    dialog.showModal();
  }
  async function loadStatus() {
    try {
      status = await request("/kristine/api/nfon/status");
      document.documentElement.dataset.nfonReady = status.ready ? "1" : "0";
    } catch {
      status = null;
      document.documentElement.dataset.nfonReady = "0";
    }
  }
  async function loadTapiStatus() {
    try {
      tapiStatus = await tapiRequest("/status");
      document.documentElement.dataset.tapiReady = tapiStatus?.ready ? "1" : "0";
      pollIncomingEvents();
    } catch {
      tapiStatus = null;
      document.documentElement.dataset.tapiReady = "0";
    }
  }
  document.addEventListener("click", event => {
    const link = event.target.closest?.('a[href^="tel:"]');
    if (!link || (!tapiStatus?.ready && !status?.ready)) return;
    event.preventDefault();
    const phone = decodeURIComponent(link.getAttribute("href").slice(4));
    if (tapiStatus?.ready) callViaTapi(phone);
    else openDialer(phone);
  });
  loadStatus();
  loadTapiStatus();
  setInterval(pollIncomingEvents, 1500);
  setInterval(loadTapiStatus, 15000);
})();
