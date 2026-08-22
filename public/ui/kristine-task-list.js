"use strict";

(function () {
  const attachmentCache = new Map();

  function completedStamp(task) {
    return String(task?.completedAt || task?.doneAt || task?.updatedAt || task?.createdAt || task?.id || "");
  }

  function createdStamp(task) {
    return String(task?.createdAt || task?.id || "");
  }

  function dueStamp(task) {
    return String(task?.dueDate || "9999-12-31");
  }

  function tokenUrl(path) {
    const url = new URL(path, location.origin);
    const token = new URLSearchParams(location.search).get("token");
    if (token && url.origin === location.origin) url.searchParams.set("token", token);
    return url.origin === location.origin ? url.pathname + url.search + url.hash : url.href;
  }

  function bytesLabel(bytes) {
    const value = Number(bytes || 0);
    if (!value) return "";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
    return `${(value / 1024 / 1024).toFixed(1).replace(".0", "")} MB`;
  }

  function isMailItem(item) {
    const name = String(item?.name || item?.storedFilename || "").toLowerCase();
    const mime = String(item?.mimeType || "").toLowerCase();
    return name.endsWith(".msg") || name.endsWith(".eml") || mime.includes("ms-outlook") || mime === "message/rfc822";
  }

  async function fetchInboxItem(itemId) {
    const response = await fetch(tokenUrl(`/kristine/api/inbox/${encodeURIComponent(String(itemId || ""))}`));
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) throw new Error(json?.error || text || response.statusText);
    return json?.item || null;
  }

  async function openMailPreview(itemId) {
    const preview = window.open("", "_blank");
    if (!preview) {
      alert("Mail-Vorschau konnte nicht geöffnet werden. Bitte Pop-ups für KRISTINE erlauben.");
      return;
    }
    try { preview.opener = null; } catch {}

    preview.document.open();
    preview.document.write('<!doctype html><html lang="de"><head><meta charset="utf-8"><title>KRISTINE Mail</title></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:24px;color:#222">Mail wird geladen …</body></html>');
    preview.document.close();

    try {
      const item = await fetchInboxItem(itemId);
      if (!item) throw new Error("Mail nicht gefunden");
      const analysis = item.analysis || {};
      const body = String(item.textPreview || analysis.excerpt || analysis.summary || "").trim();
      const meta = [
        analysis.contactName ? `<div><strong>Kontakt:</strong> ${esc(analysis.contactName)}</div>` : "",
        analysis.contactEmail ? `<div><strong>E-Mail:</strong> ${esc(analysis.contactEmail)}</div>` : "",
        analysis.contactPhone ? `<div><strong>Telefon:</strong> ${esc(analysis.contactPhone)}</div>` : "",
        analysis.dueDate ? `<div><strong>Termin/Fällig:</strong> ${esc(analysis.dueDate)}</div>` : ""
      ].filter(Boolean).join("");

      preview.document.open();
      preview.document.write(`<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(analysis.subject || item.name || "KRISTINE Mail")}</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:#f3f1ec;color:#222}
main{max-width:980px;margin:0 auto;padding:24px}
.card{background:#fff;border-radius:16px;padding:20px;box-shadow:0 2px 15px rgba(0,0,0,.07)}
h1{font-size:22px;margin:0 0 8px}.file{font-size:12px;color:#777;margin-bottom:16px}.meta{display:grid;gap:4px;padding:12px;background:#f7f7f4;border-radius:10px;margin-bottom:16px;font-size:13px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0}
a{display:inline-block;margin-top:16px;text-decoration:none;background:#27713d;color:#fff;border-radius:9px;padding:9px 12px;font-weight:750}
</style>
</head>
<body>
<main><div class="card">
<h1>${esc(analysis.subject || item.name || "Mail")}</h1>
<div class="file">${esc(item.name || "")}</div>
${meta ? `<div class="meta">${meta}</div>` : ""}
<pre>${esc(body || "Für diese MSG-Datei konnte kein lesbarer Mailtext extrahiert werden.")}</pre>
<a href="${tokenUrl(`/kristine/api/inbox/${encodeURIComponent(item.id)}/file`)}" download="${esc(item.name || "mail.msg")}">Originaldatei herunterladen</a>
</div></main>
</body></html>`);
      preview.document.close();
    } catch (error) {
      preview.document.open();
      preview.document.write(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>KRISTINE Mail</title></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:24px;color:#8b1f1f"><strong>Mail konnte nicht gelesen werden.</strong><br>${esc(String(error?.message || error))}</body></html>`);
      preview.document.close();
    }
  }

  async function fetchTaskAttachments(taskId, force = false) {
    const id = String(taskId || "");
    if (!id) return [];
    const cached = attachmentCache.get(id);
    const maxAge = cached?.items?.length ? 60000 : 1500;
    if (!force && cached && Date.now() - cached.at < maxAge) return cached.items;

    const response = await fetch(tokenUrl(`/kristine/api/inbox/task/${encodeURIComponent(id)}`));
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) throw new Error(json?.error || text || response.statusText);
    const items = Array.isArray(json?.items) ? json.items : [];
    attachmentCache.set(id, { at: Date.now(), items });
    return items;
  }

  function installStyle() {
    if (document.getElementById("kristaCompactTaskStyle")) return;
    const style = document.createElement("style");
    style.id = "kristaCompactTaskStyle";
    style.textContent = `
      #taskList{display:grid;gap:6px}
      #taskList .krista-task-row{
        display:grid;
        grid-template-columns:minmax(220px,2fr) minmax(130px,.9fr) minmax(150px,1fr) minmax(145px,.9fr) auto;
        gap:10px;
        align-items:center;
        background:#fff;
        border:1px solid #e7e3dc;
        border-left:4px solid #27713d;
        border-radius:10px;
        padding:8px 10px;
        min-height:44px;
      }
      #taskList .krista-task-row.done{border-left-color:#8aa48f;background:#fbfcfa}
      #taskList .krista-task-title{font-weight:850;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #taskList .krista-task-sub{font-size:11px;color:#707070;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #taskList .krista-task-cell{min-width:0}
      #taskList .krista-task-actions{display:flex;gap:5px;justify-content:flex-end;align-items:center}
      #taskList .krista-task-actions button{padding:6px 8px;border-radius:7px;font-size:11px;white-space:nowrap}
      #taskList .krista-task-badge{display:inline-flex;align-items:center;border-radius:999px;padding:3px 6px;background:#f0f0ed;font-size:10px;font-weight:800;margin-right:4px}
      #taskList .krista-task-attachment-button{background:#f7f7f4;color:#222;border-color:#cfcac1;font-weight:800}
      #taskList .krista-task-attachment-button[hidden]{display:none!important}
      .krista-task-attachments-panel{margin-top:14px;padding:13px;border:1px solid #e2ded6;border-radius:12px;background:#faf9f6}
      .krista-task-attachments-panel h5{margin:0 0 9px;font-size:14px}
      .krista-task-attachment-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px 0;border-top:1px solid #ebe7df}
      .krista-task-attachment-row:first-of-type{border-top:0}
      .krista-task-attachment-name{font-weight:750;overflow-wrap:anywhere}
      .krista-task-attachment-meta{font-size:11px;color:#707070;margin-top:2px}
      .krista-task-attachment-links{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
      .krista-task-attachment-links a,.krista-task-attachment-links button{display:inline-flex;align-items:center;text-decoration:none;background:#fff;color:#222;border:1px solid #ccc;border-radius:8px;padding:6px 8px;font-size:11px;font-weight:750}
      .krista-task-attachment-links button{cursor:pointer}
      .krista-task-attachment-empty{font-size:12px;color:#777}
      @media(max-width:900px){
        #taskList .krista-task-row{grid-template-columns:minmax(180px,1fr) auto}
        #taskList .krista-task-row>.krista-task-cell:nth-child(2),
        #taskList .krista-task-row>.krista-task-cell:nth-child(3),
        #taskList .krista-task-row>.krista-task-cell:nth-child(4){display:none}
        .krista-task-attachment-row{grid-template-columns:1fr}
        .krista-task-attachment-links{justify-content:flex-start}
      }
    `;
    document.head.appendChild(style);
  }

  function attachmentPanelHost() {
    const modalList = document.getElementById("taskModalList");
    if (!modalList) return null;
    return modalList.querySelector(".task-modal-item");
  }

  function renderAttachmentPanel(taskId, items, error = "") {
    const host = attachmentPanelHost();
    if (!host) return null;
    let panel = host.querySelector(".krista-task-attachments-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.className = "krista-task-attachments-panel";
      const actions = host.querySelector(":scope > .actions");
      if (actions) host.insertBefore(panel, actions);
      else host.appendChild(panel);
    }
    panel.dataset.taskId = String(taskId || "");

    if (error) {
      panel.innerHTML = `<h5>📎 Anlagen</h5><div class="krista-task-attachment-empty">Anlagen konnten nicht geladen werden: ${esc(error)}</div>`;
      return panel;
    }

    if (!items.length) {
      panel.innerHTML = '<h5>📎 Anlagen</h5><div class="krista-task-attachment-empty">Keine Anlagen mit dieser Aufgabe verknüpft.</div>';
      return panel;
    }

    panel.innerHTML = `<h5>📎 Anlagen · ${items.length}</h5>${items.map((item) => {
      const href = tokenUrl(`/kristine/api/inbox/${encodeURIComponent(item.id)}/file`);
      const meta = [item.mimeType || "", bytesLabel(item.size)].filter(Boolean).join(" · ");
      const openAction = isMailItem(item)
        ? `<button type="button" data-mail-preview="${esc(String(item.id || ""))}">Mail lesen</button>`
        : `<a href="${href}" target="_blank" rel="noopener">Öffnen</a>`;
      return `<div class="krista-task-attachment-row"><div><div class="krista-task-attachment-name">${esc(item.name || "Anlage")}</div>${meta ? `<div class="krista-task-attachment-meta">${esc(meta)}</div>` : ""}</div><div class="krista-task-attachment-links">${openAction}<a href="${href}" download="${esc(item.name || "Anlage")}">Herunterladen</a></div></div>`;
    }).join("")}`;

    panel.querySelectorAll("[data-mail-preview]").forEach((button) => {
      button.addEventListener("click", () => openMailPreview(button.dataset.mailPreview));
    });
    return panel;
  }

  async function loadAttachmentPanel(taskId, { force = true, scroll = false } = {}) {
    const host = attachmentPanelHost();
    if (!host) return;
    let panel = host.querySelector(".krista-task-attachments-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.className = "krista-task-attachments-panel";
      panel.innerHTML = '<h5>📎 Anlagen</h5><div class="krista-task-attachment-empty">Lade Anlagen …</div>';
      const actions = host.querySelector(":scope > .actions");
      if (actions) host.insertBefore(panel, actions);
      else host.appendChild(panel);
    }
    panel.dataset.taskId = String(taskId || "");

    try {
      const items = await fetchTaskAttachments(taskId, force);
      const current = host.querySelector(".krista-task-attachments-panel");
      if (!current || current.dataset.taskId !== String(taskId || "")) return;
      const rendered = renderAttachmentPanel(taskId, items);
      if (scroll && items.length) rendered?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (error) {
      renderAttachmentPanel(taskId, [], String(error?.message || error));
    }
  }

  async function hydrateAttachmentButton(button, force = false) {
    const taskId = String(button?.dataset?.taskAttachments || "");
    if (!taskId) return;
    try {
      const items = await fetchTaskAttachments(taskId, force);
      if (!button.isConnected || String(button.dataset.taskAttachments || "") !== taskId) return;
      if (items.length) {
        button.hidden = false;
        button.textContent = `📎 ${items.length}`;
        button.title = `${items.length} Anlage${items.length === 1 ? "" : "n"} öffnen`;
      } else {
        button.hidden = true;
      }
    } catch {
      if (button.isConnected) button.hidden = true;
    }
  }

  function hydrateAttachmentButtons(force = false) {
    document.querySelectorAll("#taskList [data-task-attachments]").forEach((button) => {
      if (!button.dataset.attachmentClick) {
        button.dataset.attachmentClick = "1";
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const taskId = String(button.dataset.taskAttachments || "");
          if (!taskId) return;
          if (typeof window.openTaskListModal === "function") window.openTaskListModal(taskId);
          setTimeout(() => loadAttachmentPanel(taskId, { force: true, scroll: true }), 0);
        });
      }
      hydrateAttachmentButton(button, force);
    });
  }

  function installTaskModalHook() {
    if (typeof window.openTaskListModal !== "function" || window.openTaskListModal.__kristaAttachments) return;
    const original = window.openTaskListModal;
    const wrapped = function (focusId = "") {
      const result = original.apply(this, arguments);
      if (focusId) setTimeout(() => loadAttachmentPanel(String(focusId), { force: true }), 0);
      return result;
    };
    wrapped.__kristaAttachments = true;
    window.openTaskListModal = wrapped;
  }

  function compactRenderTasks() {
    let tasks = [...(data?.tasks || [])];

    if (taskFilter === "newest" || taskFilter === "open") {
      tasks = tasks.filter((task) => task.status !== "done");
    } else if (taskFilter === "done") {
      tasks = tasks.filter((task) => task.status === "done");
    }

    if (taskFilter === "done") {
      tasks.sort((a, b) => completedStamp(b).localeCompare(completedStamp(a)));
    } else if (taskFilter === "newest") {
      tasks.sort((a, b) => createdStamp(b).localeCompare(createdStamp(a)));
    } else {
      tasks.sort((a, b) => dueStamp(a).localeCompare(dueStamp(b)) || createdStamp(b).localeCompare(createdStamp(a)));
    }

    const list = document.getElementById("taskList");
    if (!list) return;

    list.innerHTML = tasks.length ? tasks.map((task) => {
      const job = (masterJobs || []).find((row) => String(row.jobId) === String(task.jobId));
      const priority = task.priority === "sofort" ? "🔴 Sofort" : task.priority === "heute" ? "🟡 Heute" : "🟢 Normal";
      const statusTime = task.status === "done"
        ? (task.completedAt ? new Date(task.completedAt).toLocaleString("de-AT", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" }) : "erledigt")
        : (typeof taskDueLabel === "function" ? taskDueLabel(task.dueDate) : (task.dueDate || "–"));
      const site = task.jobName || job?.name || "";
      return `<div class="krista-task-row ${task.status === "done" ? "done" : ""}">
        <div class="krista-task-cell"><div class="krista-task-title">${esc(task.title || "Aufgabe")}</div><div class="krista-task-sub"><span class="krista-task-badge">${esc(task.taskType || "Aufgabe")}</span><span class="krista-task-badge">${priority}</span>${task.reminder ? ` ${esc(task.reminder)}` : ""}</div></div>
        <div class="krista-task-cell"><strong>${esc(task.assigneeName || task.assigneeId || "–")}</strong><div class="krista-task-sub">für</div></div>
        <div class="krista-task-cell"><strong>${esc(site || "–")}</strong><div class="krista-task-sub">Baustelle</div></div>
        <div class="krista-task-cell"><strong>${esc(statusTime)}</strong><div class="krista-task-sub">${task.status === "done" ? "erledigt" : "fällig"}</div></div>
        <div class="krista-task-actions"><button type="button" class="secondary krista-task-attachment-button" data-task-attachments="${esc(String(task.id || ""))}" hidden>📎</button><button class="secondary" onclick="openTaskListModal('${task.id}')">Details</button>${task.status !== "done" ? `<button class="green" onclick="markTaskDone('${task.id}')">✓</button>` : ""}<button class="danger" onclick="removeTask('${task.id}')">×</button></div>
      </div>`;
    }).join("") : '<span class="small">Keine Aufgaben.</span>';

    hydrateAttachmentButtons(false);
    setTimeout(() => hydrateAttachmentButtons(true), 1800);
  }

  function install() {
    installStyle();
    installTaskModalHook();
    if (typeof window.renderTasks !== "function" || window.renderTasks.__kristaCompact) {
      hydrateAttachmentButtons(false);
      return;
    }
    compactRenderTasks.__kristaCompact = true;
    window.renderTasks = compactRenderTasks;
    compactRenderTasks();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once:true });
  else install();

  setInterval(() => {
    installTaskModalHook();
    hydrateAttachmentButtons(false);
  }, 3000);
})();
