"use strict";
(function () {
  const qs = new URLSearchParams(location.search);
  const token = qs.get("token") || "";
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function api(url, opt = {}) {
    const join = url.includes("?") ? "&" : "?";
    const response = await fetch(url + (token ? join + "token=" + encodeURIComponent(token) : ""), {
      ...opt,
      headers: { "Content-Type": "application/json", ...(opt.headers || {}) },
    });
    const data = await response.json().catch(() => ({ ok: false, error: "Keine JSON-Antwort" }));
    if (!response.ok || data.ok === false) throw new Error(data.error || ("HTTP " + response.status));
    return data;
  }

  function ensureStyle() {
    if (document.getElementById("paintOutflowStyle")) return;
    const style = document.createElement("style");
    style.id = "paintOutflowStyle";
    style.textContent = `
      .outflow-field{margin-top:10px}.outflow-field label{display:block;font-size:12px;font-weight:800;color:#687169;margin:0 0 5px}
      .manual-out-card{border:1px solid #d8ded9;background:#fbfcfa}.manual-out-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.manual-out-head h2{margin:0}.manual-out-body[hidden]{display:none!important}
      .manual-out-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}.manual-out-grid .field{min-width:0}.manual-out-project[hidden]{display:none!important}.manual-out-project{margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .manual-out-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}.manual-out-actions .field{max-width:120px}.manual-out-status{font-size:13px;color:#626b64;margin-top:9px;white-space:pre-wrap}
      @media(max-width:750px){.manual-out-grid,.manual-out-project{grid-template-columns:1fr}.manual-out-actions{display:grid;grid-template-columns:110px 1fr}.manual-out-actions .field{max-width:none}.manual-out-actions .btn{min-height:52px}.manual-out-head .btn{width:100%;min-height:50px}}
    `;
    document.head.appendChild(style);
  }

  function initScanEnhancement() {
    const scanAction = document.getElementById("scanAction");
    const projectWrap = document.getElementById("projectWrap");
    const saleBtn = document.getElementById("saleBtn");
    const projectBtn = document.getElementById("projectBtn");
    const job = document.getElementById("job");
    const bookOut = document.getElementById("bookOut");
    const qty = document.getElementById("qty");
    const ean = document.getElementById("ean");
    const moveStatus = document.getElementById("moveStatus");
    if (!scanAction || !projectWrap || !saleBtn || !projectBtn || !job || !bookOut || !qty || !ean || !moveStatus) return;
    if (document.getElementById("scanColourTone")) return;

    const toneWrap = document.createElement("div");
    toneWrap.id = "scanColourToneWrap";
    toneWrap.className = "outflow-field hidden";
    toneWrap.innerHTML = '<label for="scanColourTone">Farbton</label><input id="scanColourTone" class="field" placeholder="z. B. Slaked Lime 105" autocomplete="off">';
    projectWrap.insertBefore(toneWrap, job);
    const tone = document.getElementById("scanColourTone");

    let mode = "sale";
    const originalSale = saleBtn.onclick;
    const originalProject = projectBtn.onclick;

    function setMode(next) {
      mode = next;
      const isProject = mode === "project";
      toneWrap.classList.toggle("hidden", !isProject);
      if (!isProject) tone.value = "";
    }

    saleBtn.onclick = async event => {
      setMode("sale");
      if (typeof originalSale === "function") return originalSale.call(saleBtn, event);
    };

    projectBtn.onclick = async event => {
      setMode("project");
      try {
        if (typeof originalProject === "function") await originalProject.call(projectBtn, event);
        setTimeout(() => tone.focus(), 30);
      } catch (error) {
        moveStatus.textContent = String(error?.message || error);
      }
    };

    bookOut.onclick = async () => {
      const code = String(ean.value || "").replace(/\D/g, "");
      if (code.length < 8) { moveStatus.textContent = "Bitte zuerst eine Dose scannen."; ean.focus(); return; }
      if (mode === "project" && !String(tone.value || "").trim()) { moveStatus.textContent = "Bitte Farbton eingeben."; tone.focus(); return; }
      if (mode === "project" && !String(job.value || "").trim()) { moveStatus.textContent = "Bitte Baustelle wählen."; job.focus(); return; }

      bookOut.disabled = true;
      try {
        const scanned = await api("/admin/api/paint/scan?ean=" + encodeURIComponent(code));
        const data = await api("/admin/api/paint/outflow/book", {
          method: "POST",
          body: JSON.stringify({
            articleId: scanned.article.id,
            quantity: Number(qty.value || 1),
            reason: mode,
            jobId: mode === "project" ? job.value : "",
            colourTone: mode === "project" ? tone.value.trim() : "",
            source: "scan",
            user: "Farben Scan",
          }),
        });
        const article = data.article;
        document.getElementById("scanArticle").innerHTML = `<b>${esc(article.product)}</b><br>${esc(article.baseName || article.baseCode)} · ${esc(article.size)}<div class="bigstock">Bestand: ${article.stock}</div>`;
        const suffix = mode === "project" ? ` · ${job.value} · ${tone.value.trim()}` : " · Verkauf";
        moveStatus.textContent = `Gebucht: ${data.movement.before} → ${data.movement.after}${suffix}`;
        ean.value = "";
        qty.value = "1";
        if (mode === "project") tone.value = "";
        document.dispatchEvent(new CustomEvent("kristine:paint-stock-changed", { detail: data }));
        setTimeout(() => ean.focus(), 50);
      } catch (error) {
        moveStatus.textContent = String(error?.message || error);
      } finally {
        bookOut.disabled = false;
      }
    };
  }

  function initManualOutflow() {
    const tab = document.getElementById("tab-scan");
    if (!tab || document.getElementById("manualOutCard")) return;
    const grid = tab.querySelector(".grid2");
    if (!grid) return;

    const card = document.createElement("div");
    card.id = "manualOutCard";
    card.className = "card manual-out-card";
    card.innerHTML = `
      <div class="manual-out-head"><div><h2>Ohne Scan ausbuchen</h2><div class="muted">Vergessen zu scannen? Material nachträglich sauber buchen.</div></div><button id="manualOutToggle" class="btn" type="button">Händisch buchen</button></div>
      <div id="manualOutBody" class="manual-out-body" hidden>
        <div class="manual-out-grid">
          <div><label>Material</label><select id="manualOutProduct" class="field"></select></div>
          <div><label>Gebinde</label><select id="manualOutArticle" class="field"></select></div>
        </div>
        <div class="choice"><button id="manualSaleBtn" class="btn primary" type="button">Verkauf</button><button id="manualProjectBtn" class="btn" type="button">Baustelle</button></div>
        <div id="manualOutProject" class="manual-out-project" hidden>
          <div><label>Farbton</label><input id="manualOutTone" class="field" placeholder="z. B. Slaked Lime 105" autocomplete="off"></div>
          <div><label>Baustelle</label><select id="manualOutJob" class="field"></select></div>
        </div>
        <div class="manual-out-actions"><input id="manualOutQty" class="field" type="number" min="1" step="1" value="1"><button id="manualOutBook" class="btn primary" type="button">Abgang buchen</button></div>
        <div id="manualOutStatus" class="manual-out-status"></div>
      </div>`;
    grid.insertAdjacentElement("afterend", card);

    const toggle = document.getElementById("manualOutToggle");
    const body = document.getElementById("manualOutBody");
    const product = document.getElementById("manualOutProduct");
    const article = document.getElementById("manualOutArticle");
    const sale = document.getElementById("manualSaleBtn");
    const project = document.getElementById("manualProjectBtn");
    const projectBox = document.getElementById("manualOutProject");
    const tone = document.getElementById("manualOutTone");
    const job = document.getElementById("manualOutJob");
    const qty = document.getElementById("manualOutQty");
    const book = document.getElementById("manualOutBook");
    const status = document.getElementById("manualOutStatus");

    let items = [];
    let mode = "sale";
    let loaded = false;
    let jobsLoaded = false;

    function setStatus(text) { status.textContent = text || ""; }

    function selectedItem() {
      return items.find(row => String(row.id) === String(article.value)) || null;
    }

    function renderArticles() {
      const list = items.filter(row => String(row.product || "") === String(product.value || ""));
      article.innerHTML = list.map(row => {
        const base = row.baseName || row.baseCode || "";
        return `<option value="${esc(row.id)}">${esc(base)} · ${esc(row.size)} · Bestand ${Number(row.stock || 0)}</option>`;
      }).join("");
    }

    function renderProducts() {
      const names = [];
      const seen = new Set();
      for (const row of items) {
        const name = String(row.product || "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name); names.push(name);
      }
      product.innerHTML = names.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
      renderArticles();
    }

    async function loadItems() {
      const data = await api("/admin/api/paint/inventory");
      items = Array.isArray(data.items) ? data.items : [];
      renderProducts();
      loaded = true;
    }

    async function loadJobs() {
      if (jobsLoaded && job.options.length) return;
      const data = await api("/admin/api/paint/jobs");
      job.innerHTML = (data.jobs || []).map(row => `<option value="${esc(row.id)}">${esc(row.id)} · ${esc(row.name)}</option>`).join("");
      jobsLoaded = true;
    }

    function setMode(next) {
      mode = next;
      const isProject = mode === "project";
      sale.classList.toggle("primary", !isProject);
      project.classList.toggle("primary", isProject);
      projectBox.hidden = !isProject;
      if (!isProject) tone.value = "";
    }

    toggle.onclick = async () => {
      body.hidden = !body.hidden;
      toggle.textContent = body.hidden ? "Händisch buchen" : "Schließen";
      if (!body.hidden && !loaded) {
        setStatus("Material wird geladen …");
        try { await loadItems(); setStatus(""); } catch (error) { setStatus(String(error?.message || error)); }
      }
    };

    product.onchange = renderArticles;
    sale.onclick = () => setMode("sale");
    project.onclick = async () => {
      setMode("project");
      try { await loadJobs(); setTimeout(() => tone.focus(), 30); } catch (error) { setStatus(String(error?.message || error)); }
    };

    book.onclick = async () => {
      const row = selectedItem();
      if (!row) { setStatus("Bitte Material und Gebinde wählen."); return; }
      if (mode === "project" && !String(tone.value || "").trim()) { setStatus("Bitte Farbton eingeben."); tone.focus(); return; }
      if (mode === "project" && !String(job.value || "").trim()) { setStatus("Bitte Baustelle wählen."); job.focus(); return; }

      book.disabled = true;
      try {
        const data = await api("/admin/api/paint/outflow/book", {
          method: "POST",
          body: JSON.stringify({
            articleId: row.id,
            quantity: Number(qty.value || 1),
            reason: mode,
            jobId: mode === "project" ? job.value : "",
            colourTone: mode === "project" ? tone.value.trim() : "",
            source: "manual",
            user: "Farben manuell",
          }),
        });
        row.stock = data.article.stock;
        renderArticles();
        const suffix = mode === "project" ? ` · ${job.value} · ${tone.value.trim()}` : " · Verkauf";
        setStatus(`Gebucht: ${row.product} · ${row.baseName || row.baseCode} · ${row.size} · ${data.movement.before} → ${data.movement.after}${suffix}`);
        qty.value = "1";
        if (mode === "project") tone.value = "";
        document.dispatchEvent(new CustomEvent("kristine:paint-stock-changed", { detail: data }));
      } catch (error) {
        setStatus(String(error?.message || error));
      } finally {
        book.disabled = false;
      }
    };

    document.addEventListener("kristine:paint-stock-changed", event => {
      const changed = event.detail?.article;
      if (!changed || !loaded) return;
      const row = items.find(item => String(item.id) === String(changed.id));
      if (row) { row.stock = Number(changed.stock || 0); renderArticles(); }
    });
  }

  ensureStyle();
  initScanEnhancement();
  initManualOutflow();
})();
