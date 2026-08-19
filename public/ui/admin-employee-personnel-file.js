"use strict";

(function () {
  let employmentHistory = [];
  let personnelDocuments = [];

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));

  function uid(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function dateLabel(value) {
    if (!value) return "offen";
    try { return new Date(`${value}T12:00:00`).toLocaleDateString("de-AT"); } catch { return value; }
  }

  function readDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Datei konnte nicht gelesen werden"));
      reader.readAsDataURL(file);
    });
  }

  async function fileToDocument(file) {
    const allowed = [
      "image/jpeg", "image/png", "image/webp", "application/pdf", "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ];
    if (!file || !allowed.includes(file.type)) throw new Error("Erlaubt sind JPG/PNG/WEBP, PDF, DOC und DOCX.");
    if (file.size > 4 * 1024 * 1024) throw new Error("Dokument ist größer als 4 MB. Bitte vorher verkleinern.");
    let data;
    if (file.type.startsWith("image/") && typeof window.optimizeImageFile === "function") {
      data = await window.optimizeImageFile(file, 1400, .82);
    } else {
      data = await readDataUrl(file);
    }
    return { name: file.name, type: file.type, size: file.size, data };
  }

  function ensureStyle() {
    if (document.getElementById("employeePersonnelFileStyle")) return;
    const style = document.createElement("style");
    style.id = "employeePersonnelFileStyle";
    style.textContent = `
      .emp-inline-entry{display:flex;gap:8px;align-items:center}.emp-inline-entry input{flex:1}.emp-inline-entry button{white-space:nowrap}
      .employee-personnel-section{grid-column:1/-1;background:#fff;border:1px solid #e3e3e3;border-radius:10px;padding:12px}
      .employee-personnel-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;flex-wrap:wrap}
      .employee-personnel-list{display:grid;gap:7px}.employee-personnel-row{display:grid;grid-template-columns:minmax(220px,1.7fr) 160px 120px auto;gap:10px;align-items:center;padding:9px 10px;border:1px solid #e8e5df;border-radius:10px;background:#faf9f6}
      .employee-personnel-row strong{display:block}.employee-personnel-row small{color:#777}.employee-personnel-actions{display:flex;gap:6px;justify-content:flex-end}.employee-personnel-actions a,.employee-personnel-actions button{padding:6px 8px;border-radius:7px;font-size:12px;text-decoration:none}
      .employee-personnel-empty{color:#777;font-size:12px;padding:8px 0}
      .personnel-add-grid{display:grid;grid-template-columns:1.2fr 1fr 150px 1.6fr;gap:8px;align-items:end;margin-top:10px}.personnel-add-grid .full{grid-column:1/-1}
      .emp-history-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.48);display:none;z-index:130}.emp-history-modal{position:fixed;left:50%;top:8vh;transform:translateX(-50%);width:min(900px,94vw);max-height:84vh;overflow:auto;background:#fff;border-radius:18px;box-shadow:0 18px 70px rgba(0,0,0,.35);display:none;z-index:131}.emp-history-body{padding:18px}.emp-history-table{width:100%;border-collapse:collapse}.emp-history-table th,.emp-history-table td{padding:8px;border-bottom:1px solid #eee;text-align:left}.emp-history-table input{min-width:0;width:100%;box-sizing:border-box}.emp-history-new{display:grid;grid-template-columns:150px 150px 1fr 1.2fr auto;gap:8px;align-items:end;margin:14px 0}
      @media(max-width:760px){.employee-personnel-row,.personnel-add-grid,.emp-history-new{grid-template-columns:1fr}.employee-personnel-actions{justify-content:flex-start}}
    `;
    document.head.appendChild(style);
  }

  function addFieldRow(id, label, placeholder) {
    if (document.getElementById(id)) return null;
    const row = document.createElement("div");
    row.innerHTML = `<label>${esc(label)}</label><input id="${id}" placeholder="${esc(placeholder || "")}">`;
    return row;
  }

  function ensureBaseFields(form) {
    const birth = document.getElementById("empBirthDate")?.closest("div");
    const svRow = addFieldRow("empSocialSecurityNumber", "SV-Nummer", "z. B. 1234 010180");
    const kvRow = addFieldRow("empCollectiveAgreementClassification", "KV-Einstufung", "z. B. Facharbeiter / Lohngruppe / Stufe");
    if (svRow) (birth || form.firstElementChild)?.insertAdjacentElement("afterend", svRow);
    if (kvRow) (svRow || birth || form.firstElementChild)?.insertAdjacentElement("afterend", kvRow);

    const start = document.getElementById("empEmploymentStart");
    if (start && !document.getElementById("empEmploymentHistoryButton")) {
      const wrap = document.createElement("div");
      wrap.className = "emp-inline-entry";
      start.parentNode.insertBefore(wrap, start);
      wrap.appendChild(start);
      const button = document.createElement("button");
      button.id = "empEmploymentHistoryButton";
      button.type = "button";
      button.className = "secondary";
      button.textContent = "Historie";
      button.addEventListener("click", openHistory);
      wrap.appendChild(button);
    }
  }

  function ensureHistoryModal() {
    if (document.getElementById("empHistoryModal")) return;
    const backdrop = document.createElement("div");
    backdrop.id = "empHistoryBackdrop";
    backdrop.className = "emp-history-backdrop";
    backdrop.addEventListener("click", closeHistory);
    const modal = document.createElement("section");
    modal.id = "empHistoryModal";
    modal.className = "emp-history-modal";
    modal.innerHTML = `
      <div class="employee-modal-head"><div><strong>📅 Eintritt / Austritt · Historie</strong><div class="small" style="color:#ddd">Mehrere Beschäftigungsabschnitte nach der bisherigen Arbeitsjahre-Vorlage</div></div><button type="button" class="closebtn" id="empHistoryClose">×</button></div>
      <div class="emp-history-body">
        <div class="emp-history-new">
          <div><label>Von</label><input id="empHistoryFrom" type="date"></div>
          <div><label>Bis</label><input id="empHistoryTo" type="date"></div>
          <div><label>Art / Grund</label><input id="empHistoryKind" placeholder="Beschäftigung, Lehre, Präsenzdienst …"></div>
          <div><label>Notiz</label><input id="empHistoryNote" placeholder="optional"></div>
          <button type="button" id="empHistoryAdd">+ Eintrag</button>
        </div>
        <div id="empHistoryList"></div>
      </div>`;
    document.body.append(backdrop, modal);
    document.getElementById("empHistoryClose").addEventListener("click", closeHistory);
    document.getElementById("empHistoryAdd").addEventListener("click", addHistoryRow);
  }

  function renderHistory() {
    const box = document.getElementById("empHistoryList");
    if (!box) return;
    const rows = [...employmentHistory].sort((a, b) => String(b.from || "").localeCompare(String(a.from || "")));
    box.innerHTML = rows.length ? `<table class="emp-history-table"><thead><tr><th>Von</th><th>Bis</th><th>Art / Grund</th><th>Notiz</th><th></th></tr></thead><tbody>${rows.map((row) => `
      <tr><td>${esc(dateLabel(row.from))}</td><td>${esc(dateLabel(row.to))}</td><td><strong>${esc(row.kind || "Beschäftigung")}</strong></td><td>${esc(row.note || "")}</td><td><button type="button" class="danger" data-history-remove="${esc(row.id)}">×</button></td></tr>`).join("")}</tbody></table>` : '<div class="employee-personnel-empty">Noch keine Historieneinträge.</div>';
    box.querySelectorAll("[data-history-remove]").forEach((button) => button.addEventListener("click", () => {
      employmentHistory = employmentHistory.filter((row) => String(row.id) !== button.dataset.historyRemove);
      renderHistory();
    }));
  }

  function addHistoryRow() {
    const from = document.getElementById("empHistoryFrom").value;
    const to = document.getElementById("empHistoryTo").value;
    const kind = document.getElementById("empHistoryKind").value.trim() || "Beschäftigung";
    const note = document.getElementById("empHistoryNote").value.trim();
    if (!from && !to) { alert("Bitte zumindest Von oder Bis eintragen."); return; }
    employmentHistory.push({ id: uid("hist"), from, to, kind, note });
    ["empHistoryFrom", "empHistoryTo", "empHistoryKind", "empHistoryNote"].forEach((id) => document.getElementById(id).value = "");
    renderHistory();
  }

  function openHistory() {
    ensureHistoryModal();
    renderHistory();
    document.getElementById("empHistoryBackdrop").style.display = "block";
    document.getElementById("empHistoryModal").style.display = "block";
  }

  function closeHistory() {
    const backdrop = document.getElementById("empHistoryBackdrop");
    const modal = document.getElementById("empHistoryModal");
    if (backdrop) backdrop.style.display = "none";
    if (modal) modal.style.display = "none";
  }

  function ensurePersonnelSection(form) {
    if (document.getElementById("empPersonnelDocumentsSection")) return;
    const docs = form.querySelector(".employee-docs");
    const section = document.createElement("div");
    section.id = "empPersonnelDocumentsSection";
    section.className = "employee-personnel-section";
    section.innerHTML = `
      <div class="employee-personnel-head"><strong>🗂️ Personalakte / Sammelmappe</strong><span class="small">Zeugnisse, Verträge, Kurse, Nachweise und sonstige Mitarbeiter-Dokumente</span></div>
      <div id="empPersonnelDocumentsList" class="employee-personnel-list"></div>
      <div class="personnel-add-grid">
        <div><label>Bezeichnung</label><input id="empPersonnelDocTitle" placeholder="z. B. Lehrabschlusszeugnis"></div>
        <div><label>Kategorie</label><select id="empPersonnelDocCategory"><option>Zeugnis</option><option>Arbeitsvertrag</option><option>Kurs / Schulung</option><option>Berechtigung</option><option>Lohn / Personal</option><option>Sonstiges</option></select></div>
        <div><label>Datum</label><input id="empPersonnelDocDate" type="date"></div>
        <div><label>Datei</label><input id="empPersonnelDocFile" type="file" accept=".jpg,.jpeg,.png,.webp,.pdf,.doc,.docx,image/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"></div>
        <div class="full"><label>Notiz optional</label><input id="empPersonnelDocNote" placeholder="kurze Zusatzinformation"></div>
        <div class="full"><button id="empPersonnelDocAdd" type="button" class="secondary">+ Dokument zur Personalakte</button></div>
      </div>`;
    if (docs) docs.insertAdjacentElement("afterend", section); else form.appendChild(section);
    document.getElementById("empPersonnelDocAdd").addEventListener("click", addPersonnelDocument);
    renderPersonnelDocuments();
  }

  function renderPersonnelDocuments() {
    const box = document.getElementById("empPersonnelDocumentsList");
    if (!box) return;
    const rows = [...personnelDocuments].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || String(a.title || "").localeCompare(String(b.title || ""), "de"));
    box.innerHTML = rows.length ? rows.map((row) => {
      const doc = row.document || {};
      return `<div class="employee-personnel-row"><div><strong>${esc(row.title || doc.name || "Dokument")}</strong><small>${esc(doc.name || "")}${row.note ? ` · ${esc(row.note)}` : ""}</small></div><div>${esc(row.category || "Sonstiges")}</div><div>${esc(row.date ? dateLabel(row.date) : "–")}</div><div class="employee-personnel-actions"><a href="${doc.data}" download="${esc(doc.name || row.title || "Dokument")}">⬇</a>${doc.type === "application/pdf" || String(doc.type || "").startsWith("image/") ? `<a href="${doc.data}" target="_blank" rel="noopener">Öffnen</a>` : ""}<button type="button" class="danger" data-personnel-remove="${esc(row.id)}">×</button></div></div>`;
    }).join("") : '<div class="employee-personnel-empty">Noch keine Dokumente in der Personalakte.</div>';
    box.querySelectorAll("[data-personnel-remove]").forEach((button) => button.addEventListener("click", () => {
      personnelDocuments = personnelDocuments.filter((row) => String(row.id) !== button.dataset.personnelRemove);
      renderPersonnelDocuments();
    }));
  }

  async function addPersonnelDocument() {
    const input = document.getElementById("empPersonnelDocFile");
    const file = input.files?.[0];
    if (!file) { alert("Bitte eine Datei auswählen."); return; }
    try {
      const documentData = await fileToDocument(file);
      personnelDocuments.push({
        id: uid("pdoc"),
        title: document.getElementById("empPersonnelDocTitle").value.trim() || file.name,
        category: document.getElementById("empPersonnelDocCategory").value,
        date: document.getElementById("empPersonnelDocDate").value,
        note: document.getElementById("empPersonnelDocNote").value.trim(),
        document: documentData,
      });
      document.getElementById("empPersonnelDocTitle").value = "";
      document.getElementById("empPersonnelDocDate").value = "";
      document.getElementById("empPersonnelDocNote").value = "";
      input.value = "";
      renderPersonnelDocuments();
    } catch (error) {
      alert(error.message || String(error));
    }
  }

  function currentEmployee() {
    const id = document.getElementById("empEditId")?.value;
    return (window.employeeMasters || []).find((employee) => String(employee.id) === String(id)) || null;
  }

  function loadExtras(employee) {
    document.getElementById("empSocialSecurityNumber").value = employee?.socialSecurityNumber || "";
    document.getElementById("empCollectiveAgreementClassification").value = employee?.collectiveAgreementClassification || "";
    employmentHistory = Array.isArray(employee?.employmentHistory) ? structuredClone(employee.employmentHistory) : [];
    personnelDocuments = Array.isArray(employee?.personnelDocuments) ? structuredClone(employee.personnelDocuments) : [];
    renderPersonnelDocuments();
    renderHistory();
  }

  function clearExtras() {
    if (document.getElementById("empSocialSecurityNumber")) document.getElementById("empSocialSecurityNumber").value = "";
    if (document.getElementById("empCollectiveAgreementClassification")) document.getElementById("empCollectiveAgreementClassification").value = "";
    employmentHistory = [];
    personnelDocuments = [];
    renderPersonnelDocuments();
    renderHistory();
  }

  function installFetchInterceptor() {
    if (window.fetch.__kristaPersonnelWrapped) return;
    const originalFetch = window.fetch.bind(window);
    const wrapped = async function(input, init = {}) {
      try {
        const url = typeof input === "string" ? input : input?.url || "";
        const method = String(init.method || "GET").toUpperCase();
        const isEmployeeWrite = /\/admin\/api\/employees(?:\/[^?/#]+)?(?:\?|$)/.test(url) && (method === "POST" || method === "PUT");
        if (isEmployeeWrite && typeof init.body === "string") {
          const body = JSON.parse(init.body || "{}");
          body.socialSecurityNumber = document.getElementById("empSocialSecurityNumber")?.value.trim() || "";
          body.collectiveAgreementClassification = document.getElementById("empCollectiveAgreementClassification")?.value.trim() || "";
          body.employmentHistory = employmentHistory;
          body.personnelDocuments = personnelDocuments;
          init = { ...init, body: JSON.stringify(body) };
        }
      } catch (error) {
        console.error("Personalakte konnte dem Speichervorgang nicht hinzugefügt werden:", error);
      }
      return originalFetch(input, init);
    };
    wrapped.__kristaPersonnelWrapped = true;
    window.fetch = wrapped;
  }

  function wrapEmployeeFunctions() {
    const originalEdit = window.editEmployeeMaster;
    if (typeof originalEdit === "function" && !originalEdit.__kristaPersonnelWrapped) {
      const wrappedEdit = function(id) {
        const result = originalEdit.apply(this, arguments);
        const employee = (window.employeeMasters || []).find((row) => String(row.id) === String(id));
        loadExtras(employee || null);
        return result;
      };
      wrappedEdit.__kristaPersonnelWrapped = true;
      window.editEmployeeMaster = wrappedEdit;
    }

    const originalReset = window.resetEmployeeForm;
    if (typeof originalReset === "function" && !originalReset.__kristaPersonnelWrapped) {
      const wrappedReset = function() {
        const result = originalReset.apply(this, arguments);
        clearExtras();
        return result;
      };
      wrappedReset.__kristaPersonnelWrapped = true;
      window.resetEmployeeForm = wrappedReset;
    }
  }

  function install() {
    const form = document.querySelector(".employee-form");
    if (!form) return;
    ensureStyle();
    ensureBaseFields(form);
    ensureHistoryModal();
    ensurePersonnelSection(form);
    installFetchInterceptor();
    wrapEmployeeFunctions();
    const employee = currentEmployee();
    if (employee) loadExtras(employee); else clearExtras();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
