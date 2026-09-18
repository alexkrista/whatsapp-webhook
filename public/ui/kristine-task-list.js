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

  function personLabel(person) {
    if (!person) return "";
    if (typeof person === "string") return person;
    return String(person.label || (person.name && person.email ? `${person.name} <${person.email}>` : (person.email || person.name || "")));
  }

  function mailDateLabel(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;
    try {
      return new Intl.DateTimeFormat("de-AT", { weekday:"short", day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" }).format(date);
    } catch { return raw; }
  }

  function mailAttachmentHref(itemId, index, download = false) {
    const suffix = download ? "?download=1" : "";
    return tokenUrl(`/kristine/api/inbox/${encodeURIComponent(itemId)}/msg-attachment/${encodeURIComponent(index)}${suffix}`);
  }

  function voicemailHtml(item) {
    const voicemail = item?.voicemail;
    const subject = String(item?.mail?.subject || item?.analysis?.subject || item?.name || "");
    const hasAudio = (item?.mail?.attachments || []).some((attachment) => /\.(wav|mp3|m4a|ogg|oga|webm|aac|flac)$/i.test(String(attachment?.name || "")));
    if (!voicemail && !/voicemail|nfon/i.test(subject) && !hasAudio) return "";
    const transcript = String(voicemail?.transcript || "").trim();
    const error = String(voicemail?.error || "").trim();
    if (transcript) {
      const caller = [voicemail.callerName, voicemail.callerPhone].filter(Boolean).join(" · ");
      return `<section id="voicemailPanel" class="voicemail ok"><div class="voicemail-title">🎙️ Voicemail-Transkript${caller ? ` · ${esc(caller)}` : ""}</div><pre>${esc(transcript)}</pre><div class="voicemail-meta">Automatisch transkribiert${voicemail.transcribedAt ? ` · ${esc(mailDateLabel(voicemail.transcribedAt))}` : ""}</div></section>`;
    }
    return `<section id="voicemailPanel" class="voicemail error"><div class="voicemail-title">🎙️ Voicemail noch nicht transkribiert</div><div class="voicemail-error">${esc(error || "Die Transkription wurde noch nicht durchgeführt.")}</div><button type="button" id="retryVoicemail">Erneut transkribieren</button><div id="voicemailRetryStatus" class="voicemail-meta"></div></section>`;
  }

  async function openMailPreview(itemId) {
    const preview = window.open("", "_blank");
    if (!preview) {
      alert("Mail-Reader konnte nicht geöffnet werden. Bitte Pop-ups für KRISTINE erlauben.");
      return;
    }
    try { preview.opener = null; } catch {}

    preview.document.open();
    preview.document.write('<!doctype html><html lang="de"><head><meta charset="utf-8"><title>KRISTINE Mail</title></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:24px;color:#222;background:#f3f1ec">Mail wird sauber gelesen …</body></html>');
    preview.document.close();

    try {
      const item = await fetchInboxItem(itemId);
      if (!item) throw new Error("Mail nicht gefunden");
      const analysis = item.analysis || {};
      const mail = item.mail || {};
      const subject = mail.subject || analysis.subject || item.name || "Mail";
      const senderName = mail.senderName || analysis.contactName || "";
      const senderEmail = mail.senderEmail || analysis.contactEmail || "";
      const sender = senderName && senderEmail && senderName.toLowerCase() !== senderEmail.toLowerCase()
        ? `${senderName} <${senderEmail}>`
        : (senderEmail || senderName || "–");
      const to = (mail.to || []).map(personLabel).filter(Boolean).join("; ");
      const cc = (mail.cc || []).map(personLabel).filter(Boolean).join("; ");
      const sentAt = mailDateLabel(mail.sentAt);
      const body = String(mail.body || analysis.excerpt || item.textPreview || analysis.summary || "").trim();
      const bodyHtml = String(mail.bodyHtml || "").trim();
      const innerAttachments = Array.isArray(mail.attachments) ? mail.attachments : [];
      const voicemailBlock = voicemailHtml(item);
      const attachmentHtml = innerAttachments.length ? `<div class="attachments"><div class="attachments-title">📎 ${innerAttachments.length} Mail-Anlage${innerAttachments.length === 1 ? "" : "n"}</div><div class="attachment-list">${innerAttachments.map((att) => {
        const openHref = mailAttachmentHref(item.id, att.index, false);
        const downloadHref = mailAttachmentHref(item.id, att.index, true);
        const meta = [att.mimeType || "", bytesLabel(att.size)].filter(Boolean).join(" · ");
        return `<div class="attachment"><div class="attachment-copy"><strong>${esc(att.name || "Anlage")}</strong>${meta ? `<small>${esc(meta)}</small>` : ""}</div><div class="attachment-actions"><a href="${openHref}" target="_blank" rel="noopener">Öffnen</a><a href="${downloadHref}">Speichern</a></div></div>`;
      }).join("")}</div></div>` : "";

      preview.document.open();
      preview.document.write(`<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subject)}</title>
<style>
:root{font-family:Segoe UI,system-ui,-apple-system,Roboto,Arial,sans-serif;color:#222;background:#f3f1ec}*{box-sizing:border-box}body{margin:0;background:#f3f1ec}.top{background:#111;color:#fff;padding:13px 20px;font-weight:800;letter-spacing:.02em}.wrap{max-width:1080px;margin:0 auto;padding:22px}.mail{background:#fff;border-radius:16px;box-shadow:0 2px 18px rgba(0,0,0,.08);overflow:hidden}.head{padding:22px 24px 18px;border-bottom:1px solid #ece9e2}.subject{font-size:23px;font-weight:800;line-height:1.25;margin-bottom:16px}.sender{display:flex;gap:12px;align-items:flex-start}.avatar{width:42px;height:42px;border-radius:50%;background:#27713d;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:18px;flex:0 0 42px}.from{font-weight:750}.meta{font-size:13px;color:#666;line-height:1.55;margin-top:2px}.meta b{color:#333}.attachments{padding:14px 24px;border-bottom:1px solid #ece9e2;background:#faf9f6}.attachments-title{font-weight:800;font-size:13px;margin-bottom:9px}.attachment-list{display:grid;gap:7px}.attachment{background:#fff;border:1px solid #ddd8cf;border-radius:10px;padding:8px 10px;display:flex;justify-content:space-between;gap:12px;align-items:center}.attachment-copy{min-width:0}.attachment-copy strong{display:block;overflow-wrap:anywhere}.attachment-copy small{display:block;color:#777;margin-top:2px}.attachment-actions{display:flex;gap:6px;flex-wrap:wrap}.attachment-actions a,.footer a{display:inline-flex;text-decoration:none;border:1px solid #cfcac1;background:#fff;color:#222;border-radius:8px;padding:6px 9px;font-size:12px;font-weight:750}.body{padding:24px;min-height:300px}.plain{white-space:pre-wrap;overflow-wrap:anywhere;font:15px/1.55 Segoe UI,system-ui,-apple-system,Roboto,Arial,sans-serif;margin:0}.html-frame{border:0;width:100%;min-height:560px;background:#fff}.footer{padding:12px 24px 18px;border-top:1px solid #ece9e2;display:flex;gap:8px;align-items:center;flex-wrap:wrap}.footer .hint{color:#777;font-size:12px;margin-right:auto}@media(max-width:700px){.wrap{padding:10px}.head,.body,.attachments,.footer{padding-left:15px;padding-right:15px}.subject{font-size:19px}.attachment{align-items:flex-start;flex-direction:column}.html-frame{min-height:620px}}
.voicemail{margin:18px 24px 0;padding:16px 18px;border:1px solid #bdd8c3;border-left:5px solid #27713d;border-radius:12px;background:#f3faf4}.voicemail.error{border-color:#e3c1bd;border-left-color:#a83228;background:#fff7f5}.voicemail-title{font-weight:850;margin-bottom:8px}.voicemail pre{white-space:pre-wrap;overflow-wrap:anywhere;font:16px/1.55 Segoe UI,system-ui,-apple-system,Roboto,Arial,sans-serif;margin:0}.voicemail-error{color:#8b1f1f;margin-bottom:10px;white-space:pre-wrap}.voicemail button{border:0;border-radius:8px;padding:9px 13px;background:#27713d;color:#fff;font-weight:800;cursor:pointer}.voicemail button:disabled{opacity:.55;cursor:wait}.voicemail-meta{font-size:12px;color:#687269;margin-top:8px}@media(max-width:700px){.voicemail{margin-left:15px;margin-right:15px}}
</style>
</head>
<body>
<div class="top">KRISTINE · Mail</div>
<div class="wrap"><article class="mail">
<header class="head">
<div class="subject">${esc(subject)}</div>
<div class="sender"><div class="avatar">${esc((senderName || senderEmail || "M").trim().charAt(0).toUpperCase() || "M")}</div><div><div class="from">${esc(sender)}</div><div class="meta">${to ? `<div><b>An:</b> ${esc(to)}</div>` : ""}${cc ? `<div><b>Cc:</b> ${esc(cc)}</div>` : ""}${sentAt ? `<div><b>Gesendet:</b> ${esc(sentAt)}</div>` : ""}</div></div></div>
</header>
${attachmentHtml}
${voicemailBlock}
<section class="body">${bodyHtml ? '<iframe id="kristaMailHtml" class="html-frame" sandbox=""></iframe>' : `<pre class="plain">${esc(body || "Kein lesbarer Nachrichtentext vorhanden.")}</pre>`}</section>
<footer class="footer"><span class="hint">Original bleibt unverändert in KRISTINE gespeichert.</span><a href="${tokenUrl(`/kristine/api/inbox/${encodeURIComponent(item.id)}/file`)}" download="${esc(item.name || "mail.msg")}">Original .msg speichern</a></footer>
</article></div>
</body></html>`);
      preview.document.close();

      const retryButton = preview.document.getElementById("retryVoicemail");
      if (retryButton) {
        retryButton.onclick = async () => {
          const status = preview.document.getElementById("voicemailRetryStatus");
          retryButton.disabled = true;
          if (status) status.textContent = "Voicemail wird transkribiert …";
          try {
            const response = await fetch(tokenUrl(`/kristine/api/inbox/${encodeURIComponent(item.id)}/transcribe-voicemail`), { method: "POST" });
            const text = await response.text();
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch {}
            if (!response.ok) throw new Error(json?.error || text || response.statusText);
            const panel = preview.document.getElementById("voicemailPanel");
            if (panel) panel.outerHTML = voicemailHtml(json.item);
          } catch (error) {
            retryButton.disabled = false;
            if (status) status.textContent = `Fehler: ${String(error?.message || error)}`;
          }
        };
      }

      if (bodyHtml) {
        const frame = preview.document.getElementById("kristaMailHtml");
        if (frame) {
          frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: cid:"><style>html,body{margin:0;padding:0;background:#fff;color:#222;font:15px/1.55 Segoe UI,system-ui,-apple-system,Roboto,Arial,sans-serif}body{overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{color:#17662f}</style></head><body>${bodyHtml}</body></html>`;
        }
      }
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
      #taskList .krista-task-group{border:1px solid #ddd8cf;border-radius:12px;background:#f7f6f2;overflow:hidden}
      #taskList .krista-task-group>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;list-style:none;cursor:pointer;padding:11px 14px;background:#eeece6;font-weight:900;user-select:none}
      #taskList .krista-task-group>summary::-webkit-details-marker{display:none}
      #taskList .krista-task-group>summary:before{content:'▶';font-size:10px;color:#657068;transition:transform .15s}
      #taskList .krista-task-group[open]>summary:before{transform:rotate(90deg)}
      #taskList .krista-task-group-title{display:flex;align-items:center;gap:8px;margin-right:auto}
      #taskList .krista-task-group-count{display:inline-flex;min-width:27px;justify-content:center;border-radius:999px;padding:3px 8px;background:#fff;border:1px solid #d5d0c7;font-size:11px}
      #taskList .krista-task-group-rows{display:grid;gap:6px;padding:7px}
      #taskList .krista-task-group-empty{padding:10px 12px;color:#777;font-size:12px;background:#fff;border-radius:9px}
      #taskList .krista-task-file-group{display:grid;gap:6px;padding:0 0 7px}
      #taskList .krista-task-file-group:last-child{padding-bottom:0}
      #taskList .krista-task-file-bar{display:flex;align-items:center;gap:9px;min-height:34px;padding:7px 10px;border:1px solid #d9d5cc;border-left:5px solid #315f3d;border-radius:9px;background:#e8eee8;color:#233128;font-weight:900}
      #taskList .krista-task-file-name{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #taskList .krista-task-file-number{color:#657068;font-size:11px;font-weight:800;white-space:nowrap}
      #taskList .krista-task-file-count{display:inline-flex;align-items:center;justify-content:center;margin-left:auto;border-radius:999px;padding:3px 8px;background:#fff;border:1px solid #cbd4cc;font-size:11px;white-space:nowrap}
      #taskList .krista-task-file-rows{display:grid;gap:6px;padding-left:8px}
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
      .krista-task-editor-backdrop{position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,.58);display:none;align-items:center;justify-content:center;padding:18px}
      .krista-task-editor-backdrop.open{display:flex}
      .krista-task-editor{width:min(760px,100%);max-height:calc(100vh - 36px);overflow:auto;background:#fff;border-radius:17px;box-shadow:0 24px 70px rgba(0,0,0,.32);padding:20px}
      .krista-task-editor-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}
      .krista-task-editor-head h3{margin:0}
      .krista-task-editor-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
      .krista-task-editor-grid .full{grid-column:1/-1}
      .krista-task-editor-grid label{display:grid;gap:5px;font-size:12px;color:#555;font-weight:700}
      .krista-task-editor-grid input,.krista-task-editor-grid select,.krista-task-editor-grid textarea{width:100%;box-sizing:border-box;font:inherit}
      .krista-task-editor-grid textarea{min-height:90px;resize:vertical}
      .krista-task-editor-actions{display:flex;align-items:center;gap:8px;justify-content:flex-end;margin-top:16px}
      .krista-task-editor-note{margin-right:auto;font-size:12px;font-weight:750;color:#27713d}
      .krista-task-editor-note.error{color:#9c2f25}
      @media(max-width:900px){
        #taskList .krista-task-row{grid-template-columns:minmax(180px,1fr) auto}
        #taskList .krista-task-file-bar{align-items:flex-start;flex-wrap:wrap}
        #taskList .krista-task-file-count{margin-left:0}
        #taskList .krista-task-file-rows{padding-left:0}
        #taskList .krista-task-row>.krista-task-cell:nth-child(2),
        #taskList .krista-task-row>.krista-task-cell:nth-child(3),
        #taskList .krista-task-row>.krista-task-cell:nth-child(4){display:none}
        .krista-task-attachment-row{grid-template-columns:1fr}
        .krista-task-attachment-links{justify-content:flex-start}
        .krista-task-editor-grid{grid-template-columns:1fr}
        .krista-task-editor-grid .full{grid-column:auto}
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

  function editorEmployees() {
    return typeof masterEmployees !== "undefined" && Array.isArray(masterEmployees) ? masterEmployees : [];
  }

  function editorJobs() {
    return typeof masterJobs !== "undefined" && Array.isArray(masterJobs) ? masterJobs : [];
  }

  function ensureTaskEditor() {
    let backdrop = document.getElementById("kristaTaskEditorBackdrop");
    if (backdrop) return backdrop;
    backdrop = document.createElement("div");
    backdrop.id = "kristaTaskEditorBackdrop";
    backdrop.className = "krista-task-editor-backdrop";
    backdrop.innerHTML = `<div class="krista-task-editor" role="dialog" aria-modal="true" aria-labelledby="kristaTaskEditorTitle">
      <div class="krista-task-editor-head"><h3 id="kristaTaskEditorTitle">✏ Aufgabe bearbeiten</h3><button type="button" class="secondary" data-task-editor-close>Schließen</button></div>
      <form id="kristaTaskEditorForm"><div class="krista-task-editor-grid" data-task-editor-fields></div>
        <div class="krista-task-editor-actions"><span class="krista-task-editor-note" data-task-editor-note></span><button type="button" class="secondary" data-task-editor-close>Abbrechen</button><button type="submit" class="green">Änderungen speichern</button></div>
      </form>
    </div>`;
    backdrop.addEventListener("click", (event) => { if (event.target === backdrop || event.target.closest("[data-task-editor-close]")) closeTaskEditor(); });
    backdrop.querySelector("form").addEventListener("submit", saveTaskEditor);
    document.body.appendChild(backdrop);
    return backdrop;
  }

  function closeTaskEditor() {
    document.getElementById("kristaTaskEditorBackdrop")?.classList.remove("open");
  }

  function selectedOption(select, value, label) {
    const exists = [...select].some(option => String(option.value) === String(value || ""));
    return exists || !value ? "" : `<option value="${esc(String(value))}">${esc(label || value)}</option>`;
  }

  function openTaskEditor(taskId) {
    const task = (data?.tasks || []).find(item => String(item.id) === String(taskId));
    if (!task || ["invoice", "regie"].includes(taskGroupKey(task))) return;
    const backdrop = ensureTaskEditor();
    const form = backdrop.querySelector("form");
    const fields = backdrop.querySelector("[data-task-editor-fields]");
    const appointment = task.taskType === "Termin" || task.appointment;
    const employees = editorEmployees();
    const jobs = editorJobs();
    form.dataset.taskId = String(task.id || "");
    fields.innerHTML = `
      <label class="full">Aufgabe / Überschrift<input name="title" required maxlength="500" value="${esc(task.title || "")}"></label>
      <label>Art<input value="${esc(task.taskType || "Aufgabe")}" disabled></label>
      <label>Priorität<select name="priority"><option value="normal">Normal</option><option value="heute">Heute</option><option value="sofort">Sofort</option></select></label>
      <label>Zuständig<select name="assigneeId" required>${employees.map(employee => `<option value="${esc(String(employee.id || ""))}">${esc(employee.name || employee.id || "")}</option>`).join("")}</select></label>
      <label>Baustelle<select name="jobId"><option value="">– keine Baustelle –</option>${jobs.map(job => `<option value="${esc(String(job.jobId || job.id || ""))}">${esc(`#${job.jobId || job.id || ""} · ${job.name || job.jobName || "ohne Name"}`)}</option>`).join("")}</select></label>
      ${appointment ? `<label>Datum<input name="appointmentDate" type="date" required value="${esc(task.appointment?.date || "")}"></label><label>Von<input name="appointmentFrom" type="time" required value="${esc(task.appointment?.from || "09:00")}"></label><label>Bis<input name="appointmentTo" type="time" required value="${esc(task.appointment?.to || "10:00")}"></label>` : `<label>Fällig am<input name="dueDate" type="date" value="${esc(task.dueDate || "")}"></label>`}
      <label class="full">Hinweise / was wurde vergessen?<textarea name="reminder" maxlength="5000">${esc(task.reminder || "")}</textarea></label>`;
    const assignee = fields.querySelector('[name="assigneeId"]');
    assignee.insertAdjacentHTML("afterbegin", selectedOption(assignee, task.assigneeId, task.assigneeName));
    assignee.value = String(task.assigneeId || "");
    const job = fields.querySelector('[name="jobId"]');
    job.insertAdjacentHTML("afterbegin", selectedOption(job, task.jobId, task.jobName));
    job.value = String(task.jobId || "");
    fields.querySelector('[name="priority"]').value = String(task.priority || "normal");
    backdrop.querySelector("[data-task-editor-note]").textContent = "";
    backdrop.classList.add("open");
    fields.querySelector('[name="title"]')?.focus();
  }

  async function appointmentRequest(method, path, payload) {
    const response = await fetch(tokenUrl(path), { method, credentials:"same-origin", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(payload) });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) throw new Error(body?.error || text || response.statusText);
    return body;
  }

  async function saveTaskEditor(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const task = (data?.tasks || []).find(item => String(item.id) === String(form.dataset.taskId));
    if (!task) return;
    const note = form.querySelector("[data-task-editor-note]");
    const button = form.querySelector('[type="submit"]');
    const oldLabel = button.textContent;
    const backup = JSON.parse(JSON.stringify(task));
    const values = new FormData(form);
    let internallySaved = false;
    try {
      note.classList.remove("error");
      note.textContent = "Wird gespeichert …";
      button.disabled = true;
      const title = String(values.get("title") || "").trim();
      if (!title) throw new Error("Bitte eine Überschrift eingeben.");
      task.title = title;
      task.reminder = String(values.get("reminder") || "").trim();
      task.priority = String(values.get("priority") || "normal");
      task.assigneeId = String(values.get("assigneeId") || "");
      task.assigneeName = form.elements.assigneeId.selectedOptions[0]?.textContent || task.assigneeId;
      task.jobId = String(values.get("jobId") || "");
      const selectedJob = editorJobs().find(job => String(job.jobId || job.id || "") === task.jobId);
      task.jobName = selectedJob ? String(selectedJob.name || selectedJob.jobName || "") : (task.jobId ? form.elements.jobId.selectedOptions[0]?.textContent || "" : "");
      if (selectedJob && typeof jobAddress === "function") task.address = jobAddress(selectedJob);
      if (!task.appointment && task.taskType !== "Termin") task.dueDate = String(values.get("dueDate") || "");
      let appointmentPayload = null;
      if (task.taskType === "Termin" || task.appointment) {
        const date = String(values.get("appointmentDate") || ""), from = String(values.get("appointmentFrom") || ""), to = String(values.get("appointmentTo") || "");
        if (!date || !from || !to || to <= from) throw new Error("Bitte eine gültige Terminzeit eingeben.");
        task.dueDate = "";
        task.appointment = { ...(task.appointment || {}), date, from, to, calendarOwner:"alex", calendarAccount:"alexander.krista@krista.at" };
        appointmentPayload = { taskId:String(task.id || ""), title:task.title, date, from, to, allDay:false, location:task.address || task.jobName || "", details:[task.reminder, task.contactName || task.contactPhone || task.contactEmail ? `Kontakt: ${[task.contactName, task.contactPhone, task.contactEmail].filter(Boolean).join(" · ")}` : ""].filter(Boolean).join("\n\n") };
      }
      await window.persistTasks();
      internallySaved = true;
      if (appointmentPayload) {
        const current = (data?.tasks || []).find(item => String(item.id) === String(task.id));
        const appointmentId = current?.appointment?.id || backup.appointment?.id || "";
        const result = appointmentId
          ? await appointmentRequest("PATCH", `/kristine/api/appointments/${encodeURIComponent(appointmentId)}`, appointmentPayload)
          : await appointmentRequest("POST", "/kristine/api/appointments", { ...appointmentPayload, requestId:`edit-task-${task.id}` });
        if (current) {
          current.appointment = { ...(current.appointment || {}), id:result.appointment.id, outlook:result.appointment.outlook };
          await window.persistTasks();
        }
        note.textContent = result.outlookSynced ? "✓ Aufgabe und Outlook-Termin geändert." : "✓ Aufgabe geändert; Outlook-Synchronisierung ist noch offen.";
      } else {
        note.textContent = "✓ Aufgabe geändert.";
      }
      setTimeout(closeTaskEditor, 800);
    } catch (error) {
      if (!internallySaved) Object.assign(task, backup);
      if (typeof window.renderTasks === "function") window.renderTasks();
      note.classList.add("error");
      note.textContent = `${internallySaved ? "Aufgabe ist gespeichert; Outlook-Fehler" : "Fehler"}: ${String(error?.message || error)}`;
    } finally {
      button.disabled = false;
      button.textContent = oldLabel;
    }
  }

  window.openKristaTaskEditor = openTaskEditor;

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

    const taskRowHtml = (task) => {
      const job = (masterJobs || []).find((row) => String(row.jobId) === String(task.jobId));
      const priority = task.priority === "sofort" ? "🔴 Sofort" : task.priority === "heute" ? "🟡 Heute" : "🟢 Normal";
      const statusTime = task.status === "done"
        ? (task.completedAt ? new Date(task.completedAt).toLocaleString("de-AT", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" }) : "erledigt")
        : (typeof taskDueLabel === "function" ? taskDueLabel(task.dueDate || task.appointment?.date) : (task.dueDate || task.appointment?.date || "–"));
      const site = task.jobName || job?.name || "";
      const editable = !["invoice", "regie"].includes(taskGroupKey(task));
      return `<div class="krista-task-row ${task.status === "done" ? "done" : ""}">
        <div class="krista-task-cell"><div class="krista-task-title">${esc(task.title || "Aufgabe")}</div><div class="krista-task-sub"><span class="krista-task-badge">${esc(task.taskType || "Aufgabe")}</span><span class="krista-task-badge">${priority}</span>${task.reminder ? ` ${esc(task.reminder)}` : ""}</div></div>
        <div class="krista-task-cell"><strong>${esc(task.assigneeName || task.assigneeId || "–")}</strong><div class="krista-task-sub">für</div></div>
        <div class="krista-task-cell"><strong>${esc(site || "–")}</strong><div class="krista-task-sub">Baustelle</div></div>
        <div class="krista-task-cell"><strong>${esc(statusTime)}</strong><div class="krista-task-sub">${task.status === "done" ? "erledigt" : "fällig"}</div></div>
        <div class="krista-task-actions"><button type="button" class="secondary krista-task-attachment-button" data-task-attachments="${esc(String(task.id || ""))}" hidden>📎</button><button class="secondary" onclick="openTaskListModal('${task.id}')">Details</button>${editable ? `<button type="button" class="secondary" title="Aufgabe bearbeiten" onclick="openKristaTaskEditor('${task.id}')">✏</button>` : ""}${task.status !== "done" ? `<button class="green" onclick="markTaskDone('${task.id}')">✓</button>` : ""}<button class="danger" onclick="removeTask('${task.id}')">×</button></div>
      </div>`;
    };
    const groupDefinitions = [
      { key:"other", label:"Aufgaben", icon:"📌" },
      { key:"regie", label:"Regie", icon:"📋" },
      { key:"invoice", label:"Rechnungen", icon:"💶" },
      { key:"customer", label:"Kundenpunkte", icon:"👤" },
    ];
    const existingState = new Map([...list.querySelectorAll(".krista-task-group")].map(group => [group.dataset.taskGroup, group.open]));
    const grouped = new Map(groupDefinitions.map(group => [group.key, []]));
    tasks.forEach(task => grouped.get(taskGroupKey(task)).push(task));
    list.innerHTML = groupDefinitions.map(group => {
      const rows = grouped.get(group.key) || [];
      const remembered = existingState.get(group.key);
      const open = remembered === undefined ? true : remembered;
      const rowsHtml = rows.length
        ? (group.key === "customer" ? taskFileGroupsHtml(rows, taskRowHtml) : rows.map(taskRowHtml).join(""))
        : '<div class="krista-task-group-empty">Keine Einträge.</div>';
      return `<details class="krista-task-group" data-task-group="${group.key}" ${open ? "open" : ""}><summary><span class="krista-task-group-title"><span>${group.icon}</span>${group.label}</span><span class="krista-task-group-count">${rows.length}</span></summary><div class="krista-task-group-rows">${rowsHtml}</div></details>`;
    }).join("");

    hydrateAttachmentButtons(false);
    setTimeout(() => hydrateAttachmentButtons(true), 1800);
  }

  function taskGroupKey(task) {
    const title = String(task?.title || "").toLowerCase();
    const reminder = String(task?.reminder || "");
    if (reminder.includes("[FINANCE_APPROVAL]") || title.includes("rechnung freigeben")) return "invoice";
    if (reminder.includes("[REGIE_APPROVAL]") || title.includes("regiebericht prüfen")) return "regie";
    if (String(task?.creatorId || "") === "customer-portal" || title.includes("kundenpunkt prüfen")) return "customer";
    return "other";
  }

  function taskFileInfo(task) {
    const jobId = String(task?.jobId || task?.projectId || task?.siteId || "").trim();
    const jobName = String(task?.jobName || task?.projectName || task?.siteName || "").trim();
    const fallback = "Ohne zugeordnete Akte";
    const label = jobName || (jobId ? `Akte ${jobId}` : fallback);
    const normalizedName = label.toLocaleLowerCase("de-AT").replace(/\s+/g, " ").trim();
    return { key:jobId ? `job:${jobId}` : `name:${normalizedName}`, jobId, label };
  }

  function taskFileGroupsHtml(tasks, taskRowHtml) {
    const files = new Map();
    for (const task of tasks) {
      const file = taskFileInfo(task);
      if (!files.has(file.key)) files.set(file.key, { ...file, tasks:[] });
      files.get(file.key).tasks.push(task);
    }
    return [...files.values()].map(file => {
      const count = file.tasks.length;
      return `<section class="krista-task-file-group" data-task-file="${esc(file.key)}"><div class="krista-task-file-bar"><span aria-hidden="true">📁</span><span class="krista-task-file-name">${esc(file.label)}</span>${file.jobId ? `<span class="krista-task-file-number">Akte ${esc(file.jobId)}</span>` : ""}<span class="krista-task-file-count">${count} ${count === 1 ? "Aufgabe" : "Aufgaben"}</span></div><div class="krista-task-file-rows">${file.tasks.map(taskRowHtml).join("")}</div></section>`;
    }).join("");
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
