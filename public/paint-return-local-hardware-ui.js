"use strict";
(function () {
  if (window.__kristineReturnHardwareLoaded) return;
  window.__kristineReturnHardwareLoaded = true;

  const BRIDGE = "http://127.0.0.1:17831";
  const qs = new URLSearchParams(location.search);
  const token = qs.get("token") || "";
  const originalFetch = window.fetch.bind(window);
  const printedJobs = new Set();
  let weighing = false;
  let scanTimer = null;
  let bridgeStartRequestedAt = 0;

  const el = (id) => document.getElementById(id);
  const tokenized = (url) => url + (url.includes("?") ? "&" : "?") + (token ? "token=" + encodeURIComponent(token) : "").replace(/[?&]$/, "");

  async function localApi(path, options = {}) {
    const response = await originalFetch(BRIDGE + path, {
      ...options,
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({ ok: false, error: "Keine Antwort vom lokalen Hardware-Dienst" }));
    if (!response.ok || data.ok === false) throw new Error(data.error || `Hardware HTTP ${response.status}`);
    return data;
  }

  async function serverApi(path, options = {}) {
    const response = await originalFetch(tokenized(path), {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({ ok: false, error: "Keine JSON-Antwort" }));
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async function requireLabelFeatures() {
    const health = await localApi("/health");
    const parts = String(health.version || "").split(".").map(Number);
    if (parts[0] < 1 || (parts[0] === 1 && parts[1] < 5) || !Number.isFinite(parts[0]))
      throw new Error("Druckerdienst am Misch-PC aktualisieren (Version 1.5 erforderlich)");
    return health;
  }

  function editableLabelLines(text, label) {
    const lines = String(text || "").replace(/\r/g, "").split("\n");
    if (lines.length > 3) throw new Error(label + ": maximal 3 Zeilen (Enter für eine neue Zeile).");
    const cleaned = lines.map((line) => asciiLabelText(line));
    if (!cleaned.some(Boolean)) throw new Error(label + ": bitte Text eingeben.");
    if (cleaned.some((line) => line.length > 26)) throw new Error(label + ": maximal 26 Zeichen pro Zeile.");
    return cleaned;
  }

  function versionAtLeast(value, wantedMinor) {
    const parts = String(value || "").split(".").map(Number);
    return parts[0] > 1 || (parts[0] === 1 && parts[1] >= wantedMinor);
  }

  function asciiLabelText(value) {
    return String(value || "")
      .replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue")
      .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
      .replace(/[·•]/g, "-")
      .replace(/[^A-Za-z0-9 .:/_\-]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isLittleGreene(item) {
    return /little\s*greene/i.test(String(item?.manufacturer || ""));
  }

  function archiveLabel(item, fallback) {
    if (item?.returnLabel) return item.returnLabel;
    const no = Number(item?.returnNo || fallback || 0);
    if (!no) return String(fallback || "");
    const prefix = ({"little greene":"LG",lg:"LG",sto:"ST",synthesa:"SY","kabe farben":"KB",kabe:"KB",farbencenter:"FC",brillux:"BX","farben morscher":"FM"})[String(item?.manufacturer || "").trim().toLowerCase()];
    return prefix ? `${prefix}-${no}` : String(no);
  }

  function dateLabel(value) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("de-AT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: "Europe/Vienna",
    }).format(date);
  }

  function projectLabel(item) {
    if (!item || item.jobId === "__lager__") return "";
    return asciiLabelText([item.jobId, item.jobName].filter(Boolean).join(" - "));
  }

  function setHardwareState(text, ok) {
    const node = el("returnHardwareState");
    if (!node) return;
    node.textContent = text;
    node.classList.toggle("ok", !!ok);
    node.classList.toggle("err", ok === false);
  }

  async function checkHardware() {
    const start = el("returnBridgeStartBtn");
    try {
      const data = await localApi("/health");
      if (start) {
        start.hidden = true;
        start.disabled = false;
        start.textContent = "▶ Dienst starten";
      }
      bridgeStartRequestedAt = 0;
      const scaleOk = !!data.scale?.available;
      const printerOk = !!data.printer?.available;
      if (scaleOk && printerOk) setHardwareState("● Waage + Zebra bereit", true);
      else setHardwareState(`● ${scaleOk ? "Waage" : "Waage fehlt"} · ${printerOk ? "Zebra" : "Zebra fehlt"}`, false);
      return scaleOk && printerOk;
    } catch {
      setHardwareState(
        bridgeStartRequestedAt && Date.now() - bridgeStartRequestedAt < 12000
          ? "● Start angefordert – ggf. Windows-Bestätigung erlauben"
          : "● Hardware-Dienst nicht gestartet",
        false
      );
      if (start) {
        start.hidden = false;
        start.disabled = false;
        start.textContent = "▶ Dienst starten";
      }
      return false;
    }
  }

  function requestBridgeStart() {
    const start = el("returnBridgeStartBtn");
    bridgeStartRequestedAt = Date.now();
    if (start) {
      start.disabled = true;
      start.textContent = "▶ Start wird angefordert …";
    }
    setHardwareState("● Starte Hardware-Dienst am Misch-PC …", false);

    // Nur der Misch-PC hat den lokalen URL-Protokollhandler installiert.
    // Der Browser kann Windows-Dienste nicht selbst starten.
    const link = document.createElement("a");
    link.href = "kristinepaint://start";
    link.style.display = "none";
    document.body.appendChild(link);
    try { link.click(); } finally { link.remove(); }
    [2500, 6000, 11000].forEach((delay) => setTimeout(checkHardware, delay));
  }

  async function readWeight() {
    if (weighing) return;
    const weight = el("returnWeight");
    const button = el("returnWeighBtn");
    if (!weight) return;
    weighing = true;
    if (button) { button.disabled = true; button.textContent = "⚖ lese …"; }
    try {
      const data = await localApi("/weight");
      weight.value = String(data.weightKg).replace(",", ".");
      weight.dataset.fromScale = "1";
      setHardwareState(`● Waage ${data.display} · Zebra bereit`, true);
      const book = el("returnBookBtn");
      if (book) setTimeout(() => book.focus(), 50);
    } catch (error) {
      setHardwareState("● Waage: " + error.message, false);
      weight.focus();
    } finally {
      weighing = false;
      if (button) { button.disabled = false; button.textContent = "⚖ Wiegen"; }
    }
  }
  window.kristineReadReturnWeight = () => localApi("/weight");

  async function printJob(job) {
    const id = String(job?.id || "");
    if (!id || printedJobs.has(id)) return;
    printedJobs.add(id);
    const item = job?.item || null;
    const big = asciiLabelText(archiveLabel(item, job.big || job.returnNo || ""));
    const small = asciiLabelText(String(job.small || dateLabel(item?.createdAt) || ""));
    const project = asciiLabelText(String(job.job || projectLabel(item) || ""));
    try {
      if (item?.id) await requireLabelFeatures();
      await localApi("/print", {
        method: "POST",
        body: JSON.stringify({ big, small, job: project, returnId: /^R-[1-9]\d{0,8}$/.test(String(item?.id || "")) ? item.id : undefined }),
      });
      if (!job.skipAck) {
        await serverApi(`/admin/api/paint/returns/print-queue/${encodeURIComponent(id)}/ack`, {
          method: "POST",
          body: JSON.stringify({ success: true }),
        });
      }
      const status = el("returnStatus");
      if (status) {
        status.textContent = job.skipAck ? `${big} · Etikett nochmal gedruckt ✓` : `${big} archiviert ✓ · Etikett gedruckt ✓`;
        status.classList.add("ok");
        status.classList.remove("err");
      }
      setHardwareState("● Waage + Zebra bereit", true);
      setTimeout(() => el("returnEan")?.focus(), 80);
    } catch (error) {
      printedJobs.delete(id);
      const status = el("returnStatus");
      if (status) {
        status.textContent = job.skipAck ? `${big} konnte nicht nochmals gedruckt werden: ${error.message}` : `${big} ist archiviert. Etikett noch nicht gedruckt: ${error.message}`;
        status.classList.remove("ok");
        status.classList.add("err");
      }
      setHardwareState("● Zebra/Dienst prüfen", false);
      throw error;
    }
  }

  window.kristinePrintReturnLabel = async function kristinePrintReturnLabel(item) {
    if (!item?.returnNo) throw new Error("Archivnummer fehlt");
    return printJob({
      id: `reprint-${item.id || item.returnNo}-${Date.now()}`,
      returnNo: item.returnNo,
      big: archiveLabel(item, item.returnNo),
      small: dateLabel(item.createdAt),
      job: projectLabel(item),
      item,
      skipAck: true,
    });
  };

  function addFreeLabelDialog(heading) {
    const open = document.createElement("button");
    open.id = "returnFreeLabelOpen";
    open.type = "button";
    open.className = "btn";
    open.textContent = "Etikett frei drucken";
    const status = el("returnStatus");
    if (status) status.insertAdjacentElement("afterend", open);
    else heading.insertAdjacentElement("afterend", open);

    const dialog = document.createElement("dialog");
    dialog.id = "returnFreeLabelDialog";
    dialog.setAttribute("aria-labelledby", "returnFreeLabelTitle");
    dialog.innerHTML = `
      <h2 id="returnFreeLabelTitle">Etikett frei drucken</h2>
      <p class="return-free-help">Jeder Text ist frei bearbeitbar. Mit Enter Zeilen anlegen (maximal 3 je Etikett, höchstens 26 Zeichen pro Zeile). Kein Lagerzugang oder Archivvorgang.</p>
      <label for="returnFreeSmall">Kleines Etikett · oben</label>
      <textarea id="returnFreeSmall" class="field" rows="3" maxlength="85" autocomplete="off" spellcheck="false" placeholder="z. B.&#10;Erdgelb&#10;20 kg Putz"></textarea>
      <label for="returnFreeBig">Größeres Etikett · unten</label>
      <textarea id="returnFreeBig" class="field" rows="3" maxlength="85" autocomplete="off" spellcheck="false" placeholder="z. B.&#10;60 g / 20 kg&#10;Erdgelb"></textarea>
      <div class="return-free-options">
        <label for="returnFreeFont">Schriftart<select id="returnFreeFont" class="field"><option value="0">Klar</option><option value="D">Klassisch</option><option value="E">Technisch</option></select></label>
        <label for="returnFreeSize">Schriftgröße<select id="returnFreeSize" class="field"><option value="small">Klein</option><option value="normal" selected>Normal</option><option value="large">Groß</option></select></label>
      </div>
      <div class="return-free-preview" aria-label="Etikettenvorschau">
        <div class="return-free-small" id="returnFreeSmallPreview">Kleines Etikett</div>
        <div class="return-free-big" id="returnFreeBigPreview">Größeres Etikett</div>
      </div>
      <p id="returnFreeMessage" role="status" aria-live="polite"></p>
      <div class="return-free-actions">
        <button id="returnFreeCancel" class="btn" type="button">Schließen</button>
        <button id="returnFreePrint" class="btn primary" type="button">Auf Zebra drucken</button>
      </div>`;
    document.body.appendChild(dialog);
    const small = el("returnFreeSmall"), big = el("returnFreeBig"), font = el("returnFreeFont"), size = el("returnFreeSize"), message = el("returnFreeMessage"), print = el("returnFreePrint");
    const refresh = () => {
      const cleanedSmall = small.value.replace(/\r/g, "").split("\n").map(asciiLabelText);
      const cleanedBig = big.value.replace(/\r/g, "").split("\n").map(asciiLabelText);
      el("returnFreeSmallPreview").textContent = cleanedSmall.some(Boolean) ? cleanedSmall.join("\n") : "Kleines Etikett";
      el("returnFreeBigPreview").textContent = cleanedBig.some(Boolean) ? cleanedBig.join("\n") : "Größeres Etikett";
      const family = font.value === "E" ? "monospace" : font.value === "D" ? "Georgia, serif" : "Arial, sans-serif";
      el("returnFreeBigPreview").style.fontFamily = family;
      el("returnFreeSmallPreview").style.fontFamily = family;
      const factor = {small:.8,normal:1,large:1.18}[size.value] || 1;
      const longestBig = Math.max(1,...cleanedBig.map(line=>line.length));
      const longestSmall = Math.max(1,...cleanedSmall.map(line=>line.length));
      el("returnFreeBigPreview").style.fontSize = Math.min(38*factor,300/longestBig*1.65) + "px";
      el("returnFreeSmallPreview").style.fontSize = Math.min(19*factor,156/longestSmall*1.65) + "px";
      const bad = cleanedSmall.length > 3 || cleanedBig.length > 3 ||
        cleanedSmall.some(line=>line.length>26) || cleanedBig.some(line=>line.length>26);
      message.textContent = bad ? "Bitte maximal 3 Zeilen und 26 Zeichen pro Zeile verwenden." : "";
      print.disabled = bad;
    };
    small.addEventListener("input", refresh);
    big.addEventListener("input", refresh);
    font.addEventListener("change", refresh);
    size.addEventListener("change", refresh);
    open.addEventListener("click", () => { message.textContent = "";refresh();dialog.showModal();small.focus(); });
    el("returnFreeCancel").addEventListener("click", () => dialog.close());
    print.addEventListener("click", async () => {
      let labelSmall, labelBig;
      try {
        labelSmall = editableLabelLines(small.value, "Kleines Etikett");
        labelBig = editableLabelLines(big.value, "Großes Etikett");
      } catch (error) {
        message.textContent = error.message;return;
      }
      print.disabled = true;
      message.textContent = "Drucke …";
      try {
        const health = await requireLabelFeatures();
        if (!versionAtLeast(health.version, 6)) {
          throw new Error("Für frei editierbare, mehrzeilige Etiketten die lokale KRISTINE-Bridge auf Version 1.6 aktualisieren.");
        }
        await localApi("/print", {
          method: "POST",
          body: JSON.stringify({freeText:true,bigLines:labelBig,smallLines:labelSmall,font:font.value,size:size.value}),
        });
        message.textContent = "Beide Etiketten gedruckt ✓";
      } catch (error) { message.textContent = "Druck fehlgeschlagen: " + error.message; }
      finally { print.disabled = false; }
    });
  }

  // Nur NEU erzeugte Druckauftraege dieser Browser-Sitzung automatisch lokal drucken.
  // Alte pending Jobs werden absichtlich nicht automatisch abgearbeitet.
  window.fetch = async function kristineReturnHardwareFetch(input, init) {
    const response = await originalFetch(input, init);
    try {
      const method = String(init?.method || "GET").toUpperCase();
      const url = typeof input === "string" ? input : String(input?.url || "");
      const pathname = new URL(url, location.href).pathname;
      if (method === "POST" && pathname === "/admin/api/paint/returns" && response.ok) {
        const data = await response.clone().json();
        if (data?.ok !== false && data?.printJob?.id) {
          setTimeout(() => printJob({ ...data.printJob, item: data.item || null }), 0);
        }
      }
    } catch {}
    return response;
  };

  function augment() {
    const weight = el("returnWeight");
    if (!weight || el("returnWeighBtn")) return false;

    const style = document.createElement("style");
    style.textContent = `
      .return-hardware-line{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:-4px 0 12px;font-size:12px;font-weight:800;color:#687068}
      .return-hardware-line.ok{color:#23673e}.return-hardware-line.err{color:#a7322d}
      #returnBridgeStartBtn{margin:-5px 0 12px}
      #returnBridgeStartBtn[hidden]{display:none}
      .return-weight-wrap{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;align-items:center}
      .return-weight-wrap .btn{min-height:43px;white-space:nowrap}
      #returnFreeLabelOpen{margin:12px 0}
      #returnFreeLabelDialog{width:min(450px,calc(100% - 30px));max-height:90vh;overflow:auto;border:1px solid #b9c4bc;border-radius:16px;padding:20px;background:#fff;color:#17241b;box-shadow:0 16px 60px #0006}
      #returnFreeLabelDialog::backdrop{background:#0009}
      #returnFreeLabelDialog h2{margin:0 0 6px}
      #returnFreeLabelDialog label{display:block;font-weight:800;margin:14px 0 5px}
      #returnFreeLabelDialog textarea{width:100%;box-sizing:border-box;min-height:80px;resize:vertical;white-space:pre-wrap;line-height:1.35}
      .return-free-options{display:grid;grid-template-columns:1fr 1fr;gap:12px}
      .return-free-options select{width:100%;box-sizing:border-box}
      .return-free-help{margin:0;color:#59665d;font-size:13px}
      .return-free-preview{display:grid;justify-items:center;gap:8px;margin:17px auto;padding:14px;border:1px dashed #acb8ae;border-radius:10px;background:#f1f3f0;overflow:hidden}
      .return-free-small,.return-free-big{display:grid;place-items:center;box-sizing:border-box;max-width:100%;min-width:0;padding:8px;overflow:hidden;white-space:pre-line;overflow-wrap:anywhere;line-height:1.15;text-align:center;background:#fff;border:1px solid #ced3ce;color:#111}
      .return-free-small{width:165px;height:82px;font-size:13px;font-weight:700}
      .return-free-big{width:320px;height:150px;font-size:clamp(18px,5vw,34px);font-weight:900}
      .return-free-actions{display:flex;justify-content:flex-end;gap:8px}
      #returnFreeMessage{min-height:20px}
      @media(max-width:760px){.return-weight-wrap{grid-template-columns:1fr}.return-weight-wrap .btn{width:100%}}
    `;
    document.head.appendChild(style);

    const heading = document.querySelector("#tab-return .card h2");
    if (heading) {
      const state = document.createElement("div");
      state.id = "returnHardwareState";
      state.className = "return-hardware-line";
      state.textContent = "● Hardware wird geprüft …";
      heading.insertAdjacentElement("afterend", state);
      const start = document.createElement("button");
      start.id = "returnBridgeStartBtn";
      start.type = "button";
      start.className = "btn";
      start.hidden = true;
      start.textContent = "▶ Dienst starten";
      start.title = "Startet den lokalen Zebra-/Waagen-Dienst nur am eingerichteten Misch-PC. Windows kann eine Bestätigung verlangen.";
      start.addEventListener("click", requestBridgeStart);
      state.insertAdjacentElement("afterend", start);
      addFreeLabelDialog(heading);
    }

    const wrap = document.createElement("div");
    wrap.className = "return-weight-wrap";
    weight.parentNode.insertBefore(wrap, weight);
    wrap.appendChild(weight);
    const btn = document.createElement("button");
    btn.id = "returnWeighBtn";
    btn.className = "btn";
    btn.type = "button";
    btn.textContent = "⚖ Wiegen";
    btn.addEventListener("click", readWeight);
    wrap.appendChild(btn);

    const colour = el("returnColour");
    colour?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        readWeight();
      }
    });

    // Hardware-Scanner ist eine Tastatur. Bei kompletter EAN automatisch uebernehmen.
    const ean = el("returnEan");
    ean?.addEventListener("input", () => {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => {
        const digits = String(ean.value || "").replace(/\D/g, "");
        if (/^\d+$/.test(String(ean.value || "").trim()) && [8, 12, 13, 14].includes(digits.length)) el("returnLookupBtn")?.click();
      }, 220);
    });

    el("returnStockTabBtn")?.addEventListener("click", () => {
      setTimeout(() => {
        checkHardware();
        el("returnEan")?.focus();
      }, 120);
    });

    checkHardware();
    setInterval(checkHardware, 15000);
    if (qs.get("freeLabel") === "1" && !window.__kristineFreeLabelOpenedFromHeader) {
      window.__kristineFreeLabelOpenedFromHeader = true;
      setTimeout(() => {
        el("returnStockTabBtn")?.click();
        el("returnFreeLabelOpen")?.click();
      }, 160);
    }
    return true;
  }

  if (!augment()) {
    const observer = new MutationObserver(() => { if (augment()) observer.disconnect(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
