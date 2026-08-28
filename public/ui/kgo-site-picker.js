"use strict";

(() => {
  const VERSION = "2026-08-28-site-picker-1";
  const token = new URLSearchParams(location.search).get("token") || "";
  let jobs = [];
  let dialog = null;
  let input = null;
  let results = null;
  let status = null;
  let expressBox = null;
  let expressInput = null;
  let busy = false;

  function employeeId() {
    return new URLSearchParams(location.search).get("employeeId") || localStorage.getItem("kristineGoEmployeeId") || "";
  }

  function today() {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Vienna",
      year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
  }

  function withToken(path) {
    const url = new URL(path, location.origin);
    if (token) url.searchParams.set("token", token);
    return url.pathname + url.search;
  }

  async function api(path, options = {}) {
    const response = await fetch(withToken(path), {
      credentials: "same-origin",
      ...options,
      headers: {
        "Accept": "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; }
    catch { throw new Error(`Ungültige Serverantwort (${response.status}).`); }
    if (!response.ok || data.ok === false) throw new Error(data.error || `Serverfehler ${response.status}`);
    return data;
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;"
    })[char]);
  }

  function normalize(value) {
    return String(value || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function installCss() {
    if (document.getElementById("kgSitePickerCss")) return;
    const style = document.createElement("style");
    style.id = "kgSitePickerCss";
    style.textContent = `
      .kg-site-picker{width:min(640px,calc(100vw - 24px));border:0;border-radius:20px;padding:0;background:#f7f8f7;color:#10233f;box-shadow:0 22px 70px rgba(16,35,63,.28)}
      .kg-site-picker::backdrop{background:rgba(9,20,34,.48);backdrop-filter:blur(2px)}
      .kgsp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 18px 12px;background:#fff;border-bottom:1px solid rgba(16,35,63,.09)}
      .kgsp-head h2{margin:2px 0 0;font-size:21px}.kgsp-head small{display:block;margin-top:4px;color:#657387}.kgsp-close{border:0;background:#eef1f3;color:#10233f;border-radius:999px;width:38px;height:38px;font-size:23px;cursor:pointer}
      .kgsp-body{padding:16px}.kgsp-search{width:100%;box-sizing:border-box;border:2px solid #cfd6dd;border-radius:14px;background:#fff;padding:14px 15px;font:700 17px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;color:#10233f;outline:none}.kgsp-search:focus{border-color:#2f7d4a;box-shadow:0 0 0 3px rgba(47,125,74,.12)}
      .kgsp-status{min-height:20px;margin:8px 2px;color:#657387;font-size:12px}.kgsp-status.error{color:#a43f3a;font-weight:750}.kgsp-status.ok{color:#2f7d4a;font-weight:750}
      .kgsp-results{display:grid;gap:7px;max-height:44vh;overflow:auto}.kgsp-result{width:100%;display:flex;justify-content:space-between;align-items:center;gap:12px;text-align:left;border:1px solid #dbe0e4;border-radius:13px;background:#fff;color:#10233f;padding:11px 12px;cursor:pointer}.kgsp-result:hover,.kgsp-result:focus{border-color:#91ad98;background:#f6fbf7}.kgsp-result strong{display:block;font-size:14px}.kgsp-result small{display:block;color:#657387;margin-top:3px}.kgsp-badge{flex:none;border-radius:999px;padding:5px 8px;background:#e9f3ec;color:#2f6e43;font-size:10px;font-weight:900}.kgsp-badge.order{background:#e9eef4;color:#355b7a}
      .kgsp-empty{padding:16px;border:1px dashed #cfd6dd;border-radius:13px;color:#657387;text-align:center;background:#fff}
      .kgsp-footer{display:flex;gap:9px;justify-content:space-between;align-items:center;margin-top:13px;padding-top:13px;border-top:1px solid #dfe4e7}.kgsp-express-open{border:1px solid #d8a753;background:#fff6e3;color:#754c0c;border-radius:12px;padding:10px 12px;font-weight:850;cursor:pointer}.kgsp-cancel{border:0;background:#e8ecef;color:#10233f;border-radius:12px;padding:10px 12px;font-weight:800;cursor:pointer}
      .kgsp-express{margin-top:12px;padding:13px;border:1px solid #e0b76e;border-radius:14px;background:#fff8e9}.kgsp-express[hidden]{display:none!important}.kgsp-express strong{display:block}.kgsp-express p{margin:5px 0 10px;color:#765b2a;font-size:12px;line-height:1.4}.kgsp-express-row{display:flex;gap:8px}.kgsp-express-row input{min-width:0;flex:1;border:1px solid #cfb98d;border-radius:11px;padding:11px;font:inherit}.kgsp-express-row button{flex:none;border:0;border-radius:11px;background:#a96b14;color:#fff;padding:10px 12px;font-weight:850;cursor:pointer}
      .kgsp-result:disabled,.kgsp-express-row button:disabled,.kgsp-express-open:disabled{opacity:.55;cursor:wait}
      @media(max-width:560px){.kg-site-picker{width:calc(100vw - 12px);border-radius:17px}.kgsp-head{padding:15px}.kgsp-body{padding:12px}.kgsp-search{font-size:16px}.kgsp-results{max-height:50vh}.kgsp-result{align-items:flex-start}.kgsp-express-row{flex-direction:column}.kgsp-express-row button{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.id = "kgSitePickerDialog";
    dialog.className = "kg-site-picker";
    dialog.innerHTML = `
      <div class="kgsp-head">
        <div><div class="kg-eyebrow">Baustellenwechsel</div><h2>Baustelle suchen</h2><small>Nur Auftrag und Laufend · Auswahl immer bewusst anklicken.</small></div>
        <button class="kgsp-close" type="button" aria-label="Schließen">×</button>
      </div>
      <div class="kgsp-body">
        <input id="kgspSearch" class="kgsp-search" type="search" autocomplete="off" placeholder="Nummer oder Name …" aria-label="Baustelle suchen">
        <div id="kgspStatus" class="kgsp-status">Tippe Nummer oder Name.</div>
        <div id="kgspResults" class="kgsp-results"></div>
        <div id="kgspExpress" class="kgsp-express" hidden>
          <strong>Expressbaustelle</strong>
          <p>Nur wenn die Baustelle noch nicht angelegt ist. Chef/Büro bekommt automatisch einen Klärhinweis.</p>
          <div class="kgsp-express-row"><input id="kgspExpressName" type="text" maxlength="140" placeholder="z. B. Maier Feldkirch"><button id="kgspExpressSave" type="button">Express starten</button></div>
        </div>
        <div class="kgsp-footer"><button id="kgspExpressOpen" class="kgsp-express-open" type="button">+ Expressbaustelle</button><button class="kgsp-cancel" type="button">Abbrechen</button></div>
      </div>`;
    document.body.appendChild(dialog);
    input = dialog.querySelector("#kgspSearch");
    results = dialog.querySelector("#kgspResults");
    status = dialog.querySelector("#kgspStatus");
    expressBox = dialog.querySelector("#kgspExpress");
    expressInput = dialog.querySelector("#kgspExpressName");

    dialog.querySelector(".kgsp-close").onclick = close;
    dialog.querySelector(".kgsp-cancel").onclick = close;
    dialog.querySelector("#kgspExpressOpen").onclick = () => {
      expressBox.hidden = !expressBox.hidden;
      if (!expressBox.hidden) setTimeout(() => expressInput.focus(), 0);
    };
    dialog.querySelector("#kgspExpressSave").onclick = saveExpress;
    input.addEventListener("input", renderResults);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
      // Bewusst KEIN Enter-Autoselect: ein Treffer muss angeklickt werden.
    });
    dialog.addEventListener("click", (event) => {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    });
    return dialog;
  }

  function setStatus(text, kind = "") {
    if (!status) return;
    status.textContent = text;
    status.className = `kgsp-status${kind ? " " + kind : ""}`;
  }

  function renderResults() {
    if (!results || !input) return;
    const q = normalize(input.value);
    if (!q) {
      results.innerHTML = "";
      setStatus("Tippe Nummer oder Name. Geladen werden nur aktuelle Baustellen.");
      return;
    }
    const terms = q.split(/\s+/).filter(Boolean);
    const matches = jobs.filter((job) => {
      const hay = normalize([job.jobId, job.jobName, job.city, job.address].filter(Boolean).join(" "));
      return terms.every((term) => hay.includes(term));
    }).slice(0, 10);
    setStatus(matches.length ? `${matches.length}${matches.length === 10 ? "+" : ""} Treffer · bitte bewusst auswählen` : "Keine aktuelle Baustelle gefunden.", matches.length ? "" : "error");
    results.innerHTML = matches.length ? matches.map((job) => `
      <button class="kgsp-result" type="button" data-job-id="${esc(job.jobId)}">
        <span><strong>${esc(job.jobId)} · ${esc(job.jobName)}</strong><small>${esc([job.status, job.city].filter(Boolean).join(" · "))}</small></span>
        <span class="kgsp-badge${job.status === "Auftrag" ? " order" : ""}">${esc(job.status)}</span>
      </button>`).join("") : `<div class="kgsp-empty">Nichts Passendes unter Auftrag/Laufend.<br>Falls die Baustelle wirklich neu ist: Expressbaustelle verwenden.</div>`;
    results.querySelectorAll("[data-job-id]").forEach((button) => {
      button.onclick = () => selectJob(button.dataset.jobId);
    });
  }

  function setBusy(value) {
    busy = Boolean(value);
    dialog?.querySelectorAll("button,input").forEach((el) => { el.disabled = busy; });
  }

  async function loadJobs() {
    setStatus("Aktuelle Baustellen werden geladen …");
    const data = await api("/kristine/api/active-jobs");
    jobs = Array.isArray(data.jobs) ? data.jobs : [];
    setStatus("Tippe Nummer oder Name. Geladen werden nur Auftrag und Laufend.");
  }

  async function selectJob(jobId) {
    if (busy) return;
    const id = employeeId();
    if (!id) return setStatus("Mitarbeiter fehlt. KGO bitte über deinen persönlichen Link öffnen.", "error");
    setBusy(true);
    try {
      const data = await api("/kristine/api/switch-job", {
        method: "POST",
        body: JSON.stringify({ employeeId:id, date:today(), jobId }),
      });
      setStatus(data.reply || "Baustelle ausgewählt.", "ok");
      setTimeout(() => {
        close();
        if (window.KristineGo?.reload) window.KristineGo.reload().catch(() => location.reload());
        else location.reload();
      }, 280);
    } catch (error) {
      setStatus(error.message || String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function saveExpress() {
    if (busy) return;
    const id = employeeId();
    const name = String(expressInput?.value || "").replace(/\s+/g, " ").trim();
    if (!id) return setStatus("Mitarbeiter fehlt. KGO bitte über deinen persönlichen Link öffnen.", "error");
    if (name.length < 2) {
      expressInput?.focus();
      return setStatus("Bitte einen kurzen Namen für die Expressbaustelle eingeben.", "error");
    }
    setBusy(true);
    try {
      const data = await api("/kristine/api/switch-job", {
        method: "POST",
        body: JSON.stringify({ employeeId:id, date:today(), expressName:name }),
      });
      setStatus(data.reply || "Expressbaustelle gespeichert.", "ok");
      setTimeout(() => {
        close();
        if (window.KristineGo?.reload) window.KristineGo.reload().catch(() => location.reload());
        else location.reload();
      }, 380);
    } catch (error) {
      setStatus(error.message || String(error), "error");
    } finally {
      setBusy(false);
    }
  }

  async function open() {
    ensureDialog();
    input.value = "";
    results.innerHTML = "";
    expressBox.hidden = true;
    expressInput.value = "";
    jobs = [];
    if (!dialog.open) dialog.showModal();
    setTimeout(() => input.focus(), 0);
    try { await loadJobs(); }
    catch (error) { setStatus(`Baustellen konnten nicht geladen werden: ${error.message || error}`, "error"); }
  }

  function close() {
    if (dialog?.open) dialog.close();
  }

  function install() {
    installCss();
    ensureDialog();
    const wrong = document.getElementById("kgWrongSiteButton");
    const quick = document.getElementById("kgSwitchButton");
    if (wrong) wrong.onclick = (event) => { event.preventDefault(); open(); };
    if (quick) quick.onclick = (event) => { event.preventDefault(); open(); };
    window.KgoSitePicker = { open, close, version:VERSION };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once:true });
  else install();
})();
