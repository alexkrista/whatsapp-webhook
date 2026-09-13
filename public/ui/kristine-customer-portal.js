(() => {
  const moduleLabels = {
    projectFile: "1 · Projektakte, Dokumente, Fotos & Material",
    regie: "2 · Regieberichte",
    communication: "3 · Kommunikation",
    projectPoints: "4 · Projektpunkte / Wünsche",
  };
  let currentJobId = "";
  let portalUrl = "";

  const style = document.createElement("style");
  style.textContent = `.customer-portal-button{display:inline-flex;align-items:center;gap:7px;cursor:pointer}.customer-portal-button::before{content:"";width:8px;height:8px;border-radius:50%;background:#9a9e9a}.customer-portal-button.portal-prepared::before{background:#e49a31}.customer-portal-button.portal-active::before{background:#43b878}.customer-portal-link small{display:block;margin-top:3px;color:#737873;font-size:10px}.cp-backdrop{position:fixed;inset:0;z-index:900;background:rgba(16,24,19,.56);display:none;align-items:center;justify-content:center;padding:16px}.cp-backdrop.open{display:flex}.cp-dialog{width:min(720px,100%);max-height:92vh;overflow:auto;background:#fffefa;border-radius:18px;box-shadow:0 24px 70px rgba(0,0,0,.28)}.cp-head{display:flex;justify-content:space-between;gap:12px;padding:18px 20px;background:#17211b;color:#fff}.cp-head h2{font-size:20px;margin:0}.cp-head p{margin:3px 0 0;color:rgba(255,255,255,.68);font-size:12px}.cp-close{border:0;background:transparent;color:#fff;font-size:24px;cursor:pointer}.cp-body{padding:20px}.cp-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.cp-field{display:grid;gap:5px;font-size:12px;font-weight:800;color:#626862}.cp-field input,.cp-field select{font:inherit;font-weight:500;min-height:42px;border:1px solid #d6d3ca;border-radius:10px;padding:9px;background:#fff}.cp-section{margin-top:18px;padding-top:16px;border-top:1px solid #e7e3da}.cp-section h3{margin:0 0 4px;font-size:15px}.cp-help{margin:0 0 11px;color:#747a74;font-size:12px}.cp-option{display:flex;gap:10px;align-items:flex-start;border:1px solid #e2ded5;border-radius:11px;padding:11px;margin:8px 0;font-size:13px;font-weight:750;background:#fbfaf6}.cp-option input{margin-top:2px}.cp-jobs{display:none;margin-top:10px;max-height:180px;overflow:auto;border:1px solid #e2ded5;border-radius:11px;padding:7px}.cp-jobs.open{display:block}.cp-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}.cp-actions button,.cp-actions a{border:1px solid #cfcac0;border-radius:10px;padding:10px 13px;background:#fff;color:#293029;text-decoration:none;font:800 12px system-ui;cursor:pointer}.cp-actions .primary{background:#2f7d4a;border-color:#2f7d4a;color:#fff}.cp-status{min-height:18px;margin-top:10px;font-size:12px;color:#667066}.cp-status.error{color:#a84540}@media(max-width:650px){.cp-grid{grid-template-columns:1fr}.cp-dialog{max-height:96vh}.cp-actions>*{flex:1;text-align:center}}`;
  document.head.appendChild(style);

  const modal = document.createElement("div");
  modal.className = "cp-backdrop";
  modal.innerHTML = `<section class="cp-dialog" role="dialog" aria-modal="true" aria-labelledby="cpTitle"><header class="cp-head"><div><h2 id="cpTitle">Kundenportal</h2><p id="cpSubtitle">Direkt mit der Baustelle verbunden</p></div><button class="cp-close" type="button" aria-label="Schließen">×</button></header><div class="cp-body"><div class="cp-grid"><label class="cp-field">Portalstatus<select id="cpStatus"><option value="off">Nicht eingerichtet</option><option value="prepared">Vorbereitet · Einladung offen</option><option value="active">Aktiv · Kunde hat Zugang</option></select></label><label class="cp-field">Kundenname<input id="cpName" autocomplete="name"></label><label class="cp-field">E-Mail<input id="cpEmail" type="email" autocomplete="email"></label><label class="cp-field">WhatsApp / Telefon<input id="cpPhone" type="tel" autocomplete="tel"></label></div><div class="cp-section"><h3>Freigabeoptionen</h3><p class="cp-help">Jede Freigabe ist einzeln wählbar – zum Beispiel nur 1 und 3 oder ausschließlich 4.</p><div id="cpModules"></div></div><div class="cp-section"><h3>Umfang</h3><label class="cp-option"><input type="radio" name="cpMode" value="single" checked><span><strong>Nur diese Baustelle</strong><br><small>Eigene Kundenakte für dieses Projekt</small></span></label><label class="cp-option"><input type="radio" name="cpMode" value="collection"><span><strong>Sammelmappe</strong><br><small>Diese und weitere ausgewählte Baustellen gemeinsam zeigen</small></span></label><div id="cpJobs" class="cp-jobs"></div></div><div class="cp-actions"><button id="cpSave" class="primary" type="button">Speichern</button><button id="cpWhatsApp" type="button">Per WhatsApp einladen</button><a id="cpEmailInvite" href="#">Per E-Mail einladen</a><a id="cpOpen" href="#" target="_blank" rel="noopener">Portal öffnen</a></div><div id="cpMessage" class="cp-status"></div></div></section>`;
  document.body.appendChild(modal);
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
  const selectedMode = () => modal.querySelector('input[name="cpMode"]:checked')?.value || "single";
  const setMessage = (text, error = false) => {
    const element = document.getElementById("cpMessage");
    element.textContent = text;
    element.classList.toggle("error", error);
  };
  const invitationText = () => `Guten Tag ${document.getElementById("cpName").value || ""},\n\nIhre Unterlagen zur Baustelle #${currentJobId} stehen im KRISTINE Kundenportal bereit:\n${portalUrl}\n\nDer Link führt zur sicheren Anmeldung.`;
  function updateInvitationLinks() {
    const email = document.getElementById("cpEmail").value.trim();
    document.getElementById("cpEmailInvite").href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent("Ihre KRISTINE Projektakte")}&body=${encodeURIComponent(invitationText())}`;
    document.getElementById("cpOpen").href = portalUrl || "#";
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
  function renderJobs(job, selected) {
    const host = document.getElementById("cpJobs");
    const jobs = Array.isArray(window.kristineCustomerPortalJobs) ? window.kristineCustomerPortalJobs : [];
    const ids = [...new Set((job.collectionSummary?.jobIds || [job.jobId, ...(job.collectionMemberJobIds || [])]).map(String))].filter(id => id !== currentJobId);
    host.innerHTML = ids.map(id => {
      const member = jobs.find(item => String(item.jobId) === id) || { jobId: id };
      return `<label class="cp-option"><input type="checkbox" data-cp-job="${escapeHtml(id)}" checked disabled><span><strong>#${escapeHtml(id)}</strong> · ${escapeHtml(member.name || "Einzelakte")}</span></label>`;
    }).join("") || '<div class="cp-help">Keine weitere Einzelakte in dieser Sammelmappe.</div>';
    const collectionChoice = modal.querySelector('input[name="cpMode"][value="collection"]')?.closest("label");
    if (collectionChoice) collectionChoice.hidden = ids.length === 0;
    if (!ids.length && selectedMode() === "collection") modal.querySelector('input[name="cpMode"][value="single"]').checked = true;
  }
  async function openSettings() {
    currentJobId = String(location.hash.slice(1) || document.getElementById("detailNumber")?.textContent.replace(/^#/, "") || "");
    if (!currentJobId) return;
    modal.classList.add("open");
    setMessage("Wird geladen …");
    try {
      const data = await api(`/admin/api/job/${encodeURIComponent(currentJobId)}/customer-portal`);
      const portal = data.portal || {};
      portalUrl = data.portalUrl || "";
      const job = (window.kristineCustomerPortalJobs || []).find(item => String(item.jobId) === currentJobId) || {};
      document.getElementById("cpSubtitle").textContent = `Baustelle #${currentJobId}`;
      document.getElementById("cpStatus").value = portal.status || "off";
      document.getElementById("cpName").value = portal.customerName || job.contactName || job.name || "";
      document.getElementById("cpEmail").value = portal.customerEmail || job.contactEmail || "";
      document.getElementById("cpPhone").value = portal.customerPhone || job.contactPhone || "";
      modal.querySelector(`input[name="cpMode"][value="${portal.mode === "collection" ? "collection" : "single"}"]`).checked = true;
      for (const input of modal.querySelectorAll("[data-cp-module]")) input.checked = Boolean(portal.modules?.[input.dataset.cpModule]);
      renderJobs(job, portal.includedJobIds || []);
      document.getElementById("cpJobs").classList.toggle("open", selectedMode() === "collection");
      updateButton(portal.status);
      updateInvitationLinks();
      setMessage("");
    } catch (error) {
      setMessage(error.message, true);
    }
  }
  async function save() {
    const button = document.getElementById("cpSave");
    button.disabled = true;
    setMessage("Wird gespeichert …");
    const modules = {};
    for (const input of modal.querySelectorAll("[data-cp-module]")) modules[input.dataset.cpModule] = input.checked;
    const body = {
      status: document.getElementById("cpStatus").value,
      mode: selectedMode(),
      customerName: document.getElementById("cpName").value,
      customerEmail: document.getElementById("cpEmail").value,
      customerPhone: document.getElementById("cpPhone").value,
      modules,
      includedJobIds: [...modal.querySelectorAll("[data-cp-job]:checked")].map(input => input.dataset.cpJob),
    };
    try {
      const data = await api(`/admin/api/job/${encodeURIComponent(currentJobId)}/customer-portal`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      portalUrl = data.portalUrl;
      updateButton(data.portal.status);
      const job = (window.kristineCustomerPortalJobs || []).find(item => String(item.jobId) === currentJobId);
      if (job) job.customerPortal = data.portal;
      updateInvitationLinks();
      setMessage("Gespeichert · direkt bei der Baustelle abgelegt.");
    } catch (error) {
      setMessage(error.message, true);
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
    for (const element of [topButton, link]) element.addEventListener("click", event => { event.preventDefault(); openSettings(); });
    new MutationObserver(() => {
      const jobId = String(document.getElementById("detailNumber")?.textContent || "").replace(/^#/, "");
      const job = (window.kristineCustomerPortalJobs || []).find(item => String(item.jobId) === jobId);
      updateButton(job?.customerPortal?.status || "off");
    }).observe(document.getElementById("detailNumber"), { childList: true });
  }
  modal.querySelector(".cp-close").addEventListener("click", () => modal.classList.remove("open"));
  modal.addEventListener("click", event => { if (event.target === modal) modal.classList.remove("open"); });
  modal.querySelectorAll('input[name="cpMode"]').forEach(input => input.addEventListener("change", () => document.getElementById("cpJobs").classList.toggle("open", selectedMode() === "collection")));
  document.getElementById("cpSave").addEventListener("click", save);
  document.getElementById("cpWhatsApp").addEventListener("click", () => {
    const phone = document.getElementById("cpPhone").value.replace(/\D/g, "");
    if (!phone) return setMessage("Bitte zuerst eine WhatsApp-Nummer eintragen.", true);
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(invitationText())}`, "_blank", "noopener");
  });
  ["cpName", "cpEmail"].forEach(id => document.getElementById(id).addEventListener("input", updateInvitationLinks));
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
