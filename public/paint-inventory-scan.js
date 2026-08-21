"use strict";
(function () {
  const qs = new URLSearchParams(location.search);
  const token = qs.get("token") || "";
  const SESSION_KEY = "kristine-lg-inventory-scan-session-v1";

  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const eanNorm = value => String(value ?? "").replace(/\D/g, "");
  const displaySize = value => String(value || "").replace("0.25 L", "0,25 L").replace("0.5 L", "0,5 L").replace("0.75 L", "0,75 L").replace("2.5 L", "2,5 L");

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

  function readSession() {
    try {
      const value = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      if (value && Array.isArray(value.counted)) return value;
    } catch {}
    return { startedAt: new Date().toISOString(), counted: [] };
  }

  function writeSession(session) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch {}
  }

  function ensureStyle() {
    if (document.getElementById("inventoryScanStyle")) return;
    const style = document.createElement("style");
    style.id = "inventoryScanStyle";
    style.textContent = `
      .inventory-scan-card{border:2px solid #d9e3dc!important;background:#fbfcfa!important}
      .inventory-scan-head{display:flex;gap:14px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;margin-bottom:12px}
      .inventory-scan-head h2{margin:0 0 3px;font-size:22px}.inventory-scan-counter{font-size:21px;font-weight:950;background:#e7efe9;border:1px solid #c9d9ce;border-radius:12px;padding:9px 13px;white-space:nowrap}
      .inventory-scan-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.inventory-scan-tools .field{max-width:240px}
      .inventory-camera-panel{margin:11px 0;border-radius:14px;overflow:hidden;background:#111;border:1px solid #202420}.inventory-camera-panel[hidden]{display:none!important}
      #inventoryCameraReader{width:100%;min-height:250px;background:#111}#inventoryCameraReader video{width:100%!important;height:auto!important;display:block}
      .inventory-count-box{margin-top:12px;border:1px solid #d7ddd8;border-radius:14px;background:#fff;overflow:hidden}.inventory-count-box[hidden]{display:none!important}
      .inventory-count-article{padding:14px 16px;background:#eef2ee;border-bottom:1px solid #dfe5df}.inventory-count-name{font-size:22px;font-weight:950;line-height:1.15}.inventory-count-sub{font-size:14px;color:#626b64;margin-top:4px}
      .inventory-count-values{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;padding:14px 16px}.inventory-count-value{border:1px solid #d7ddd8;border-radius:12px;padding:10px;text-align:center;background:#fafbf9}.inventory-count-value b{display:block;font-size:12px;color:#687169;margin-bottom:4px}.inventory-count-value strong{font-size:30px;line-height:1;font-weight:950}.inventory-count-value input{width:100%;min-height:54px;border:2px solid #76857a;border-radius:10px;font-size:28px;font-weight:950;text-align:center;background:#fff}
      .inventory-count-note{padding:0 16px 12px;color:#657067;font-size:12px}.inventory-count-note.zero{color:#8a6416;font-weight:800}.inventory-count-actions{display:flex;gap:8px;padding:0 16px 16px;flex-wrap:wrap}.inventory-count-actions .btn{min-height:48px;font-size:15px}.inventory-scan-status{font-size:13px;color:#626b64;margin-top:9px;white-space:pre-wrap}
      @media(max-width:760px){.inventory-scan-counter{width:100%;text-align:center}.inventory-scan-tools{display:grid;grid-template-columns:1fr;width:100%}.inventory-scan-tools .field,.inventory-scan-tools .btn{width:100%;max-width:none;min-height:52px;font-size:16px}.inventory-count-values{grid-template-columns:1fr 1fr}.inventory-count-value:nth-child(3){grid-column:1/-1}.inventory-count-name{font-size:24px}.inventory-count-value strong{font-size:34px}.inventory-count-value input{font-size:32px}.inventory-count-actions{display:grid;grid-template-columns:1fr}.inventory-count-actions .btn{width:100%;min-height:54px;font-size:17px}#inventoryCameraReader{min-height:220px}}
    `;
    document.head.appendChild(style);
  }

  let items = [];
  let byEan = new Map();
  let session = readSession();
  let current = null;
  let scanner = null;
  let starting = false;
  let locked = false;

  function countedSet() { return new Set((session.counted || []).map(String)); }
  function targetItems() { return items.filter(item => Number(item.targetStock || 0) > 0); }
  function progress() {
    const eligible = new Set(targetItems().map(item => String(item.id)));
    const done = [...countedSet()].filter(id => eligible.has(id)).length;
    return { done, total: eligible.size };
  }

  function renderCounter() {
    const el = document.getElementById("inventoryScanCounter");
    if (!el) return;
    const p = progress();
    el.textContent = `${p.done} / ${p.total} gezählt`;
  }

  function setStatus(text) {
    const el = document.getElementById("inventoryScanStatus");
    if (el) el.textContent = text || "";
  }

  function updateDifference() {
    if (!current) return;
    const input = document.getElementById("inventoryActualStock");
    const diff = document.getElementById("inventoryCountDiff");
    if (!input || !diff) return;
    const actual = Math.max(0, Number(input.value || 0));
    const target = Math.max(0, Number(current.targetStock || 0));
    const value = actual - target;
    diff.textContent = value > 0 ? `+${value}` : String(value);
  }

  function renderCurrent(item) {
    current = item;
    const box = document.getElementById("inventoryCountBox");
    const article = document.getElementById("inventoryCountArticle");
    const target = document.getElementById("inventoryCountTarget");
    const actual = document.getElementById("inventoryActualStock");
    const note = document.getElementById("inventoryCountNote");
    if (!box || !article || !target || !actual || !note) return;

    const already = countedSet().has(String(item.id));
    const targetValue = Math.max(0, Number(item.targetStock || 0));
    const defaultActual = already ? Math.max(0, Number(item.stock || 0)) : targetValue;
    const base = [item.baseCode && item.baseName && String(item.baseCode).toLowerCase() !== String(item.baseName).toLowerCase() ? `${item.baseCode} · ${item.baseName}` : (item.baseName || item.baseCode), displaySize(item.size)].filter(Boolean).join(" · ");

    article.innerHTML = `<div class="inventory-count-name">${esc(item.product || "LG Artikel")}</div><div class="inventory-count-sub">${esc(base)}${item.stockCode ? ` · ${esc(item.stockCode)}` : ""}</div>`;
    target.textContent = String(targetValue);
    actual.value = String(defaultActual);
    note.classList.toggle("zero", targetValue === 0);
    if (targetValue === 0) note.textContent = "Soll = 0 · dieser Artikel zählt bewusst NICHT zum Inventur-Zähler. Ein Ist-Stand kann trotzdem gespeichert werden.";
    else if (already) note.textContent = "Diese Position wurde in dieser Inventur schon gezählt. Du kannst den Ist-Stand hier korrigieren; der Zähler erhöht sich nicht nochmals.";
    else note.textContent = "Ist ist mit dem Sollstand vorbelegt: passt der gezählte Bestand, nur bestätigen. Sonst Zahl ändern.";
    box.hidden = false;
    updateDifference();
    setTimeout(() => actual.focus(), 30);
  }

  function clearCurrent() {
    current = null;
    const box = document.getElementById("inventoryCountBox");
    const manual = document.getElementById("inventoryScanEan");
    if (box) box.hidden = true;
    if (manual) manual.value = "";
  }

  function findByEan(value) {
    return byEan.get(eanNorm(value)) || null;
  }

  async function acceptEan(value) {
    const code = eanNorm(value);
    if (code.length < 8 || code.length > 14) return;
    const item = findByEan(code);
    if (!item) {
      setStatus(`EAN ${code} ist keinem Inventurartikel zugeordnet.`);
      locked = false;
      try { scanner?.resume?.(); } catch {}
      return;
    }
    locked = true;
    try { scanner?.pause?.(true); } catch {}
    setStatus("");
    renderCurrent(item);
    try { navigator.vibrate?.(70); } catch {}
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.dataset.lgInventoryCameraLib = "1";
      script.onload = resolve;
      script.onerror = () => { script.remove(); reject(new Error("Scanner-Bibliothek konnte nicht geladen werden")); };
      document.head.appendChild(script);
    });
  }

  async function loadScannerLibrary() {
    if (window.Html5Qrcode) return;
    const existing = document.querySelector("script[data-lg-camera-lib]");
    if (existing) {
      await new Promise(resolve => {
        if (window.Html5Qrcode) return resolve();
        existing.addEventListener("load", resolve, { once: true });
        setTimeout(resolve, 3500);
      });
      if (window.Html5Qrcode) return;
    }
    for (const src of ["https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js", "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"]) {
      try { await loadScript(src); if (window.Html5Qrcode) return; } catch {}
    }
    throw new Error("Scanner-Bibliothek konnte nicht geladen werden");
  }

  async function stopCamera(clear = false) {
    locked = false;
    try {
      if (scanner) {
        if (scanner.isScanning) await scanner.stop();
        try { await scanner.clear(); } catch {}
      }
    } catch {}
    scanner = null;
    const panel = document.getElementById("inventoryCameraPanel");
    const button = document.getElementById("inventoryCameraBtn");
    if (panel) panel.hidden = true;
    if (button) button.textContent = "📷 Inventur scannen";
    if (clear) setStatus("");
  }

  async function startCamera() {
    if (starting) return;
    if (scanner) { await stopCamera(false); return; }
    const button = document.getElementById("inventoryCameraBtn");
    const panel = document.getElementById("inventoryCameraPanel");
    if (!button || !panel) return;
    starting = true;
    button.disabled = true;
    setStatus("Rückkamera wird gestartet …");
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("Kamera ist in diesem Browser nicht verfügbar");
      await loadScannerLibrary();
      panel.hidden = false;
      const formats = window.Html5QrcodeSupportedFormats;
      const wanted = formats ? [formats.EAN_13, formats.EAN_8, formats.UPC_A, formats.UPC_E, formats.CODE_128].filter(v => v !== undefined) : undefined;
      scanner = new window.Html5Qrcode("inventoryCameraReader", wanted?.length ? { formatsToSupport: wanted, verbose: false } : { verbose: false });
      button.textContent = "✕ Scanner schließen";
      await scanner.start(
        { facingMode: "environment" },
        { fps: 12, qrbox: { width: 300, height: 150 }, aspectRatio: 1.777778, disableFlip: true },
        decoded => { if (!locked) acceptEan(decoded); },
        () => {}
      );
      setStatus("Scanner läuft · Dose scannen → Soll prüfen → Ist bestätigen.");
    } catch (error) {
      await stopCamera(false);
      setStatus(String(error?.message || error || "Kamera konnte nicht geöffnet werden"));
    } finally {
      starting = false;
      button.disabled = false;
    }
  }

  function syncInventoryList(item, actual) {
    const row = [...document.querySelectorAll("[data-inv-row]")].find(el => String(el.dataset.id || "") === String(item.id || ""));
    if (!row) return;
    row.dataset.stock = String(actual);
    const input = row.querySelector(".inventory-ist");
    if (input) { input.value = ""; input.placeholder = String(actual); }
  }

  async function saveCurrent() {
    if (!current) return;
    const input = document.getElementById("inventoryActualStock");
    const save = document.getElementById("inventoryCountConfirm");
    if (!input || !save) return;
    const actual = Number(input.value);
    if (!Number.isFinite(actual) || actual < 0) { setStatus("Bitte einen gültigen Ist-Stand eingeben."); input.focus(); return; }

    save.disabled = true;
    const item = current;
    const wasCounted = countedSet().has(String(item.id));
    try {
      await api("/admin/api/paint/inventory/count", {
        method: "POST",
        body: JSON.stringify({ rows: [{ articleId: item.id, stock: actual }], user: "Inventur Scan" }),
      });
      item.stock = actual;
      syncInventoryList(item, actual);
      if (Number(item.targetStock || 0) > 0 && !wasCounted) {
        session.counted = [...countedSet(), String(item.id)];
        writeSession(session);
      }
      renderCounter();
      const p = progress();
      setStatus(`Gespeichert: ${item.product} · Ist ${actual}. ${p.done} / ${p.total} gezählt.`);
      clearCurrent();
      locked = false;
      try { scanner?.resume?.(); } catch {}
      if (!scanner) document.getElementById("inventoryScanEan")?.focus();
    } catch (error) {
      setStatus(String(error?.message || error));
      input.focus();
    } finally {
      save.disabled = false;
    }
  }

  function resetSession() {
    if (!confirm("Inventur-Zähler wirklich auf 0 zurücksetzen? Bereits gespeicherte Ist-Bestände bleiben erhalten.")) return;
    session = { startedAt: new Date().toISOString(), counted: [] };
    writeSession(session);
    renderCounter();
    setStatus("Inventur-Zähler neu gestartet. Soll = 0 bleibt vom Zähler ausgeschlossen.");
  }

  async function loadItems() {
    try {
      const data = await api("/admin/api/paint/inventory");
      items = (Array.isArray(data.items) ? data.items : []).filter(item => item && item.id);
      byEan = new Map(items.filter(item => eanNorm(item.ean)).map(item => [eanNorm(item.ean), item]));
      renderCounter();
      const p = progress();
      setStatus(`${p.total} Positionen mit Soll > 0. Soll = 0 wird nicht mitgezählt.`);
    } catch (error) {
      setStatus(String(error?.message || error));
    }
  }

  function install() {
    const section = document.getElementById("tab-inventory");
    if (!section || document.getElementById("inventoryScanCard")) return false;
    ensureStyle();
    const card = document.createElement("div");
    card.id = "inventoryScanCard";
    card.className = "card inventory-scan-card";
    card.innerHTML = `
      <div class="inventory-scan-head">
        <div><h2>Inventur scannen</h2><div class="muted">Dose scannen → Artikel + Sollstand → Ist bestätigen oder ändern → nächster Scan</div></div>
        <div id="inventoryScanCounter" class="inventory-scan-counter">0 / 0 gezählt</div>
      </div>
      <div class="inventory-scan-tools">
        <button id="inventoryCameraBtn" class="btn primary" type="button">📷 Inventur scannen</button>
        <input id="inventoryScanEan" class="field" inputmode="numeric" autocomplete="off" placeholder="EAN manuell / Handscanner …">
        <button id="inventoryScanReset" class="btn" type="button">Zähler neu starten</button>
      </div>
      <div id="inventoryCameraPanel" class="inventory-camera-panel" hidden><div id="inventoryCameraReader"></div></div>
      <div id="inventoryCountBox" class="inventory-count-box" hidden>
        <div id="inventoryCountArticle" class="inventory-count-article"></div>
        <div class="inventory-count-values">
          <div class="inventory-count-value"><b>Soll</b><strong id="inventoryCountTarget">0</strong></div>
          <div class="inventory-count-value"><b>Ist</b><input id="inventoryActualStock" type="number" min="0" step="1" inputmode="numeric" value="0"></div>
          <div class="inventory-count-value"><b>Soll–Ist</b><strong id="inventoryCountDiff">0</strong></div>
        </div>
        <div id="inventoryCountNote" class="inventory-count-note"></div>
        <div class="inventory-count-actions"><button id="inventoryCountConfirm" class="btn primary" type="button">Ist bestätigen → nächster Scan</button><button id="inventoryCountCancel" class="btn" type="button">Abbrechen</button></div>
      </div>
      <div id="inventoryScanStatus" class="inventory-scan-status"></div>`;
    section.insertBefore(card, section.firstChild);

    const manual = document.getElementById("inventoryScanEan");
    let timer = null;
    manual?.addEventListener("input", event => {
      clearTimeout(timer);
      const value = eanNorm(event.target.value);
      if (value.length >= 8) timer = setTimeout(() => acceptEan(value), 100);
    });
    manual?.addEventListener("keydown", event => { if (event.key === "Enter") acceptEan(event.target.value); });
    document.getElementById("inventoryActualStock")?.addEventListener("input", updateDifference);
    document.getElementById("inventoryActualStock")?.addEventListener("keydown", event => { if (event.key === "Enter") saveCurrent(); });
    document.getElementById("inventoryCameraBtn")?.addEventListener("click", startCamera);
    document.getElementById("inventoryCountConfirm")?.addEventListener("click", saveCurrent);
    document.getElementById("inventoryCountCancel")?.addEventListener("click", () => { clearCurrent(); locked = false; try { scanner?.resume?.(); } catch {} });
    document.getElementById("inventoryScanReset")?.addEventListener("click", resetSession);

    document.querySelectorAll("[data-tab]").forEach(tab => tab.addEventListener("click", () => {
      if (tab.dataset.tab === "inventory") loadItems();
      else if (scanner) stopCamera(false);
    }));

    loadItems();
    return true;
  }

  if (!install()) {
    const observer = new MutationObserver(() => { if (install()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  window.addEventListener("pagehide", () => { if (scanner) stopCamera(false); });
})();
