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
    const no = Number(item?.returnNo || fallback || 0);
    if (!no) return String(fallback || "");
    return isLittleGreene(item) ? `LG ${no}` : String(no);
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
    try {
      const data = await localApi("/health");
      const scaleOk = !!data.scale?.available;
      const printerOk = !!data.printer?.available;
      if (scaleOk && printerOk) setHardwareState("● Waage + Zebra bereit", true);
      else setHardwareState(`● ${scaleOk ? "Waage" : "Waage fehlt"} · ${printerOk ? "Zebra" : "Zebra fehlt"}`, false);
      return scaleOk && printerOk;
    } catch {
      setHardwareState("● Hardware-Dienst nicht gestartet", false);
      return false;
    }
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

  async function printJob(job) {
    const id = String(job?.id || "");
    if (!id || printedJobs.has(id)) return;
    printedJobs.add(id);
    const item = job?.item || null;
    const big = asciiLabelText(archiveLabel(item, job.big || job.returnNo || ""));
    const small = asciiLabelText(String(job.small || dateLabel(item?.createdAt) || ""));
    const project = asciiLabelText(String(job.job || projectLabel(item) || ""));
    try {
      await localApi("/print", {
        method: "POST",
        body: JSON.stringify({ big, small, job: project }),
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
      .return-weight-wrap{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;align-items:center}
      .return-weight-wrap .btn{min-height:43px;white-space:nowrap}
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
        if ([8, 12, 13, 14].includes(digits.length)) el("returnLookupBtn")?.click();
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
    return true;
  }

  if (!augment()) {
    const observer = new MutationObserver(() => { if (augment()) observer.disconnect(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
