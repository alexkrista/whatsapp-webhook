(() => {
  const moduleLabels = {
    projectFile: "1 · Projektakte, Dokumente, Fotos & Material",
    regie: "2 · Regieberichte",
    communication: "3 · Kommunikation",
    projectPoints: "4 · Projektpunkte / Wünsche",
  };
  let currentJobId = "";
  let readyJobId = "";
  let portalUrl = "";
  let contactSelectionKey = "";
  let recipientOptions = [];
  let invitationStatuses = [];

  const style = document.createElement("style");
  style.textContent = `.customer-portal-button{display:inline-flex;align-items:center;gap:7px;cursor:pointer}.customer-portal-button::before{content:"";width:8px;height:8px;border-radius:50%;background:#9a9e9a}.customer-portal-button.portal-prepared::before{background:#e49a31}.customer-portal-button.portal-active::before{background:#43b878}.customer-portal-link small{display:block;margin-top:3px;color:#737873;font-size:10px}.cp-backdrop{position:fixed;inset:0;z-index:900;background:rgba(16,24,19,.56);display:none;align-items:center;justify-content:center;padding:16px}.cp-backdrop.open{display:flex}.cp-dialog{width:min(980px,100%);max-height:92vh;overflow:auto;background:#fffefa;border-radius:18px;box-shadow:0 24px 70px rgba(0,0,0,.28)}.cp-head{display:flex;justify-content:space-between;gap:12px;padding:18px 20px;background:#17211b;color:#fff}.cp-head h2{font-size:20px;margin:0}.cp-head p{margin:3px 0 0;color:rgba(255,255,255,.68);font-size:12px}.cp-close{border:0;background:transparent;color:#fff;font-size:24px;cursor:pointer}.cp-body{padding:20px}.cp-inline-host{background:transparent!important}.cp-inline-host .cp-body{padding:0}.cp-inline-title{display:none;margin:0 0 12px;font-size:20px}.cp-inline-host .cp-inline-title{display:block}.cp-factbox{padding:18px;border:1px solid #ddd9cf;border-radius:15px;background:#fffefa;box-shadow:0 5px 18px rgba(23,33,27,.05)}.cp-meeting{margin-top:16px;padding:18px;border:1px solid #ddd9cf;border-radius:15px;background:#fffefa;box-shadow:0 5px 18px rgba(23,33,27,.05)}.cp-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.cp-field{display:grid;gap:5px;font-size:12px;font-weight:800;color:#626862}.cp-field input,.cp-field select,.cp-field textarea{font:inherit;font-weight:500;min-height:42px;border:1px solid #d6d3ca;border-radius:10px;padding:9px;background:#fff}.cp-field textarea{min-height:100px;resize:vertical}.cp-field-wide{grid-column:1/-1}.cp-internal-photo{grid-column:1/-1;display:flex;gap:9px;align-items:flex-start;padding:10px 12px;border:1px solid #e0c77c;border-radius:10px;background:#fff8dc;color:#554718;font-size:12px;cursor:pointer}.cp-internal-photo input{width:auto;min-height:0;margin:2px 0 0;padding:0}.cp-internal-photo span{display:grid;gap:2px}.cp-internal-photo small{font-weight:500}.cp-section{margin-top:18px;padding-top:16px;border-top:1px solid #e7e3da}.cp-section h3{margin:0 0 4px;font-size:15px}.cp-help{margin:0 0 11px;color:#747a74;font-size:12px}.cp-option{display:flex;gap:10px;align-items:flex-start;border:1px solid #e2ded5;border-radius:11px;padding:11px;margin:8px 0;font-size:13px;font-weight:750;background:#fbfaf6}.cp-option input{margin-top:2px}.cp-jobs{display:none;margin-top:10px;max-height:180px;overflow:auto;border:1px solid #e2ded5;border-radius:11px;padding:7px}.cp-jobs.open{display:block}.cp-point-form{padding:14px;border:1px solid #d8ded7;border-radius:12px;background:#f7faf7}.cp-point-list{display:grid;gap:7px;margin-top:12px}.cp-point-row{padding:9px 11px;border-left:4px solid #397b4b;background:#fff;border-radius:7px;font-size:12px}.cp-point-row strong{display:block;color:#25352a}.cp-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}.cp-actions button,.cp-actions a,.cp-point-form button{border:1px solid #cfcac0;border-radius:10px;padding:10px 13px;background:#fff;color:#293029;text-decoration:none;font:800 12px system-ui;cursor:pointer}.cp-actions .primary,.cp-point-form .primary{background:#2f7d4a;border-color:#2f7d4a;color:#fff}.cp-actions .customer-view{background:#17211b;border-color:#17211b;color:#fff}.cp-status{min-height:18px;margin-top:10px;font-size:12px;color:#667066}.cp-status.error{color:#a84540}@media(max-width:650px){.cp-grid{grid-template-columns:1fr}.cp-field-wide,.cp-internal-photo{grid-column:auto}.cp-dialog{max-height:96vh}.cp-actions>*{flex:1;text-align:center}}`;
  style.textContent = `.customer-portal-button{display:inline-flex;align-items:center;gap:7px;cursor:pointer}.customer-portal-button::before{content:"";width:8px;height:8px;border-radius:50%;background:#9a9e9a}.customer-portal-button.portal-prepared::before{background:#e49a31}.customer-portal-button.portal-active::before{background:#43b878}.customer-portal-link small{display:block;margin-top:3px;color:#737873;font-size:10px}.cp-backdrop{position:fixed;inset:0;z-index:900;background:rgba(16,24,19,.56);display:none;align-items:center;justify-content:center;padding:16px}.cp-backdrop.open{display:flex}.cp-dialog{width:min(760px,100%);max-height:92vh;overflow:auto;background:#fffefa;border-radius:18px;box-shadow:0 24px 70px rgba(0,0,0,.28)}.cp-head{display:flex;justify-content:space-between;gap:12px;padding:18px 20px;background:#17211b;color:#fff}.cp-head h2{font-size:20px;margin:0}.cp-head p{margin:3px 0 0;color:rgba(255,255,255,.68);font-size:12px}.cp-close{border:0;background:transparent;color:#fff;font-size:24px;cursor:pointer}.cp-body{padding:20px}.cp-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.cp-field{display:grid;gap:5px;font-size:12px;font-weight:800;color:#626862}.cp-field input,.cp-field select,.cp-field textarea{font:inherit;font-weight:500;min-height:42px;border:1px solid #d6d3ca;border-radius:10px;padding:9px;background:#fff}.cp-field textarea{min-height:100px;resize:vertical}.cp-field.full{grid-column:1/-1}.cp-section{margin-top:18px;padding-top:16px;border-top:1px solid #e7e3da}.cp-section h3{margin:0 0 4px;font-size:15px}.cp-help{margin:0 0 11px;color:#747a74;font-size:12px}.cp-option{display:flex;gap:10px;align-items:flex-start;border:1px solid #e2ded5;border-radius:11px;padding:11px;margin:8px 0;font-size:13px;font-weight:750;background:#fbfaf6}.cp-option input{margin-top:2px}.cp-jobs{display:none;margin-top:10px;max-height:180px;overflow:auto;border:1px solid #e2ded5;border-radius:11px;padding:7px}.cp-jobs.open{display:block}.cp-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}.cp-actions button,.cp-actions a{border:1px solid #cfcac0;border-radius:10px;padding:10px 13px;background:#fff;color:#293029;text-decoration:none;font:800 12px system-ui;cursor:pointer}.cp-actions .primary{background:#2f7d4a;border-color:#2f7d4a;color:#fff}.cp-point-form{background:#f7f6f1;border:1px solid #e0ddd4;border-radius:12px;padding:12px}.cp-point-list{display:grid;gap:8px;margin-top:12px}.cp-point{border:1px solid #e0ddd4;border-left:4px solid #27713d;border-radius:10px;padding:10px;background:#fff}.cp-point.confirm{border-left-color:#dd941f}.cp-point.done{border-left-color:#8aa48f}.cp-point-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.cp-point-badge{display:inline-flex;border-radius:999px;padding:2px 7px;background:#fff2cf;color:#675217;font-size:10px;font-weight:850}.cp-point-meta{font-size:11px;color:#737873}.cp-point details{margin-top:7px}.cp-point ol{margin:7px 0 0;padding-left:22px}.cp-status{min-height:18px;margin-top:10px;font-size:12px;color:#667066}.cp-status.error{color:#a84540}@media(max-width:650px){.cp-grid{grid-template-columns:1fr}.cp-field.full{grid-column:auto}.cp-dialog{max-height:96vh}.cp-actions>*{flex:1;text-align:center}.cp-point-head{display:block}}`;
  style.textContent += `.cp-inline-host{background:transparent!important}.cp-inline-host .cp-body{padding:0}.cp-inline-title{display:none;margin:0 0 12px;font-size:20px}.cp-inline-host .cp-inline-title{display:block}.cp-field-wide{grid-column:1/-1}.cp-internal-photo{grid-column:1/-1;display:flex;gap:9px;align-items:flex-start;padding:10px 12px;border:1px solid #e0c77c;border-radius:10px;background:#fff8dc;color:#554718;font-size:12px;cursor:pointer}.cp-internal-photo input{width:auto;min-height:0;margin:2px 0 0;padding:0}.cp-actions .customer-view{background:#17211b;border-color:#17211b;color:#fff}`;
  document.head.appendChild(style);

  const modal = document.createElement("div");
  modal.className = "cp-backdrop";
  modal.innerHTML = `<section class="cp-dialog" role="dialog" aria-modal="true" aria-labelledby="cpTitle"><header class="cp-head"><div><h2 id="cpTitle">Kundenportal</h2><p id="cpSubtitle">Direkt mit der Baustelle verbunden</p></div><button class="cp-close" type="button" aria-label="Schließen">×</button></header><div class="cp-body"><h2 class="cp-inline-title">Kundenportal · <span id="cpInlineSubtitle">Baustelle</span></h2><div class="cp-factbox"><div class="cp-grid"><label class="cp-field">Portalstatus<select id="cpStatus"><option value="off">Nicht eingerichtet</option><option value="prepared">Vorbereitet · Einladung offen</option><option value="active">Aktiv · Kunde hat Zugang</option></select></label><label class="cp-field">Kundenname<input id="cpName" autocomplete="name"></label><label class="cp-field">E-Mail<input id="cpEmail" type="email" autocomplete="email"></label><label class="cp-field">WhatsApp / Telefon<input id="cpPhone" type="tel" autocomplete="tel"></label></div><div class="cp-section"><h3>Freigabeoptionen</h3><p class="cp-help">Jede Freigabe ist einzeln wählbar – zum Beispiel nur 1 und 3 oder ausschließlich 4.</p><div id="cpModules"></div></div><div class="cp-section"><h3>Umfang</h3><label class="cp-option"><input type="radio" name="cpMode" value="single" checked><span><strong>Nur diese Baustelle</strong><br><small>Eigene Kundenakte für dieses Projekt</small></span></label><label class="cp-option"><input type="radio" name="cpMode" value="collection"><span><strong>Sammelmappe</strong><br><small>Diese und weitere ausgewählte Baustellen gemeinsam zeigen</small></span></label><div id="cpJobs" class="cp-jobs"></div></div><div class="cp-actions"><button id="cpSave" class="primary" type="button">Portal-Einstellungen speichern</button><button id="cpWhatsApp" type="button">Per WhatsApp einladen</button><a id="cpEmailInvite" href="#">Per E-Mail einladen</a><a id="cpOpen" class="customer-view" href="#" target="_blank" rel="noopener">Kundenansicht öffnen</a></div><div id="cpMessage" class="cp-status"></div></div><div class="cp-meeting"><h3>Besprechungsprotokoll</h3><p class="cp-help">Punkte direkt während der Besprechung erfassen. Jeder Punkt wird dauerhaft bei der Baustelle gespeichert und als Aufgabe vorbereitet.</p><form id="cpPointForm" class="cp-point-form"><div class="cp-grid"><label class="cp-field">Überschrift<input id="cpPointTitle" maxlength="140" required placeholder="z. B. Fensterbank nachbessern"></label><label class="cp-field">Raum oder Bereich<input id="cpPointArea" maxlength="140" placeholder="z. B. Wohnzimmer"></label><label class="cp-field">Zuständig<select id="cpPointResponsibility"><option value="krista">Farben Krista</option><option value="bauherr">Bauherr</option></select></label><label class="cp-field">Foto(s)<input id="cpPointPhotos" type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple></label><label class="cp-internal-photo"><input id="cpPointPhotosInternal" type="checkbox"><span><strong>Fotos intern</strong><small>Diese Fotos bleiben bei KRISTINE und kommen nicht in Kundenakte, Kundenportal oder Export.</small></span></label><label class="cp-field cp-field-wide">Besprechungspunkt<textarea id="cpPointText" maxlength="5000" required placeholder="Was wurde besprochen oder vereinbart?"></textarea></label></div><button id="cpPointSave" class="primary" type="submit">Punkt speichern</button><span id="cpPointFiles" class="cp-help"></span></form><div id="cpPointList" class="cp-point-list"></div></div></div></section>`;
  modal.innerHTML = `<section class="cp-dialog" role="dialog" aria-modal="true" aria-labelledby="cpTitle"><header class="cp-head"><div><h2 id="cpTitle">Kundenportal</h2><p id="cpSubtitle">Direkt mit der Baustelle verbunden</p></div><button class="cp-close" type="button" aria-label="Schließen">×</button></header><div class="cp-body"><div class="cp-grid"><label class="cp-field">Portalstatus<select id="cpStatus"><option value="off">Nicht eingerichtet</option><option value="prepared">Vorbereitet · Einladung offen</option><option value="active">Aktiv · Kunde hat Zugang</option></select></label><label class="cp-field">Kundenname<input id="cpName" autocomplete="name"></label><label class="cp-field">E-Mail<input id="cpEmail" type="email" autocomplete="email"></label><label class="cp-field">WhatsApp / Telefon<input id="cpPhone" type="tel" autocomplete="tel"></label></div><div class="cp-section"><h3>Freigabeoptionen</h3><p class="cp-help">Jede Freigabe ist einzeln wählbar – zum Beispiel nur 1 und 3 oder ausschließlich 4.</p><div id="cpModules"></div></div><div class="cp-section"><h3>Umfang</h3><label class="cp-option"><input type="radio" name="cpMode" value="single" checked><span><strong>Nur diese Baustelle</strong><br><small>Eigene Kundenakte für dieses Projekt</small></span></label><label class="cp-option"><input type="radio" name="cpMode" value="collection"><span><strong>Sammelmappe</strong><br><small>Diese und weitere ausgewählte Baustellen gemeinsam zeigen</small></span></label><div id="cpJobs" class="cp-jobs"></div></div><div class="cp-section"><h3>Kundenpunkte & Gesprächsnotizen</h3><p class="cp-help">Nach einem Termin jeden offenen Punkt einzeln erfassen. So bleibt die Erledigung bis zur Kundenbestätigung nachvollziehbar.</p><form id="cpPointForm" class="cp-point-form"><div class="cp-grid"><label class="cp-field">Überschrift<input id="cpPointTitle" maxlength="140" placeholder="z. B. Silikonfuge Dusche"></label><label class="cp-field">Raum / Bereich<input id="cpPointArea" maxlength="140" placeholder="z. B. Bad OG"></label><label class="cp-field full">Punkt / Gesprächsnotiz<textarea id="cpPointText" maxlength="5000" required></textarea></label><label class="cp-field">Eingeteilt an<select id="cpPointAssignee"><option value="">Noch nicht eingeteilt · Alex prüft</option></select></label><label class="cp-field">Termin<input id="cpPointDue" type="date"></label></div><div class="cp-actions"><button id="cpPointSave" type="button">Nur intern erfassen</button><button id="cpPointSend" class="primary" type="button">Speichern & an Kunden senden</button></div></form><div id="cpPointList" class="cp-point-list"></div></div><div class="cp-actions"><button id="cpSave" class="primary" type="button">Speichern</button><button id="cpWhatsApp" type="button">Per WhatsApp einladen</button><a id="cpEmailInvite" href="#">Per E-Mail einladen</a><a id="cpOpen" href="#" target="_blank" rel="noopener">Portal öffnen</a></div><div id="cpMessage" class="cp-status"></div></div></section>`;
  document.body.appendChild(modal);
  const pointTextInput = document.getElementById("cpPointText");
  const pointTextField = typeof pointTextInput?.closest === "function" ? pointTextInput.closest("label") : null;
  pointTextField?.insertAdjacentHTML("beforebegin", `<label class="cp-field">Zuständig<select id="cpPointResponsibility"><option value="krista">Farben Krista</option><option value="bauherr">Bauherr</option></select></label><label class="cp-field">Foto(s)<input id="cpPointPhotos" type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple></label><label class="cp-internal-photo"><input id="cpPointPhotosInternal" type="checkbox"><span><strong>Fotos intern</strong><small>Diese Fotos bleiben nur in KRISTINE und werden dem Kunden nicht gezeigt.</small></span></label><span id="cpPointFiles" class="cp-help"></span>`);
  const dialog = modal.querySelector(".cp-dialog");
  const portalBody = modal.querySelector(".cp-body");
  const portalQuery = selector => typeof portalBody?.querySelector === "function" ? portalBody.querySelector(selector) : modal.querySelector(selector);
  const portalQueryAll = selector => typeof portalBody?.querySelectorAll === "function" ? portalBody.querySelectorAll(selector) : modal.querySelectorAll(selector);
  const portalContactGrid=modal.querySelector(".cp-grid");
  if(typeof portalContactGrid?.insertAdjacentHTML==="function")portalContactGrid.insertAdjacentHTML("afterend",`<div class="cp-section"><h3>Persönliche Empfängerlinks</h3><p class="cp-help">Bauherrschaft, Architektur und Bauleitung einzeln anklicken. Für jede gewählte Person wird ein eigener Link erstellt und versendet.</p><div class="cp-actions" style="margin-top:8px"><select id="cpRecipientDropdown" style="min-width:240px;padding:9px;border:1px solid #d6d3ca;border-radius:10px"></select><button id="cpRecipientAdd" type="button">Aus Stammdaten auswählen</button></div><div id="cpRecipients"></div><label class="cp-option"><input id="cpManualRecipient" type="checkbox"><span><strong>Sonstiger Empfänger</strong><br><small>Name, E-Mail und Telefon aus den Feldern oben verwenden</small></span></label></div>`);
  const portalSaveButton=document.getElementById("cpSave");
  if(typeof portalSaveButton?.insertAdjacentHTML==="function")portalSaveButton.insertAdjacentHTML("afterend",'<button id="cpSendSelected" class="primary" type="button">Gewählte Empfänger einladen</button>');
  document.getElementById("cpModules").innerHTML = Object.entries(moduleLabels).map(([key, label]) => `<label class="cp-option"><input type="checkbox" data-cp-module="${key}"><span>${label}</span></label>`).join("");

  const tokenized = path => {
    const url = new URL(path, location.origin);
    const token = new URLSearchParams(location.search).get("token");
    if (token) url.searchParams.set("token", token);
    return url.pathname + url.search;
  };
  async function api(path, options = {}) {
    const response = await fetch(tokenized(path), options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Kundenportal konnte nicht geladen werden.");
    return data;
  }
  const selectedMode = () => portalQuery('input[name="cpMode"]:checked')?.value || "single";
  const setMessage = (text, error = false) => {
    const element = document.getElementById("cpMessage");
    element.textContent = text;
    element.classList.toggle("error", error);
  };
  const invitationText = () => `Guten Tag ${document.getElementById("cpName").value || ""},\n\nhier ist Ihr persönlicher Zugang zur Projektakte #${currentJobId}:\n${portalUrl}\n\nBitte den Link öffnen und „Projektakte öffnen“ wählen. Der Einladungslink gilt 7 Tage.\n\nFreundliche Grüße\nFarben Krista`;
  function updateInvitationLinks() {
    document.getElementById("cpEmailInvite").href = "#";
    document.getElementById("cpOpen").href = "#";
  }
  function updateButton(status = "off") {
    for (const element of document.querySelectorAll(".customer-portal-button")) {
      element.classList.remove("portal-off", "portal-prepared", "portal-active");
      element.classList.add(`portal-${status}`);
      const small = element.querySelector("small");
      if (small) small.textContent = status === "active" ? "Aktiv" : status === "prepared" ? "Einladung offen" : "Nicht eingerichtet";
    }
  }
  const escapeHtml = value => String(value || "").replace(/[&<>\"]/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[character]));
  const fileData = file => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve({ name: file.name, data: reader.result }); reader.onerror = () => reject(new Error(`Foto ${file.name} konnte nicht gelesen werden.`)); reader.readAsDataURL(file); });
  function renderPoints(points = []) {
    const host = document.getElementById("cpPointList");
    host.innerHTML = points.length ? `<p class="cp-help">${points.length} ${points.length === 1 ? "Punkt" : "Punkte"} gespeichert · Neueste zuerst</p>` + points.slice(0, 12).map(row => { const visiblePhotos=(row.photos||[]).filter(photo=>photo.internal!==true).length; return `<div class="cp-point-row"><strong>${escapeHtml(row.title)}</strong>${escapeHtml(row.area || "Ohne Bereich")} · Zuständig: ${row.responsibility === "bauherr" ? "Bauherr" : "Farben Krista"}${visiblePhotos ? ` · 📷 ${visiblePhotos}` : ""}${row.internalPhotoCount ? ` · 🔒 ${row.internalPhotoCount} intern` : ""}</div>`; }).join("") : '<p class="cp-help">Noch keine Besprechungspunkte erfasst.</p>';
  }
  const pointStatus = point => ({captured:"Erfasst",received:"Eingegangen",sent:"Versendet",read:"Gelesen",assigned:"Eingeteilt",awaiting_confirmation:"Kundenbestätigung offen",confirmed:"Vom Kunden bestätigt",reopened:"Wieder offen",legacy_done:"Erledigt · Altbestand"}[point.state] || "Erfasst");
  const pointEvent = event => ({submitted:"Vom Kunden eingegangen",captured:"Intern erfasst",sent:event.reason==="confirmation"?"Bestätigung angefordert":"Versendet",read:"Gelesen",assigned:"Eingeteilt",internal_done:"Intern erledigt",customer_confirmed:"Vom Kunden bestätigt",customer_reopened:"Vom Kunden wieder geöffnet",office_reopened:"Intern wieder geöffnet",legacy_done:"Erledigt · Altbestand",legacy_reopened:"Wieder geöffnet"}[event.kind] || event.kind);
  const pointDate = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("de-AT",{dateStyle:"short",timeStyle:"short"}) : "Zeitpunkt nicht gespeichert";
  function invitationStatus(recipientId) {
    const row=invitationStatuses.find(item=>String(item.recipientId)===String(recipientId));
    if(!row)return "Noch kein Link erstellt";
    if(row.revoked)return "Früherer Link widerrufen";
    if(row.readAt)return `Gelesen ${pointDate(row.readAt)}`;
    if(row.sentAt)return `Versendet ${pointDate(row.sentAt)}`;
    if(row.error)return `Link erstellt · Versand offen: ${row.error}`;
    return `Link erstellt ${pointDate(row.createdAt)}`;
  }
  function renderRecipients(selectedIds = []) {
    const selected=new Set(selectedIds.map(String)),host=document.getElementById("cpRecipients"),dropdown=document.getElementById("cpRecipientDropdown");
    host.innerHTML=recipientOptions.map((recipient,index)=>`<label class="cp-option"><input type="checkbox" data-cp-recipient="${escapeHtml(recipient.id)}" ${selected.has(recipient.id)||(!selectedIds.length&&recipient.id==="owner")?"checked":""}><span><strong>${escapeHtml(recipient.roleLabel||"Empfänger")} · ${escapeHtml(recipient.name||"Name fehlt")}</strong><br><small>${escapeHtml([recipient.email,recipient.phone].filter(Boolean).join(" · ")||"E-Mail oder Telefon fehlt")}</small><br><small>${escapeHtml(invitationStatus(recipient.id))}</small></span></label>`).join("")||'<p class="cp-help">In den Baustellen-Stammdaten ist noch kein Bauherr, Architekt oder Bauleiter hinterlegt. Bitte oben einen sonstigen Empfänger eingeben.</p>';
    dropdown.innerHTML='<option value="">Empfänger auswählen …</option>'+recipientOptions.map(row=>`<option value="${escapeHtml(row.id)}">${escapeHtml(row.roleLabel||"Empfänger")} · ${escapeHtml(row.name||row.email||row.phone)}</option>`).join("");
    document.getElementById("cpManualRecipient").checked=selected.has("manual")||(!recipientOptions.length&&selectedIds.length===0);
  }
  function renderAdminPoints(points = []) {
    const host=document.getElementById("cpPointList");
    host.innerHTML=points.length?points.map(point=>{
      const klass=["confirmed","legacy_done"].includes(point.state)?"done":point.state==="awaiting_confirmation"?"confirm":"";
      const latest=point.history?.at(-1),task=point.task||{},canSend=point.visibility==="internal"||point.lastNotification?.sent===false;
      return `<article class="cp-point ${klass}"><div class="cp-point-head"><div><strong>${escapeHtml(point.title)}</strong>${point.area?`<div class="cp-point-meta">${escapeHtml(point.area)}</div>`:""}</div><span class="cp-point-badge">${escapeHtml(pointStatus(point))}</span></div><div class="cp-point-meta">${escapeHtml(pointDate(latest?.date||point.date))}${task.assigneeName?` · ${escapeHtml(task.assigneeName)}`:""}${task.dueDate?` · Termin ${escapeHtml(task.dueDate.split("-").reverse().join("."))}`:""}</div><details><summary>Beschreibung & Verlauf</summary><p>${escapeHtml(point.text)}</p><ol>${(point.history||[]).map(event=>`<li><strong>${escapeHtml(pointEvent(event))}</strong> · ${escapeHtml(pointDate(event.date))}${event.comment?`<br>${escapeHtml(event.comment)}`:""}</li>`).join("")}</ol></details>${canSend?`<button type="button" data-cp-send-point="${escapeHtml(point.id)}" data-cp-send-reason="${point.state==="awaiting_confirmation"?"confirmation":"update"}">${point.visibility==="internal"?"An Kunden senden":"Erneut senden"}</button>`:""}${point.lastNotification?.sent===false?`<div class="cp-status error">${escapeHtml(point.lastNotification.error||"Versand nicht erfolgt.")}</div>`:""}</article>`;
    }).join(""):'<p class="cp-help">Noch keine Kundenpunkte erfasst.</p>';
    host.querySelectorAll("[data-cp-send-point]").forEach(button=>button.addEventListener("click",()=>sendExistingPoint(button.dataset.cpSendPoint,button.dataset.cpSendReason,button)));
  }
  async function loadAdminPoints(jobId=currentJobId) {
    if(!jobId)return;
    const result=await api(`/admin/api/job/${encodeURIComponent(jobId)}/customer-points`);
    if(currentJobId===jobId)renderAdminPoints(result.points||[]);
  }
  function preparePointDelivery() {
    const module=portalQuery('[data-cp-module="projectPoints"]');if(module)module.checked=true;
    if(document.getElementById("cpStatus").value==="off")document.getElementById("cpStatus").value="prepared";
  }
  async function createPoint(sendNow) {
    const text=document.getElementById("cpPointText").value.trim();if(!text)return setMessage("Bitte den Kundenpunkt oder die Gesprächsnotiz eingeben.",true);
    const jobId=currentJobId,buttons=[document.getElementById("cpPointSave"),document.getElementById("cpPointSend")],files=[...(document.getElementById("cpPointPhotos")?.files||[])],photosInternal=document.getElementById("cpPointPhotosInternal")?.checked===true;buttons.forEach(button=>button.disabled=true);
    try{
      if(files.length>6)throw new Error("Bitte höchstens 6 Fotos auswählen.");
      const photos=await Promise.all(files.map(fileData));
      if(sendNow){preparePointDelivery();if(!await save())return;}
      const result=await api(`/admin/api/job/${encodeURIComponent(jobId)}/customer-points`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:document.getElementById("cpPointTitle").value,area:document.getElementById("cpPointArea").value,text,responsibility:document.getElementById("cpPointResponsibility")?.value||"krista",photos,photosInternal,assigneeId:document.getElementById("cpPointAssignee").value,dueDate:document.getElementById("cpPointDue").value,sendNow})});
      if(currentJobId!==jobId)return;
      document.getElementById("cpPointForm").reset();document.getElementById("cpPointFiles").textContent="";
      await loadAdminPoints(jobId);
      setMessage(sendNow?(result.notification?.sent?"Punkt gespeichert und Kunde automatisch informiert.":"Punkt gespeichert. Kundenbestätigung ist sichtbar, der automatische Versand ist aber fehlgeschlagen."):"Punkt intern erfasst und als Aufgabe angelegt.",sendNow&&!result.notification?.sent);
    }catch(error){setMessage(error.message,true);}finally{buttons.forEach(button=>button.disabled=false);}
  }
  async function sendExistingPoint(pointId,reason,button) {
    const jobId=currentJobId;button.disabled=true;
    try{preparePointDelivery();if(!await save())return;const result=await api(`/admin/api/job/${encodeURIComponent(jobId)}/customer-points/${encodeURIComponent(pointId)}/send`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({reason})});await loadAdminPoints(jobId);setMessage(result.notification?.sent?"Kunde wurde automatisch informiert.":"Punkt ist freigegeben, der automatische Versand ist aber fehlgeschlagen.",!result.notification?.sent);}
    catch(error){setMessage(error.message,true);}finally{button.disabled=false;}
  }
  function renderJobs(job, selected) {
    const host = document.getElementById("cpJobs");
    const jobs = Array.isArray(window.kristineCustomerPortalJobs) ? window.kristineCustomerPortalJobs : [];
    const ids = [...new Set((job.collectionMainMemberJobIds || job.collectionSummary?.jobIds || [job.jobId, ...(job.collectionMemberJobIds || [])]).map(String))].filter(id => id !== currentJobId);
    host.innerHTML = ids.map(id => {
      const member = jobs.find(item => String(item.jobId) === id) || { jobId: id };
      return `<label class="cp-option"><input type="checkbox" data-cp-job="${escapeHtml(id)}" checked disabled><span><strong>#${escapeHtml(id)}</strong> · ${escapeHtml(member.name || "Einzelakte")}</span></label>`;
    }).join("") || '<div class="cp-help">Keine weitere Einzelakte in dieser Sammelmappe.</div>';
    const collectionChoice = portalQuery('input[name="cpMode"][value="collection"]')?.closest("label");
    if (collectionChoice) collectionChoice.hidden = ids.length === 0;
    if (!ids.length && selectedMode() === "collection") portalQuery('input[name="cpMode"][value="single"]').checked = true;
  }
  async function openSettings(jobIdOverride = "", inlineHost = null) {
    currentJobId = String(jobIdOverride || location.hash.slice(1) || document.getElementById("detailNumber")?.textContent.replace(/^#/, "") || "");
    if (!currentJobId) return;
    if (inlineHost) {
      modal.classList.remove("open");
      inlineHost.className = "cp-inline-host";
      inlineHost.replaceChildren(portalBody);
    } else {
      dialog.appendChild(portalBody);
      modal.classList.add("open");
    }
    const jobId = currentJobId;
    readyJobId = "";
    document.getElementById("cpSave").disabled = true;
    setMessage("Wird geladen …");
    try {
      const [data,pointData,employeeData] = await Promise.all([
        api(`/admin/api/job/${encodeURIComponent(jobId)}/customer-portal`),
        api(`/admin/api/job/${encodeURIComponent(jobId)}/customer-points`).catch(()=>({points:[]})),
        api("/admin/api/employees").catch(()=>({employees:[]})),
      ]);
      if (currentJobId !== jobId) return;
      const portal = data.portal || {};
      const contacts = data.contactDefaults || {};
      contactSelectionKey = contacts.selectionKey || "";
      recipientOptions = data.recipientOptions || [];
      invitationStatuses = data.invitationStatuses || [];
      portalUrl = data.portalUrl || "";
      const job = (window.kristineCustomerPortalJobs || []).find(item => String(item.jobId) === currentJobId) || {};
      document.getElementById("cpSubtitle").textContent = `Baustelle #${currentJobId}`;
      if (document.getElementById("cpInlineSubtitle")) document.getElementById("cpInlineSubtitle").textContent = `Baustelle #${currentJobId}`;
      document.getElementById("cpStatus").value = portal.status || "off";
      const trackedSelection = Boolean(portal.contactSelectionKey);
      const changedSelection = trackedSelection && portal.contactSelectionKey !== contactSelectionKey;
      const newlySelectedExternalRecipient = !trackedSelection && contacts.selectionExplicit && (contacts.selectedGroups || []).some(group => group !== "owner");
      const useFreshContacts = changedSelection || newlySelectedExternalRecipient;
      document.getElementById("cpName").value = (useFreshContacts ? contacts.customerName : portal.customerName) || contacts.customerName || job.contactName || job.name || "";
      document.getElementById("cpEmail").value = (useFreshContacts ? contacts.customerEmail : portal.customerEmail) || contacts.customerEmail || "";
      document.getElementById("cpPhone").value = (useFreshContacts ? contacts.customerPhone : portal.customerPhone) || contacts.customerPhone || "";
      for (const [id, values] of [["cpEmail", contacts.emails], ["cpPhone", contacts.phones]]) {
        const input = document.getElementById(id);
        let choices = document.getElementById(id + "Choices");
        if (!choices) { choices = document.createElement("datalist"); choices.id = id + "Choices"; input.after(choices); input.setAttribute("list", choices.id); }
        choices.innerHTML = (values || []).map(value => `<option value="${escapeHtml(value)}"></option>`).join("");
        input.placeholder = (values || []).length > 1 ? "Kontakt aus Stammdaten auswählen" : "";
      }
      portalQuery(`input[name="cpMode"][value="${portal.mode === "collection" ? "collection" : "single"}"]`).checked = true;
      for (const input of portalQueryAll("[data-cp-module]")) input.checked = Boolean(portal.modules?.[input.dataset.cpModule]);
      renderRecipients(portal.selectedRecipientIds || []);
      const employees=(employeeData.employees||[]).filter(row=>row.active!==false);window.kristineCustomerPortalEmployees=employees;
      document.getElementById("cpPointAssignee").innerHTML='<option value="">Noch nicht eingeteilt · Alex prüft</option>'+employees.map(row=>`<option value="${escapeHtml(row.id)}">${escapeHtml(row.name)}</option>`).join("");
      renderAdminPoints(pointData.points||[]);
      renderJobs(job, portal.includedJobIds || []);
      document.getElementById("cpJobs").classList.toggle("open", selectedMode() === "collection");
      document.getElementById("cpPointForm").reset();
      document.getElementById("cpPointFiles").textContent = "";
      updateButton(portal.status);
      updateInvitationLinks();
      readyJobId = jobId;
      document.getElementById("cpSave").disabled = false;
      setMessage("");
    } catch (error) {
      setMessage(error.message, true);
    }
  }
  async function savePoint(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const jobId = currentJobId, button = document.getElementById("cpPointSave"), files = [...document.getElementById("cpPointPhotos").files], photosInternal = document.getElementById("cpPointPhotosInternal").checked;
    if (!jobId || readyJobId !== jobId) return setMessage("Bitte die Kundenportal-Adminoberfläche zuerst vollständig laden.", true);
    if (files.length > 6) return setMessage("Bitte höchstens 6 Fotos pro Punkt auswählen.", true);
    button.disabled = true;setMessage("Besprechungspunkt wird gespeichert …");
    try {
      const photos = await Promise.all(files.map(fileData));
      const result = await api(`/admin/api/job/${encodeURIComponent(jobId)}/customer-portal/points`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: document.getElementById("cpPointTitle").value, area: document.getElementById("cpPointArea").value, text: document.getElementById("cpPointText").value, responsibility: document.getElementById("cpPointResponsibility").value, photos, photosInternal }) });
      if (currentJobId !== jobId) throw new Error("Die geöffnete Akte hat sich geändert. Bitte nochmals öffnen.");
      form.reset();document.getElementById("cpPointFiles").textContent = "";
      const pointData = await api(`/admin/api/job/${encodeURIComponent(jobId)}/customer-portal/points`);renderPoints(pointData.points || []);
      const visible = portalQuery('[data-cp-module="projectPoints"]').checked;
      setMessage(`Punkt gespeichert${files.length ? ` · ${files.length} Foto(s)${photosInternal ? " intern" : ""}` : ""}.${visible ? "" : " Für den Bauherrn wird er sichtbar, sobald Freigabe 4 aktiviert und gespeichert ist."}`);
    } catch (error) { setMessage(error.message, true); }
    finally { button.disabled = false; }
  }
  async function save() {
    const jobId = currentJobId;
    if (!jobId || readyJobId !== jobId) { setMessage("Bitte die Kundenfreigabe zuerst vollständig laden.", true); return null; }
    const button = document.getElementById("cpSave");
    button.disabled = true;
    setMessage("Wird gespeichert …");
    const modules = {};
    for (const input of portalQueryAll("[data-cp-module]")) modules[input.dataset.cpModule] = input.checked;
    const selectedRecipientIds=[...portalQueryAll("[data-cp-recipient]:checked")].map(input=>input.dataset.cpRecipient);
    const recipients=recipientOptions.filter(row=>selectedRecipientIds.includes(row.id));
    if(document.getElementById("cpManualRecipient").checked){selectedRecipientIds.push("manual");recipients.push({id:"manual",role:"manual",roleLabel:"Sonstiger Empfänger",name:document.getElementById("cpName").value,email:document.getElementById("cpEmail").value,phone:document.getElementById("cpPhone").value})}
    const body = {
      status: document.getElementById("cpStatus").value,
      mode: selectedMode(),
      customerName: document.getElementById("cpName").value,
      customerEmail: document.getElementById("cpEmail").value,
      customerPhone: document.getElementById("cpPhone").value,
      contactSelectionKey,
      recipients,
      selectedRecipientIds,
      modules,
      includedJobIds: [...portalQueryAll("[data-cp-job]:checked")].map(input => input.dataset.cpJob),
    };
    try {
      const data = await api(`/admin/api/job/${encodeURIComponent(jobId)}/customer-portal`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if(currentJobId!==jobId)throw new Error("Die geöffnete Akte hat sich geändert. Bitte nochmals öffnen.");
      portalUrl = data.portalUrl;
      updateButton(data.portal.status);
      const job = (window.kristineCustomerPortalJobs || []).find(item => String(item.jobId) === currentJobId);
      if (job) job.customerPortal = data.portal;
      updateInvitationLinks();
      setMessage("Gespeichert · direkt bei der Baustelle abgelegt.");
      return data;
    } catch (error) {
      setMessage(error.message, true);
      return null;
    } finally {
      button.disabled = false;
    }
  }
  function mount() {
    const top = document.querySelector(".detail-actions");
    const links = document.querySelector(".detail-links");
    if (!top || !links || document.getElementById("detailCustomerPortal")) return;
    const topButton = document.createElement("a");
    topButton.id = "detailCustomerPortal";
    topButton.href = "#";
    topButton.className = "customer-portal-button portal-off";
    topButton.textContent = "Kundenportal";
    const link = document.createElement("a");
    link.href = "#";
    link.className = "customer-portal-button customer-portal-link portal-off";
    link.innerHTML = "🔐 <span>Kundenportal<small>Nicht eingerichtet</small></span>";
    top.appendChild(topButton);
    links.appendChild(link);
    for (const element of [topButton, link]) element.addEventListener("click", event => {
      event.preventDefault();
      const tab = document.querySelector('[data-bk-tab="customerPortal"]');
      if (tab) {
        window.BaustellenKnowledgeHub?.tab?.("customerPortal");
        tab.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } else openSettings();
    });
    new MutationObserver(() => {
      const jobId = String(document.getElementById("detailNumber")?.textContent || "").replace(/^#/, "");
      const job = (window.kristineCustomerPortalJobs || []).find(item => String(item.jobId) === jobId);
      updateButton(job?.customerPortal?.status || "off");
    }).observe(document.getElementById("detailNumber"), { childList: true });
  }
  modal.querySelector(".cp-close").addEventListener("click", () => modal.classList.remove("open"));
  modal.addEventListener("click", event => { if (event.target === modal) modal.classList.remove("open"); });
  portalQueryAll('input[name="cpMode"]').forEach(input => input.addEventListener("change", () => document.getElementById("cpJobs").classList.toggle("open", selectedMode() === "collection")));
  document.getElementById("cpRecipientAdd").addEventListener("click",()=>{const id=document.getElementById("cpRecipientDropdown").value;if(!id)return;const input=portalQuery(`[data-cp-recipient="${CSS.escape(id)}"]`);if(input){input.checked=true;input.closest("label")?.scrollIntoView({behavior:"smooth",block:"nearest"})}});
  document.getElementById("cpSave").addEventListener("click", save);
  const updatePointFiles = () => { const files = [...document.getElementById("cpPointPhotos").files], internal = document.getElementById("cpPointPhotosInternal").checked; document.getElementById("cpPointFiles").textContent = files.length ? `${files.length} Foto(s)${internal ? " · intern" : ""}: ${files.map(file => file.name).join(", ")}` : ""; };
  document.getElementById("cpPointPhotos").addEventListener("change", updatePointFiles);
  document.getElementById("cpPointPhotosInternal").addEventListener("change", updatePointFiles);
  document.getElementById("cpPointSave").addEventListener("click",()=>createPoint(false));
  document.getElementById("cpPointSend").addEventListener("click",()=>createPoint(true));
  document.getElementById("cpPointForm").addEventListener("submit",event=>{event.preventDefault();createPoint(false);});
  document.getElementById("cpSendSelected").addEventListener("click",async()=>{
    const button=document.getElementById("cpSendSelected");if(button.disabled)return;button.disabled=true;
    try{const saved=await save();if(!saved)return;const recipientIds=saved.portal?.selectedRecipientIds||[],result=await api(`/admin/api/job/${encodeURIComponent(currentJobId)}/customer-portal/invitations/send`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({recipientIds})}),now=new Date().toISOString();invitationStatuses=(result.results||[]).map((row,index)=>({id:`new-${index}`,recipientId:row.recipient?.id,recipient:row.recipient,createdAt:now,sentAt:row.sent?now:null,readAt:null,channels:row.channels||[],error:row.error||""})).concat(invitationStatuses);renderRecipients(recipientIds);const sent=(result.results||[]).filter(row=>row.sent).length,open=(result.results||[]).length-sent;setMessage(`${result.results.length} persönliche Link(s) erstellt · ${sent} versendet${open?` · ${open} Versand offen`:""}`,open>0)}catch(error){setMessage(error.message,true)}finally{button.disabled=false}
  });
  let inviting=false;
  async function invite(channel,event){
    event?.preventDefault();if(inviting)return;
    if (!currentJobId || readyJobId !== currentJobId) return setMessage("Bitte die Kundenfreigabe zuerst vollständig laden.", true);
    let phone=document.getElementById("cpPhone").value.replace(/\D/g,"");
    if(phone.startsWith("00"))phone=phone.slice(2);
    else if(phone.startsWith("0"))phone="43"+phone.slice(1);
    if(channel==="whatsapp"&&!/^[1-9]\d{6,14}$/.test(phone))return setMessage("Bitte eine gültige WhatsApp-Nummer eintragen.",true);
    const email=document.getElementById("cpEmail").value.trim();
    if(channel==="email"&&(!document.getElementById("cpEmail").validity.valid||!email))return setMessage("Bitte eine E-Mail-Adresse eintragen.",true);
    const jobId=currentJobId,popup=channel!=="email"?window.open("about:blank","_blank"):null;
    if(popup)popup.opener=null;
    inviting=true;
    try{
      const saved=await save();if(!saved){popup?.close();return}
      const result=await api(`/admin/api/job/${encodeURIComponent(jobId)}/customer-portal/invitation`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({preview:channel==="preview"})});
      if(currentJobId!==jobId)throw new Error("Die geöffnete Akte hat sich geändert. Bitte nochmals öffnen.");
      portalUrl=result.portalUrl;
      const url=channel==="whatsapp"?`https://wa.me/${phone}?text=${encodeURIComponent(invitationText())}`:channel==="email"?`mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent("Ihre KRISTINE Projektakte")}&body=${encodeURIComponent(invitationText())}`:portalUrl;
      if(channel==="email")location.href=url;else if(popup)popup.location.replace(url);else location.href=url;
      setMessage(channel==="preview"?"Kundenansicht geöffnet.":"Persönlicher Link erstellt. Die Einladung ist zum Versenden geöffnet.");
    }catch(error){popup?.close();setMessage(error.message,true)}finally{inviting=false}
  }
  document.getElementById("cpWhatsApp").addEventListener("click",event=>invite("whatsapp",event));
  document.getElementById("cpEmailInvite").addEventListener("click",event=>invite("email",event));
  document.getElementById("cpOpen").addEventListener("click",event=>invite("preview",event));
  ["cpName", "cpEmail"].forEach(id => document.getElementById(id).addEventListener("input", updateInvitationLinks));
  function openInline(jobId = "") {
    const host = document.getElementById("bkCustomerPortal");
    if (!host) return openSettings(jobId);
    return openSettings(jobId, host);
  }
  window.KristaCustomerPortal = { openInline, openModal: () => openSettings() };
  window.addEventListener?.("krista:customer-portal-inline", event => openInline(event.detail?.jobId || ""));
  if (document.querySelector?.('[data-bk-tab="customerPortal"].active')) setTimeout(() => openInline(), 0);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
