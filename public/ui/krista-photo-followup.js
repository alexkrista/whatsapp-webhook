"use strict";

(function () {
  const STORAGE_KEY = "krista-photo-followup-recent-jobs";
  const state = { jobs: [], selectedJobId: "", files: [], options: {}, busy: false };
  let dialog;

  function esc(value) {
    return String(value ?? "").replace(/[&<>\"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char]);
  }

  function tokenUrl(path) {
    const token = new URLSearchParams(location.search).get("token");
    if (!token) return path;
    const url = new URL(path, location.origin);
    url.searchParams.set("token", token);
    return url.pathname + url.search;
  }

  function fullAddress(job) {
    return [job.street, job.houseNumber, [job.postalCode, job.city].filter(Boolean).join(" ")]
      .filter(Boolean).join(", ");
  }

  function searchText(job) {
    return [job.jobId, job.name, job.customerName, fullAddress(job), job.status].join(" ").toLocaleLowerCase("de");
  }

  function recentIds() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch { return []; }
  }

  function remember(jobId) {
    const ids = [String(jobId), ...recentIds().filter(id => String(id) !== String(jobId))].slice(0, 10);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  }

  function jobDate(job) {
    const value = job.updatedAt || job.latestDay || job.createdAt || job.startDate || "";
    const time = Date.parse(String(value));
    return Number.isFinite(time) ? time : 0;
  }

  function sortedJobs() {
    const recent = recentIds();
    return [...state.jobs].sort((a, b) => {
      const ai = recent.indexOf(String(a.jobId));
      const bi = recent.indexOf(String(b.jobId));
      if (ai >= 0 || bi >= 0) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
      return jobDate(b) - jobDate(a) || String(b.jobId).localeCompare(String(a.jobId), "de", { numeric: true });
    });
  }

  function setMessage(text, kind = "") {
    const el = dialog?.querySelector("[data-kpf-message]");
    if (!el) return;
    el.textContent = text || "";
    el.className = `kpf-message ${kind}`;
  }

  function renderJobs() {
    const list = dialog.querySelector("[data-kpf-jobs]");
    const input = dialog.querySelector("[data-kpf-search]");
    const query = input.value.trim().toLocaleLowerCase("de");
    const all = sortedJobs();
    const rows = (query ? all.filter(job => searchText(job).includes(query)) : all.slice(0, 10)).slice(0, query ? 80 : 10);
    dialog.querySelector("[data-kpf-job-heading]").textContent = query ? `${rows.length} Treffer` : "Zuletzt verwendet / bearbeitet";
    if (!rows.length) {
      list.innerHTML = '<div class="kpf-empty">Keine Baustelle gefunden. Bitte Nummer, Name oder Adresse prüfen.</div>';
      return;
    }
    list.innerHTML = rows.map(job => {
      const selected = String(job.jobId) === String(state.selectedJobId);
      const address = fullAddress(job);
      return `<button type="button" class="kpf-job ${selected ? "selected" : ""}" data-kpf-job="${esc(job.jobId)}">
        <span class="kpf-job-main"><strong>${esc(job.jobId)} · ${esc(job.name || "Ohne Bezeichnung")}</strong><small>${esc(address || job.customerName || "Keine Adresse hinterlegt")}</small></span>
        <span class="kpf-status">${esc(job.status || "ohne Status")}</span>
        <span class="kpf-check">${selected ? "✓ Gewählt" : "Wählen"}</span>
      </button>`;
    }).join("");
    list.querySelectorAll("[data-kpf-job]").forEach(button => button.addEventListener("click", () => {
      state.selectedJobId = button.dataset.kpfJob;
      renderJobs();
      renderSelected();
    }));
  }

  function renderSelected() {
    const job = state.jobs.find(item => String(item.jobId) === String(state.selectedJobId));
    const el = dialog.querySelector("[data-kpf-selected]");
    el.innerHTML = job
      ? `<strong>Baustelle ${esc(job.jobId)}</strong><span>${esc(job.name || "Ohne Bezeichnung")}</span><small>${esc(job.status || "ohne Status")} · Der Baustellenstatus bleibt unverändert.</small>`
      : "<strong>Noch keine Baustelle gewählt</strong><span>Oben suchen und auswählen.</span>";
  }

  function renderFiles() {
    const list = dialog.querySelector("[data-kpf-files]");
    const submit = dialog.querySelector("[data-kpf-upload]");
    submit.disabled = state.busy || !state.selectedJobId || !state.files.length;
    submit.textContent = state.busy ? "Fotos werden gespeichert …" : `${state.files.length || ""} Foto${state.files.length === 1 ? "" : "s"} speichern`.trim();
    if (!state.files.length) {
      list.innerHTML = '<div class="kpf-file-empty">Noch keine Fotos gewählt.</div>';
      return;
    }
    list.innerHTML = state.files.map((file, index) => `<div class="kpf-file">
      <img src="${esc(URL.createObjectURL(file))}" alt="Vorschau">
      <span><strong>${esc(file.name || `Foto ${index + 1}`)}</strong><small>${(file.size / 1024 / 1024).toLocaleString("de-AT", { maximumFractionDigits: 1 })} MB</small></span>
      <button type="button" data-kpf-remove="${index}" aria-label="Foto entfernen">×</button>
    </div>`).join("");
    list.querySelectorAll("[data-kpf-remove]").forEach(button => button.addEventListener("click", () => {
      state.files.splice(Number(button.dataset.kpfRemove), 1);
      renderFiles();
    }));
  }

  function addFiles(fileList) {
    const images = [...(fileList || [])].filter(file => String(file.type || "").startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || ""));
    const tooLarge = images.filter(file => file.size > 30 * 1024 * 1024);
    state.files.push(...images.filter(file => file.size <= 30 * 1024 * 1024));
    setMessage(tooLarge.length ? `${tooLarge.length} Foto(s) über 30 MB wurden ausgelassen.` : "");
    renderFiles();
  }

  async function loadJobs() {
    setMessage("Baustellen werden geladen …");
    try {
      const response = await fetch(tokenUrl("/admin/api/jobs"));
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Baustellen konnten nicht geladen werden.");
      state.jobs = (Array.isArray(body.jobs) ? body.jobs : []).filter(job => {
        const id = String(job?.jobId || "");
        return id && !id.startsWith("_") && id !== "unknown";
      });
      if (state.options.defaultJobId && state.jobs.some(job => String(job.jobId) === String(state.options.defaultJobId))) {
        state.selectedJobId = String(state.options.defaultJobId);
      }
      renderJobs();
      renderSelected();
      renderFiles();
      setMessage(`${state.jobs.length} Baustellen verfügbar – auch geschlossene und archivierte.`);
    } catch (error) {
      setMessage(error.message, "error");
    }
  }

  async function upload() {
    if (state.busy || !state.selectedJobId || !state.files.length) return;
    state.busy = true;
    renderFiles();
    const caption = dialog.querySelector("[data-kpf-caption]").value.trim();
    let uploaded = 0;
    try {
      for (const file of state.files) {
        setMessage(`Foto ${uploaded + 1} von ${state.files.length} wird gespeichert …`);
        const response = await fetch(tokenUrl(`/admin/api/job/${encodeURIComponent(state.selectedJobId)}/media`), {
          method: "POST",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "X-File-Name": encodeURIComponent(file.name || `Foto-${uploaded + 1}.jpg`),
            "X-Employee-Id": encodeURIComponent(state.options.uploaderId || "office"),
            "X-Employee-Name": encodeURIComponent(state.options.uploaderName || "Büro"),
            "X-Photo-Caption": encodeURIComponent(caption),
            "X-Photo-Source": encodeURIComponent(state.options.source || "Foto-Nachreichung"),
          },
          body: file,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `${file.name} konnte nicht gespeichert werden.`);
        uploaded++;
      }
      remember(state.selectedJobId);
      const count = uploaded;
      state.files = [];
      dialog.querySelector("[data-kpf-caption]").value = "";
      setMessage(`✓ ${count} Foto${count === 1 ? "" : "s"} in der Baustelle gespeichert.`, "success");
      renderFiles();
      if (typeof state.options.onUploaded === "function") state.options.onUploaded({ count, jobId: state.selectedJobId });
      if (window.BaustellenFotoGallery?.reload) window.BaustellenFotoGallery.reload();
    } catch (error) {
      setMessage(`${uploaded ? `${uploaded} Foto(s) gespeichert. ` : ""}${error.message}`, "error");
    } finally {
      state.busy = false;
      renderFiles();
    }
  }

  function install() {
    if (dialog) return;
    const style = document.createElement("style");
    style.textContent = `
      .kpf-dialog{border:0;padding:0;background:transparent;width:min(920px,calc(100vw - 24px));max-width:none;max-height:calc(100vh - 24px)}
      .kpf-dialog::backdrop{background:rgba(17,26,20,.68);backdrop-filter:blur(2px)}
      .kpf-card{background:#fffefa;color:#202520;border-radius:22px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.3);font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
      .kpf-head{display:flex;justify-content:space-between;align-items:flex-start;gap:15px;padding:21px 23px;background:#1d432d;color:#fff}.kpf-head h2{margin:0;font-size:24px}.kpf-head p{margin:5px 0 0;color:#d9e7dd;font-size:14px}.kpf-close{border:0;background:rgba(255,255,255,.13);color:#fff;font-size:25px;width:42px;height:42px;border-radius:12px;cursor:pointer}
      .kpf-body{padding:20px 23px;display:grid;gap:17px;max-height:calc(100vh - 132px);overflow:auto}.kpf-label{font-size:13px;font-weight:850;color:#4f594f;margin-bottom:7px;display:block}
      .kpf-search{width:100%;font:inherit;font-size:17px;padding:13px 14px;border:1px solid #c9ccc6;border-radius:12px;background:#fff}.kpf-list-head{display:flex;justify-content:space-between;margin:10px 1px 7px;font-size:13px;color:#677067}
      .kpf-jobs{display:grid;gap:7px;max-height:260px;overflow:auto}.kpf-job{width:100%;display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;align-items:center;border:1px solid #dddcd5;border-radius:12px;padding:11px 12px;background:#fff;text-align:left;color:#202520;cursor:pointer}.kpf-job:hover{border-color:#79a187}.kpf-job.selected{border:2px solid #34784b;background:#eff8f1}.kpf-job-main{min-width:0}.kpf-job-main strong,.kpf-job-main small{display:block}.kpf-job-main strong{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.kpf-job-main small{color:#6c736d;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.kpf-status{font-size:11px;font-weight:800;background:#eeeee9;border-radius:999px;padding:5px 8px}.kpf-check{font-size:12px;font-weight:900;color:#34784b}.kpf-empty{padding:20px;text-align:center;color:#707670;border:1px dashed #ccc;border-radius:12px}
      .kpf-selected{display:flex;gap:7px 13px;align-items:baseline;flex-wrap:wrap;padding:12px 14px;background:#edf5ee;border:1px solid #c9dfce;border-radius:12px}.kpf-selected span{font-weight:700}.kpf-selected small{color:#627064}
      .kpf-pick{display:grid;grid-template-columns:1fr 1fr;gap:10px}.kpf-pick label,.kpf-drop{display:flex;align-items:center;justify-content:center;gap:8px;min-height:52px;padding:12px;border-radius:12px;font-weight:850;cursor:pointer}.kpf-pick label{position:relative;background:#34784b;color:#fff}.kpf-pick label:last-child{background:#fff;color:#25412d;border:1px solid #8fa797}.kpf-pick input{position:absolute!important;width:1px!important;height:1px!important;inset:auto!important;opacity:0;overflow:hidden;pointer-events:none}.kpf-drop{grid-column:1/-1;border:2px dashed #aeb8af;background:#f8f8f4;color:#59635b}.kpf-drop.over{border-color:#34784b;background:#edf6ef}
      .kpf-files{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.kpf-file{display:grid;grid-template-columns:54px minmax(0,1fr) 28px;align-items:center;gap:8px;border:1px solid #deddd7;border-radius:11px;padding:6px;background:#fff}.kpf-file img{width:54px;height:48px;object-fit:cover;border-radius:7px}.kpf-file span{min-width:0}.kpf-file strong,.kpf-file small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.kpf-file small{color:#747974;margin-top:3px}.kpf-file button{border:0;background:transparent;font-size:21px;color:#97423e;cursor:pointer}.kpf-file-empty{grid-column:1/-1;color:#777;padding:8px 0}
      .kpf-caption{width:100%;font:inherit;padding:12px 13px;border:1px solid #c9ccc6;border-radius:11px;resize:vertical;min-height:48px}.kpf-foot{display:flex;justify-content:space-between;gap:12px;align-items:center;border-top:1px solid #e1dfd8;padding-top:15px}.kpf-message{font-size:13px;color:#687068}.kpf-message.success{color:#236638;font-weight:800}.kpf-message.error{color:#a23f39;font-weight:800}.kpf-actions{display:flex;gap:9px}.kpf-actions button{font:inherit;border-radius:11px;padding:11px 15px;border:1px solid #c9ccc6;background:#fff;font-weight:850;cursor:pointer}.kpf-actions [data-kpf-upload]{background:#34784b;color:#fff;border-color:#34784b}.kpf-actions [data-kpf-upload]:disabled{opacity:.45;cursor:not-allowed}
      .kpf-launch{font:inherit;border:1px solid #2f7d4a;border-radius:11px;padding:9px 12px;background:#2f7d4a;color:#fff;font-weight:800;cursor:pointer}.detail-actions .kpf-launch{font-size:12px;background:#2f7d4a;border-color:#69a47d;color:#fff}.krista-module-nav .kpf-launch{white-space:nowrap}
      @media(max-width:680px){.kpf-dialog{width:100vw;max-height:100vh}.kpf-card{border-radius:0;min-height:100vh}.kpf-body{max-height:calc(100vh - 92px);padding:15px}.kpf-head{padding:17px}.kpf-jobs{max-height:220px}.kpf-job{grid-template-columns:minmax(0,1fr) auto}.kpf-status{display:none}.kpf-pick{grid-template-columns:1fr}.kpf-drop{display:none}.kpf-files{grid-template-columns:1fr}.kpf-foot{align-items:stretch;flex-direction:column}.kpf-actions{display:grid;grid-template-columns:1fr 1fr}.kpf-actions button{width:100%}}
    `;
    document.head.appendChild(style);

    dialog = document.createElement("dialog");
    dialog.className = "kpf-dialog";
    dialog.innerHTML = `<div class="kpf-card">
      <header class="kpf-head"><div><h2>📸 Fotos nachreichen</h2><p>Auch für fertige, geschlossene und archivierte Baustellen.</p></div><button type="button" class="kpf-close" data-kpf-close aria-label="Schließen">×</button></header>
      <div class="kpf-body">
        <section><label class="kpf-label" for="kpfSearch">Baustelle suchen</label><input id="kpfSearch" class="kpf-search" data-kpf-search type="search" placeholder="Nummer, Name, Kunde oder Adresse …" autocomplete="off"><div class="kpf-list-head"><strong data-kpf-job-heading>Zuletzt verwendet / bearbeitet</strong><span>alle Status</span></div><div class="kpf-jobs" data-kpf-jobs></div></section>
        <div class="kpf-selected" data-kpf-selected></div>
        <section><span class="kpf-label">Fotos hinzufügen</span><div class="kpf-pick"><label>📷 Kamera öffnen<input data-kpf-camera type="file" accept="image/*" capture="environment" multiple></label><label>🖼 Fotos auswählen<input data-kpf-gallery type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple></label><div class="kpf-drop" data-kpf-drop>Fotos hierher ziehen oder aus der Zwischenablage einfügen</div></div><div class="kpf-files" data-kpf-files></div></section>
        <section><label class="kpf-label" for="kpfCaption">Notiz zu den Fotos (optional)</label><textarea id="kpfCaption" class="kpf-caption" data-kpf-caption placeholder="z. B. fertige Fassade Südseite"></textarea></section>
        <footer class="kpf-foot"><div class="kpf-message" data-kpf-message></div><div class="kpf-actions"><button type="button" data-kpf-close>Abbrechen</button><button type="button" data-kpf-upload disabled>Fotos speichern</button></div></footer>
      </div></div>`;
    document.body.appendChild(dialog);
    dialog.querySelectorAll("[data-kpf-close]").forEach(button => button.addEventListener("click", close));
    dialog.querySelector("[data-kpf-search]").addEventListener("input", renderJobs);
    dialog.querySelector("[data-kpf-camera]").addEventListener("change", event => { addFiles(event.target.files); event.target.value = ""; });
    dialog.querySelector("[data-kpf-gallery]").addEventListener("change", event => { addFiles(event.target.files); event.target.value = ""; });
    dialog.querySelector("[data-kpf-upload]").addEventListener("click", upload);
    const drop = dialog.querySelector("[data-kpf-drop]");
    ["dragenter", "dragover"].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", event => addFiles(event.dataTransfer.files));
    document.addEventListener("paste", event => {
      if (!dialog.open) return;
      const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === "file" && item.type.startsWith("image/")).map(item => item.getAsFile()).filter(Boolean);
      if (files.length) { event.preventDefault(); addFiles(files); }
    });
    dialog.addEventListener("click", event => { if (event.target === dialog) close(); });
  }

  function open(options = {}) {
    install();
    state.options = options;
    state.selectedJobId = String(options.defaultJobId || "");
    state.files = [];
    dialog.querySelector("[data-kpf-search]").value = "";
    dialog.querySelector("[data-kpf-caption]").value = "";
    renderFiles();
    if (!dialog.open) dialog.showModal();
    loadJobs().then(() => dialog.querySelector("[data-kpf-search]").focus());
  }

  function close() {
    if (state.busy) return;
    if (dialog?.open) dialog.close();
  }

  function addLauncher(container, text, defaultJob) {
    if (!container || container.querySelector("[data-kpf-launch]")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "kpf-launch";
    button.dataset.kpfLaunch = "1";
    button.textContent = text;
    button.addEventListener("click", () => open({ defaultJobId: typeof defaultJob === "function" ? defaultJob() : "", source: "KRISTINE", uploaderName: "Büro" }));
    container.appendChild(button);
  }

  function installPageLaunchers() {
    install();
    if (/\/kristine\/?$/.test(location.pathname)) addLauncher(document.querySelector(".krista-module-nav"), "📸 Foto nachreichen");
    if (/baustellen\.html$|\/kristine\/baustellen\/?$/.test(location.pathname)) {
      addLauncher(document.querySelector(".head-actions"), "📸 Foto nachreichen");
      addLauncher(document.querySelector(".detail-actions"), "📸 Foto nachreichen", () => decodeURIComponent(location.hash.slice(1)));
    }
  }

  window.KristaPhotoFollowup = { open, close, version: "2026.09.09.1" };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installPageLaunchers);
  else installPageLaunchers();
})();
