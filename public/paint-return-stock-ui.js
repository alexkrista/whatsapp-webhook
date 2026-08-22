"use strict";
(function () {
  if (document.getElementById("tab-return") || document.getElementById("returnStockTabBtn")) return;

  const qs = new URLSearchParams(location.search);
  const token = qs.get("token") || "";
  const tokenized = (url) => url + (url.includes("?") ? "&" : "?") + (token ? "token=" + encodeURIComponent(token) : "").replace(/[?&]$/, "");
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function api(url, options = {}) {
    const response = await fetch(tokenized(url), {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({ ok: false, error: "Keine JSON-Antwort" }));
    if (!response.ok || data.ok === false) {
      const error = new Error(data.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.code = data.code || "";
      throw error;
    }
    return data;
  }

  const style = document.createElement("style");
  style.textContent = `
    .return-layout{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(330px,.9fr);gap:14px}
    .return-project{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--line);background:#f5f7f4;border-radius:13px;padding:11px 13px;margin-bottom:14px}
    .return-project-label{font-size:11px;font-weight:900;letter-spacing:.08em;color:var(--muted);text-transform:uppercase}
    .return-project-value{font-size:17px;font-weight:850;margin-top:2px}
    .return-project button{white-space:nowrap}
    .return-scan-actions{display:flex;gap:9px;flex-wrap:wrap;align-items:center}
    .return-scan-actions .btn{min-height:48px}
    .return-ean{max-width:270px}
    .return-material-card{margin-top:14px;border:1px solid var(--line);border-radius:14px;padding:14px;background:#fbfcfa}
    .return-material-name{font-size:21px;font-weight:900}.return-material-meta{color:var(--muted);margin-top:3px}
    .return-fields{display:grid;grid-template-columns:1.2fr .8fr;gap:10px;margin-top:14px}
    .return-field label{display:block;font-size:12px;font-weight:800;color:#596058;margin:0 0 5px}
    .return-book{width:100%;margin-top:12px;min-height:52px;font-size:16px}
    .return-learn{margin-top:14px;border:2px solid #d3a33a;background:#fff8e7;border-radius:14px;padding:14px}
    .return-learn h3{margin:0 0 5px}.return-learn-grid{display:grid;grid-template-columns:1fr 1.3fr .7fr;gap:9px;margin-top:10px}
    .return-status{margin-top:10px;font-weight:750;min-height:20px}.return-status.ok{color:#23673e}.return-status.err{color:#a7322d}
    .return-search-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.return-search-head h2{margin:0}
    .return-search{margin-top:10px}.return-results{margin-top:10px;border:1px solid var(--line);border-radius:13px;overflow:hidden;background:white}
    .return-row{display:grid;grid-template-columns:72px 1fr auto;gap:11px;align-items:center;padding:11px 12px;border-top:1px solid var(--line)}.return-row:first-child{border-top:0}
    .return-no{font-size:27px;font-weight:950;line-height:1}.return-main{min-width:0}.return-main b{font-size:15px}.return-sub{font-size:12px;color:var(--muted);margin-top:3px;white-space:normal}.return-side{text-align:right;font-weight:850}.return-age{font-size:11px;color:var(--muted);font-weight:650;margin-top:3px}
    .return-empty{padding:16px;color:var(--muted);text-align:center}
    .return-modal{position:fixed;inset:0;z-index:1300;background:#0009;display:flex;align-items:center;justify-content:center;padding:14px}.return-modal[hidden]{display:none!important}
    .return-modal-card{background:#fff;border-radius:17px;width:min(720px,100%);max-height:88vh;overflow:auto;padding:16px;box-shadow:0 20px 70px #0005}
    .return-modal-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.return-modal-head h2{margin:0}
    .return-job-row{padding:11px;border-top:1px solid var(--line);cursor:pointer}.return-job-row:first-child{border-top:0}.return-job-row:hover{background:#f4f7f4}.return-job-id{font-weight:900}.return-job-name{font-size:13px;color:var(--muted);margin-top:2px}
    #returnCameraReader{width:100%;min-height:270px;background:#111;border-radius:13px;overflow:hidden}#returnCameraReader video{width:100%!important;height:auto!important}
    .return-camera-hint{font-size:12px;color:var(--muted);margin-top:8px}
    @media(max-width:760px){.return-layout{grid-template-columns:1fr}.return-project{align-items:flex-start}.return-project-value{font-size:16px}.return-scan-actions{display:grid;grid-template-columns:1fr}.return-scan-actions .btn,.return-ean{width:100%;max-width:none}.return-fields,.return-learn-grid{grid-template-columns:1fr}.return-row{grid-template-columns:60px 1fr}.return-side{grid-column:2;text-align:left;display:flex;gap:9px;align-items:baseline}.return-no{font-size:31px}}
  `;
  document.head.appendChild(style);

  const tabs = document.querySelector(".tabs");
  const wrap = document.querySelector(".wrap");
  if (!tabs || !wrap) return;

  const tabBtn = document.createElement("button");
  tabBtn.id = "returnStockTabBtn";
  tabBtn.className = "btn";
  tabBtn.dataset.tab = "return";
  tabBtn.textContent = "Rückware";
  const adminBtn = tabs.querySelector('[data-tab="admin"]');
  tabs.insertBefore(tabBtn, adminBtn || null);

  const section = document.createElement("section");
  section.id = "tab-return";
  section.className = "hidden";
  section.innerHTML = `
    <div class="return-project">
      <div><div class="return-project-label">Baustelle bleibt aktiv</div><div id="returnProjectValue" class="return-project-value">Baustelle wählen …</div></div>
      <button id="returnProjectBtn" class="btn" type="button">Wechseln</button>
    </div>
    <div class="return-layout">
      <div class="card">
        <h2 style="margin-top:0">Rückware erfassen</h2>
        <div class="return-scan-actions">
          <button id="returnCameraBtn" class="btn primary" type="button">📷 Dose scannen</button>
          <input id="returnEan" class="field return-ean" inputmode="numeric" autocomplete="off" placeholder="oder Barcode eingeben">
          <button id="returnLookupBtn" class="btn" type="button">Übernehmen</button>
        </div>
        <div id="returnLearn" class="return-learn" hidden>
          <h3>Neuer Barcode</h3><div class="muted">Einmal zuordnen – beim nächsten Scan kennt KRISTINE das Material.</div>
          <div class="return-learn-grid">
            <div class="return-field"><label>Hersteller</label><input id="returnManufacturer" class="field" list="returnManufacturerList" autocomplete="off"></div>
            <div class="return-field"><label>Material</label><input id="returnMaterialName" class="field" list="returnMaterialList" autocomplete="off"></div>
            <div class="return-field"><label>Gebinde</label><input id="returnSize" class="field" placeholder="z. B. 15 L"></div>
          </div>
          <button id="returnLearnBtn" class="btn primary" type="button" style="margin-top:10px">Material merken</button>
        </div>
        <div id="returnMaterialCard" class="return-material-card" hidden>
          <div id="returnMaterialNameView" class="return-material-name"></div>
          <div id="returnMaterialMeta" class="return-material-meta"></div>
          <div class="return-fields">
            <div class="return-field"><label>Farbnummer / Farbton</label><input id="returnColour" class="field" list="returnColourList" autocomplete="off" placeholder="z. B. StoColor 32145"></div>
            <div class="return-field"><label>Gewicht in kg</label><input id="returnWeight" class="field" type="number" min="0.001" step="0.01" inputmode="decimal" placeholder="z. B. 3,40"></div>
          </div>
          <button id="returnBookBtn" class="btn primary return-book" type="button">Rückware buchen & Etikett</button>
        </div>
        <div id="returnStatus" class="return-status"></div>
      </div>
      <div class="card">
        <div class="return-search-head"><h2>Rückware finden</h2><span id="returnCount" class="chip">0</span></div>
        <input id="returnSearch" class="field return-search" autocomplete="off" placeholder="Farbe, Material, Nr. oder Baustelle …">
        <div id="returnResults" class="return-results"><div class="return-empty">Noch keine Rückware geladen.</div></div>
      </div>
    </div>
    <datalist id="returnManufacturerList"></datalist><datalist id="returnMaterialList"></datalist><datalist id="returnColourList"></datalist>
  `;
  const adminSection = document.getElementById("tab-admin");
  wrap.insertBefore(section, adminSection || null);

  const modal = document.createElement("div");
  modal.id = "returnProjectModal";
  modal.className = "return-modal";
  modal.hidden = true;
  modal.innerHTML = `<div class="return-modal-card"><div class="return-modal-head"><h2>Baustelle wählen</h2><button id="returnProjectClose" class="btn" type="button">Schließen</button></div><input id="returnProjectSearch" class="field" autocomplete="off" placeholder="Nummer oder Baustelle …"><div id="returnProjectRows" style="margin-top:8px"></div></div>`;
  document.body.appendChild(modal);

  const cameraModal = document.createElement("div");
  cameraModal.id = "returnCameraModal";
  cameraModal.className = "return-modal";
  cameraModal.hidden = true;
  cameraModal.innerHTML = `<div class="return-modal-card"><div class="return-modal-head"><h2>Dose scannen</h2><button id="returnCameraClose" class="btn" type="button">Schließen</button></div><div id="returnCameraReader"></div><div class="return-camera-hint">EAN/Barcode quer und ruhig ins Kamerabild halten.</div></div>`;
  document.body.appendChild(cameraModal);

  const el = (id) => document.getElementById(id);
  let currentMaterial = null;
  let currentEan = "";
  let jobs = [];
  let materials = [];
  let returns = [];
  let scanner = null;
  let scannerLocked = false;
  let project = loadProject();
  let initialized = false;
  let searchTimer = null;

  function setStatus(text, kind = "") {
    const node = el("returnStatus");
    node.textContent = text || "";
    node.classList.toggle("ok", kind === "ok");
    node.classList.toggle("err", kind === "err");
  }

  function loadProject() {
    try { return JSON.parse(localStorage.getItem("kristineReturnJob") || "null"); } catch { return null; }
  }
  function saveProject(value) {
    project = value;
    try { localStorage.setItem("kristineReturnJob", JSON.stringify(value)); } catch {}
    renderProject();
  }
  function renderProject() {
    const node = el("returnProjectValue");
    if (!node) return;
    if (!project) node.textContent = "Baustelle wählen …";
    else if (project.id === "__lager__") node.textContent = "Lager / keine Baustelle";
    else node.textContent = `${project.id} · ${project.name || project.id}`;
  }

  function showReturnTab() {
    if (typeof window.showTab === "function") window.showTab("return");
    else {
      document.querySelectorAll('[id^="tab-"]').forEach((node) => node.classList.add("hidden"));
      section.classList.remove("hidden");
      document.querySelectorAll("[data-tab]").forEach((button) => button.classList.toggle("active", button === tabBtn));
    }
    init();
  }
  tabBtn.addEventListener("click", showReturnTab);

  async function init() {
    renderProject();
    if (initialized) return;
    initialized = true;
    await Promise.all([loadJobs(), loadMaterials(), loadReturns("")]);
  }

  async function loadJobs() {
    try {
      const data = await api("/admin/api/paint/jobs");
      jobs = Array.isArray(data.jobs) ? data.jobs : [];
    } catch (error) { setStatus("Baustellen konnten nicht geladen werden: " + error.message, "err"); }
  }

  async function loadMaterials() {
    try {
      const data = await api("/admin/api/paint/returns/materials");
      materials = Array.isArray(data.materials) ? data.materials : [];
      const manufacturers = [...new Set(materials.map((row) => row.manufacturer).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
      el("returnManufacturerList").innerHTML = manufacturers.map((value) => `<option value="${esc(value)}"></option>`).join("");
      const names = [...new Set(materials.map((row) => row.material).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
      el("returnMaterialList").innerHTML = names.map((value) => `<option value="${esc(value)}"></option>`).join("");
    } catch {}
  }

  function renderProjectRows(query = "") {
    const q = String(query || "").trim().toLowerCase();
    const filtered = jobs.filter((row) => !q || `${row.id} ${row.name} ${row.city || ""}`.toLowerCase().includes(q)).slice(0, 80);
    const rows = [
      ...filtered.map((row) => `<div class="return-job-row" data-job="${esc(row.id)}"><div class="return-job-id">${esc(row.id)}</div><div class="return-job-name">${esc(row.name || row.id)}${row.city ? " · " + esc(row.city) : ""}</div></div>`),
      `<div class="return-job-row" data-job="__lager__"><div class="return-job-id">Lager / keine Baustelle</div><div class="return-job-name">Für Rückware ohne Projektbezug</div></div>`,
    ];
    el("returnProjectRows").innerHTML = rows.join("") || `<div class="return-empty">Keine Baustelle gefunden.</div>`;
    el("returnProjectRows").querySelectorAll("[data-job]").forEach((node) => {
      node.onclick = () => {
        const id = node.dataset.job;
        if (id === "__lager__") saveProject({ id, name: "Lager / keine Baustelle" });
        else {
          const row = jobs.find((job) => String(job.id) === String(id));
          saveProject({ id, name: row?.name || id });
        }
        modal.hidden = true;
      };
    });
  }

  el("returnProjectBtn").onclick = () => {
    modal.hidden = false;
    el("returnProjectSearch").value = "";
    renderProjectRows("");
    setTimeout(() => el("returnProjectSearch").focus(), 60);
  };
  el("returnProjectClose").onclick = () => { modal.hidden = true; };
  modal.addEventListener("click", (event) => { if (event.target === modal) modal.hidden = true; });
  el("returnProjectSearch").oninput = (event) => renderProjectRows(event.target.value);

  function resetMaterial() {
    currentMaterial = null;
    currentEan = "";
    el("returnMaterialCard").hidden = true;
    el("returnLearn").hidden = true;
    el("returnEan").value = "";
    el("returnColour").value = "";
    el("returnWeight").value = "";
  }

  function showMaterial(material, ean) {
    currentMaterial = material;
    currentEan = String(ean || material?.ean || "").replace(/\D/g, "");
    el("returnLearn").hidden = true;
    el("returnMaterialCard").hidden = false;
    el("returnMaterialNameView").textContent = [material.manufacturer, material.material].filter(Boolean).join(" · ");
    el("returnMaterialMeta").textContent = [material.size, material.base, material.stockCode ? `SKU ${material.stockCode}` : "", currentEan ? `EAN ${currentEan}` : ""].filter(Boolean).join(" · ");
    setStatus("Material erkannt ✓", "ok");
    setTimeout(() => el("returnColour").focus(), 60);
  }

  async function lookupEan(raw) {
    const code = String(raw || "").replace(/\D/g, "");
    if (code.length < 6) return setStatus("Barcode/EAN fehlt.", "err");
    currentEan = code;
    el("returnEan").value = code;
    setStatus("Barcode wird geprüft …");
    try {
      const data = await api("/admin/api/paint/returns/lookup?ean=" + encodeURIComponent(code));
      if (data.known && data.material) return showMaterial(data.material, code);
      currentMaterial = null;
      el("returnMaterialCard").hidden = true;
      el("returnLearn").hidden = false;
      el("returnManufacturer").value = "";
      el("returnMaterialName").value = "";
      el("returnSize").value = "";
      setStatus("Neuer Barcode – einmal Hersteller und Material zuordnen.");
      setTimeout(() => el("returnManufacturer").focus(), 60);
    } catch (error) { setStatus(error.message, "err"); }
  }

  el("returnLookupBtn").onclick = () => lookupEan(el("returnEan").value);
  el("returnEan").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); lookupEan(event.currentTarget.value); } });

  el("returnLearnBtn").onclick = async () => {
    const manufacturer = el("returnManufacturer").value.trim();
    const material = el("returnMaterialName").value.trim();
    const size = el("returnSize").value.trim();
    if (!currentEan) return setStatus("Zuerst Barcode scannen.", "err");
    if (!manufacturer || !material) return setStatus("Hersteller und Material eingeben.", "err");
    setStatus("Material wird gemerkt …");
    try {
      const data = await api("/admin/api/paint/returns/material", { method: "POST", body: JSON.stringify({ ean: currentEan, manufacturer, material, size }) });
      await loadMaterials();
      showMaterial(data.material, currentEan);
    } catch (error) { setStatus(error.message, "err"); }
  };

  function formatWeight(value) {
    return new Intl.NumberFormat("de-AT", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(value || 0)) + " kg";
  }
  function ageText(days) {
    const d = Number(days);
    if (!Number.isFinite(d)) return "";
    if (d <= 0) return "heute";
    if (d === 1) return "1 Tag alt";
    return `${d} Tage alt`;
  }

  function renderReturns(items) {
    returns = Array.isArray(items) ? items : [];
    el("returnCount").textContent = String(returns.length);
    const colours = [...new Set(returns.map((row) => row.colour).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
    el("returnColourList").innerHTML = colours.map((value) => `<option value="${esc(value)}"></option>`).join("");
    if (!returns.length) {
      el("returnResults").innerHTML = `<div class="return-empty">Keine passende Rückware.</div>`;
      return;
    }
    el("returnResults").innerHTML = returns.map((row) => {
      const material = [row.manufacturer, row.material, row.size].filter(Boolean).join(" · ");
      const projectText = row.jobId === "__lager__" ? "Lager" : [row.jobId, row.jobName].filter(Boolean).join(" · ");
      return `<div class="return-row"><div class="return-no">${esc(row.returnNo)}</div><div class="return-main"><b>${esc(row.colour)}</b><div class="return-sub">${esc(material)}${projectText ? "<br>von " + esc(projectText) : ""}</div></div><div class="return-side"><div>${esc(formatWeight(row.weightKg))}</div><div class="return-age">${esc(ageText(row.ageDays))}</div></div></div>`;
    }).join("");
  }

  async function loadReturns(query) {
    try {
      const data = await api("/admin/api/paint/returns?q=" + encodeURIComponent(query || ""));
      renderReturns(data.items);
    } catch (error) { el("returnResults").innerHTML = `<div class="return-empty">${esc(error.message)}</div>`; }
  }

  el("returnSearch").oninput = (event) => {
    clearTimeout(searchTimer);
    const value = event.target.value;
    searchTimer = setTimeout(() => loadReturns(value), 130);
  };

  el("returnBookBtn").onclick = async () => {
    if (!currentMaterial || !currentEan) return setStatus("Zuerst Dose scannen.", "err");
    if (!project) {
      setStatus("Bitte einmal Baustelle wählen – sie bleibt danach stehen.", "err");
      el("returnProjectBtn").click();
      return;
    }
    const colour = el("returnColour").value.trim();
    const weightKg = Number(String(el("returnWeight").value || "").replace(",", "."));
    if (!colour) return setStatus("Farbnummer/Farbton fehlt.", "err");
    if (!Number.isFinite(weightKg) || weightKg <= 0) return setStatus("Gewicht in kg fehlt.", "err");
    el("returnBookBtn").disabled = true;
    setStatus("Rückware wird gebucht …");
    try {
      const data = await api("/admin/api/paint/returns", {
        method: "POST",
        body: JSON.stringify({
          ean: currentEan,
          colour,
          weightKg,
          jobId: project.id,
          jobName: project.name,
        }),
      });
      const no = data.item?.returnNo;
      setStatus(`${no} gebucht ✓ · Etikett ${no} / ${data.printJob?.small || "heute"} liegt in der Druckwarteschlange.`, "ok");
      resetMaterial();
      await loadReturns(el("returnSearch").value || "");
      setTimeout(() => el("returnCameraBtn").focus(), 80);
    } catch (error) { setStatus(error.message, "err"); }
    finally { el("returnBookBtn").disabled = false; }
  };

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src; script.async = true;
      script.onload = resolve;
      script.onerror = () => { script.remove(); reject(new Error("Scanner-Bibliothek konnte nicht geladen werden")); };
      document.head.appendChild(script);
    });
  }

  async function ensureScannerLibrary() {
    if (window.Html5Qrcode) return;
    for (const src of [
      "https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js",
      "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js",
    ]) {
      try { await loadScript(src); if (window.Html5Qrcode) return; } catch {}
    }
    throw new Error("Scanner konnte nicht geladen werden");
  }

  async function stopScanner() {
    scannerLocked = false;
    try { if (scanner?.isScanning) await scanner.stop(); } catch {}
    try { await scanner?.clear?.(); } catch {}
    scanner = null;
    cameraModal.hidden = true;
  }

  async function startScanner() {
    cameraModal.hidden = false;
    scannerLocked = false;
    setStatus("Kamera startet …");
    try {
      await ensureScannerLibrary();
      scanner = new window.Html5Qrcode("returnCameraReader");
      const config = { fps: 12, qrbox: { width: 280, height: 150 }, aspectRatio: 1.5 };
      const onCode = async (decoded) => {
        if (scannerLocked) return;
        const code = String(decoded || "").replace(/\D/g, "");
        if (code.length < 6 || code.length > 18) return;
        scannerLocked = true;
        try { navigator.vibrate?.(70); } catch {}
        await stopScanner();
        lookupEan(code);
      };
      try { await scanner.start({ facingMode: "environment" }, config, onCode, () => {}); }
      catch { await scanner.start({ facingMode: { exact: "environment" } }, config, onCode, () => {}); }
      setStatus("Barcode ins Kamerabild halten …");
    } catch (error) {
      await stopScanner();
      setStatus("Kamera konnte nicht gestartet werden: " + (error.message || error), "err");
    }
  }

  el("returnCameraBtn").onclick = startScanner;
  el("returnCameraClose").onclick = stopScanner;
  cameraModal.addEventListener("click", (event) => { if (event.target === cameraModal) stopScanner(); });

  renderProject();
})();
