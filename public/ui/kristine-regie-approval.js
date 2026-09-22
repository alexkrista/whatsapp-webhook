"use strict";

(function () {
  const MARKER = "[REGIE_APPROVAL]";
  const PRECHECK_MARKER = "[REGIE_PRECHECK]";

  function safe(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function decode(value) {
    try { return decodeURIComponent(String(value || "")); } catch { return String(value || ""); }
  }

  function meta(task) {
    const reminder = String(task?.reminder || "");
    if(reminder.includes('[PHOTO_INBOX]'))return {reportId:'photo:'+reminder.split('groupId=')[1],photo:true};
    const marker = reminder.includes(PRECHECK_MARKER) ? PRECHECK_MARKER : reminder.includes(MARKER) ? MARKER : "";
    if (!marker) return null;
    const result = {};
    (reminder.split(marker, 2)[1] || "").split(";").forEach(part => {
      const index = part.indexOf("=");
      if (index >= 0) result[part.slice(0, index)] = decode(part.slice(index + 1));
    });
    result.stage = marker === PRECHECK_MARKER ? "bettina" : "alex";
    return result.reportId ? result : null;
  }

  function tasks() {
    try { return Array.isArray(data?.tasks) ? data.tasks : []; } catch { return []; }
  }

  function taskIdFromRow(row) {
    const button = row.querySelector('button[onclick*="openTaskListModal"]');
    return String(button?.getAttribute("onclick") || "").match(/openTaskListModal\(['"]([^'"]+)['"]\)/)?.[1] || "";
  }

  function reportUrl(reportId, taskId) {
    const url = new URL("/kristine/eingang", location.origin);
    if(reportId.startsWith('photo:'))url.searchParams.set('photoGroup',reportId.slice(6));else url.searchParams.set('reportId', reportId);
    if (taskId) url.searchParams.set("taskId", taskId);
    const token = new URLSearchParams(location.search).get("token");
    if (token) url.searchParams.set("token", token);
    return url.pathname + url.search;
  }

  function openButton(task, cssClass) {
    const details = meta(task);
    if (!details || task.status === "done") return "";
    const changes = details.stage === "bettina" && /ändern/i.test(String(task.title || ""));
    return `<button type="button" class="${cssClass}" onclick="location.href=&quot;${safe(reportUrl(details.reportId, task.id))}&quot;">${details.photo?'Fotos zuordnen':changes?'Regiebericht ändern':details.stage==='bettina'?'Regiebericht vorprüfen':'Regiebericht prüfen'}</button>`;
  }

  function decorateRows() {
    document.querySelectorAll("#taskList .krista-task-row").forEach(row => {
      const task = tasks().find(item => String(item.id) === taskIdFromRow(row));
      if (!task || !meta(task)) return;
      row.classList.add("krista-regie-task-row");
      const sub = row.querySelector(".krista-task-sub");
      if (sub) sub.textContent = meta(task).photo?'Fotoeingang · Zuordnung bestätigen':meta(task).stage==='bettina'?(/ändern/i.test(String(task.title||''))?'Von Alex · Änderung durch Bettina':'Vom Mitarbeiter · Vorprüfung durch Bettina'):'Von Bettina / Büro · wartet auf Alex';
      const actions = row.querySelector(".krista-task-actions");
      if (!actions) return;
      actions.querySelectorAll('button[onclick*="markTaskDone"]').forEach(button => button.remove());
      if (task.status !== "done" && !actions.querySelector(".krista-regie-open")) actions.insertAdjacentHTML("beforeend", openButton(task, "krista-regie-open"));
    });
  }

  function decorateModal(taskId) {
    const task = tasks().find(item => String(item.id) === String(taskId));
    if (!task || !meta(task)) return;
    const host = document.querySelector("#taskModalList .task-modal-item");
    const actions = host?.querySelector(":scope > .actions");
    if (!actions) return;
    host.querySelectorAll(".task-detail-grid strong").forEach(value => { if (String(value.textContent || "").includes(MARKER)||String(value.textContent || "").includes(PRECHECK_MARKER)||String(value.textContent||"").includes("[PHOTO_INBOX]")) value.textContent = meta(task).photo?'Bitte Fotos zuordnen':meta(task).stage==='bettina'?'Bitte Regiebericht vorprüfen':'Bitte Regiebericht prüfen'; });
    actions.querySelectorAll('button[onclick*="markTaskDone"]').forEach(button => button.remove());
    if (task.status !== "done" && !actions.querySelector(".krista-regie-open")) actions.insertAdjacentHTML("beforeend", openButton(task, "krista-regie-open"));
  }

  function installHooks() {
    if (typeof renderTasks === "function" && !renderTasks.__kristaRegieApproval) {
      const original = renderTasks;
      const wrapped = function () { const result = original.apply(this, arguments); setTimeout(decorateRows, 0); return result; };
      Object.assign(wrapped, original, { __kristaRegieApproval: true });
      window.renderTasks = wrapped;
    }
    if (typeof openTaskListModal === "function" && !openTaskListModal.__kristaRegieApproval) {
      const original = openTaskListModal;
      const wrapped = function (focusId = "") { const result = original.apply(this, arguments); if (focusId) setTimeout(() => decorateModal(focusId), 0); return result; };
      Object.assign(wrapped, original, { __kristaRegieApproval: true });
      window.openTaskListModal = wrapped;
    }
  }

  function install() {
    if (!document.getElementById("kristaRegieApprovalStyle")) {
      const style = document.createElement("style");
      style.id = "kristaRegieApprovalStyle";
      style.textContent = "#taskList .krista-regie-task-row{border-left-color:#b88a31}.krista-regie-open{background:#27713d!important;border-color:#27713d!important;color:#fff!important}";
      document.head.appendChild(style);
    }
    installHooks();
    decorateRows();
  }

  let refreshTimer = null;
  function refreshAfterReturn() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      if (document.visibilityState === "hidden" || typeof loadSilent !== "function") return;
      try { await loadSilent(); decorateRows(); } catch {}
    }, 120);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true }); else install();
  window.addEventListener("pageshow", event => { if (event.persisted) refreshAfterReturn(); });
  window.addEventListener("focus", refreshAfterReturn);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshAfterReturn(); });
  setInterval(() => { installHooks(); decorateRows(); }, 1200);
})();
