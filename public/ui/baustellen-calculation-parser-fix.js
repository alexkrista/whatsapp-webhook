"use strict";

(() => {
  const VERSION = "2026-08-26-kalk-parser-fix-1";
  const token = new URLSearchParams(location.search).get("token") || "";
  let busy = false;
  let lastFileKey = "";

  const num = value => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  };
  const tokenUrl = path => {
    const url = new URL(path, location.origin);
    if (token && url.origin === location.origin) url.searchParams.set("token", token);
    return url.origin === location.origin ? url.pathname + url.search + url.hash : url.href;
  };
  async function api(path, options = {}) {
    const response = await fetch(tokenUrl(path), options);
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!response.ok || data?.ok === false) throw new Error(data?.error || text || response.statusText);
    return data || {};
  }
  function jobId() {
    return decodeURIComponent(location.hash.slice(1) || "").trim();
  }
  function euro(value) {
    const n = Number(String(value || "").replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  }
  function cleanLead(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/^\d[\d.]*,\d{2}\s+(?:Std|VE|Stk\.?|Stück|Stueck|m²|m2|m|lfm|Psch\.?|Pausch\.?|pauschal)\s+/i, "")
      .replace(/\s+\d[\d.]*,\d{2}(?:\s+\d[\d.]*,\d{2})*\s*$/, "")
      .trim()
      .slice(0, 220);
  }
  function classify(title, description) {
    const hay = `${title || ""} ${description || ""}`.toLowerCase();
    if (/regiearbeiten|nach tatsächlichem aufwand|nach tatsaechlichem aufwand/.test(hay)) {
      return { kind: "regie", suggestedKind: "regie", needsReview: false };
    }
    if (/fahrtkosten|fahrtkostenpauschale/.test(hay)) {
      return { kind: "sonstiges", suggestedKind: "sonstiges", needsReview: false };
    }
    if (/gerüst|geruest|stahlrohrgerüst|stahlrohrgeruest/.test(hay)) {
      return { kind: "fremdleistung", suggestedKind: "fremdleistung", needsReview: true };
    }
    return { kind: "auftrag", suggestedKind: "", needsReview: false };
  }
  function isFlatPosition(number, rest) {
    if (String(number).includes(".")) return true;
    return /\b(?:Std|VE|Stk\.?|Stück|Stueck|m²|m2|lfm|Psch\.?|Pausch\.?|pauschal)\b/i.test(rest) || /\d[\d.]*,\d{2}\s*$/.test(rest);
  }
  function parseText(text, file, currentJob, existing) {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map(line => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const whole = lines.join("\n");
    const moneyMatch = regex => {
      const match = whole.match(regex);
      return match ? euro(match[1]) : 0;
    };
    const orderNo = (whole.match(/(?:Auftragssteuerung|Auftragsbestätigung|Auftragsbestaetigung|Angebot|Auftrag)[\s\S]{0,140}?(?:Nr\.?\s*:?)\s*(\d{6,})/i) || [])[1] || "";
    const projectNo = (whole.match(/Projekt\s*:\s*([A-Za-z0-9_-]+)/i) || [])[1] || "";
    const netTotal = moneyMatch(/Nettosumme\s*=?\s*(?:EUR)?\s*([\d.]+,\d{2})/i);
    const vatAmount = moneyMatch(/(?:USt|MwSt)[^\n]{0,45}(?:EUR)?\s*([\d.]+,\d{2})/i);
    const grossTotal = moneyMatch(/Bruttosumme\s*=?\s*(?:EUR)?\s*([\d.]+,\d{2})/i);
    const documentDate = (whole.match(/\b(\d{1,2}\.\s*(?:Jänner|Januar|Februar|März|Maerz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s+\d{4})\b/i) || [])[1] || "";

    let currentTitleNo = "";
    let currentTitle = "";
    let current = null;
    const positions = [];

    const finalize = () => {
      if (!current) return;
      const description = current.parts.join(" ").replace(/\s+/g, " ").trim();
      const values = description.match(/\d[\d.]*,\d{2}/g) || [];
      const amount = values.length ? euro(values[values.length - 1]) : 0;
      const hourMatch = description.match(/(?:^|\s)(\d+(?:[.,]\d+)?)\s*Std\b/i);
      const plannedHours = hourMatch ? Number(hourMatch[1].replace(",", ".")) || 0 : 0;
      const classification = classify(currentTitle, description);
      positions.push({
        id: `pdf_${String(current.number).replace(/[^A-Za-z0-9]/g, "_")}_${positions.length + 1}`,
        number: current.number,
        titleNo: currentTitleNo,
        title: currentTitle,
        shortText: cleanLead(current.parts[0] || currentTitle || description),
        description,
        amount,
        plannedHours,
        kind: classification.kind,
        suggestedKind: classification.suggestedKind,
        needsReview: classification.needsReview,
        employeeVisible: true,
        addToContract: false,
        source: "pdf",
      });
      current = null;
    };

    for (const line of lines) {
      if (/^Titelzusammenstellung\s*:?/i.test(line)) { finalize(); break; }
      if (/^(?:Nettosumme|Bruttosumme|\d+[.,]\d+%\s*(?:USt|MwSt))/i.test(line)) { finalize(); continue; }
      const titleMatch = line.match(/^Titel\s+(\d+)\s+(.+)$/i);
      if (titleMatch) {
        finalize();
        currentTitleNo = titleMatch[1];
        currentTitle = titleMatch[2].replace(/\s+\d[\d.]*,\d{2}\s*$/, "").trim();
        continue;
      }
      const positionMatch = line.match(/^(\d{1,3}(?:\.\d{1,3})?)\s+(.+)$/);
      if (positionMatch && isFlatPosition(positionMatch[1], positionMatch[2])) {
        finalize();
        current = { number: positionMatch[1], parts: [positionMatch[2]] };
        continue;
      }
      if (current && /^Summe\b/i.test(line)) { finalize(); continue; }
      if (current &&
          !/^Pos\s+Menge\b/i.test(line) &&
          !/^Sparkasse\b/i.test(line) &&
          !/^Farben Krista\b/i.test(line) &&
          !/^Feldkircherstraße\b/i.test(line) &&
          !/^\[?(?:Auftragssteuerung|Auftragsbestätigung|Auftragsbestaetigung)\b/i.test(line) &&
          !/^[-–]\s*\d+\s*[-–]$/.test(line)) {
        current.parts.push(line);
      }
    }
    finalize();

    if (!positions.length) {
      const start = lines.findIndex(line => /^Titelzusammenstellung/i.test(line));
      if (start >= 0) {
        for (const line of lines.slice(start + 1)) {
          if (/^Nettosumme/i.test(line)) break;
          const match = line.match(/^(\d{1,2})\s+(.+?)\s+(\d[\d.]*,\d{2})$/);
          if (!match) continue;
          const classification = classify(match[2], match[2]);
          positions.push({
            id: `title_${match[1]}`,
            number: match[1], titleNo: match[1], title: match[2], shortText: cleanLead(match[2]), description: match[2],
            amount: euro(match[3]), plannedHours: 0, kind: classification.kind, suggestedKind: classification.suggestedKind,
            needsReview: classification.needsReview, employeeVisible: true, addToContract: false, source: "pdf-title"
          });
        }
      }
    }

    const basename = String(file?.name || "")
      .replace(/\.pdf$/i, "")
      .replace(/^(?:Auftragssteuerung|Auftragsbestätigung|Auftragsbestaetigung)\s*/i, "")
      .trim();
    return {
      version: 1,
      parseVersion: 2,
      sourceType: "pdf",
      sourceDocument: existing?.sourceDocument || null,
      orderNo,
      projectNo,
      documentDate,
      customer: existing?.customer || "",
      subject: currentJob?.name || existing?.subject || basename,
      netTotal: netTotal || positions.reduce((sum, row) => sum + num(row.amount), 0),
      vatAmount,
      grossTotal,
      materialPercent: num(existing?.materialPercent ?? currentJob?.materialPercent ?? currentJob?.calculation?.materialPercent),
      billingRate: num(existing?.billingRate ?? currentJob?.billingRate ?? currentJob?.calculation?.billingRate),
      rawText: whole.slice(0, 60000),
      positions,
      updatedAt: existing?.updatedAt || null,
    };
  }

  async function loadPdfJs() {
    if (window.pdfjsLib) return window.pdfjsLib;
    const sources = [
      ["https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js", "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"],
      ["https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js", "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js"],
    ];
    for (const [src, worker] of sources) {
      try {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = src;
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        });
        if (window.pdfjsLib) {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = worker;
          return window.pdfjsLib;
        }
      } catch {}
    }
    throw new Error("PDF-Leser konnte nicht geladen werden.");
  }
  async function extractPdf(file) {
    const pdfjs = await loadPdfJs();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    const pages = [];
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      const items = (content.items || [])
        .filter(item => String(item.str || "").trim())
        .map(item => ({ str: String(item.str || "").trim(), x: Number(item.transform?.[4] || 0), y: Number(item.transform?.[5] || 0) }))
        .sort((a, b) => Math.abs(a.y - b.y) > 2 ? b.y - a.y : a.x - b.x);
      const lines = [];
      let row = [];
      let lastY = null;
      for (const item of items) {
        if (lastY !== null && Math.abs(item.y - lastY) > 2) {
          lines.push(row.sort((a, b) => a.x - b.x).map(part => part.str).join(" "));
          row = [];
        }
        row.push(item);
        lastY = item.y;
      }
      if (row.length) lines.push(row.sort((a, b) => a.x - b.x).map(part => part.str).join(" "));
      pages.push(lines.join("\n"));
    }
    return pages.join("\n");
  }
  function base64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
      reader.onerror = () => reject(reader.error || new Error("Datei konnte nicht gelesen werden."));
      reader.readAsDataURL(file);
    });
  }
  function status(text, error = false) {
    const element = document.getElementById("kcv2ParseStatus");
    if (!element) return;
    element.textContent = text;
    element.className = "kcv2-status" + (error ? " error" : "");
  }
  async function repair(file) {
    if (busy || !file || !/\.pdf$/i.test(file.name)) return;
    const id = jobId();
    if (!id) return;
    const fileKey = `${id}|${file.name}|${file.size}|${file.lastModified}`;
    if (fileKey === lastFileKey) return;
    lastFileKey = fileKey;
    busy = true;
    status("Zweites Leseschema wird probiert …");
    try {
      const [text, jobsData, calcData] = await Promise.all([
        extractPdf(file),
        api("/admin/api/jobs"),
        api(`/admin/api/job/${encodeURIComponent(id)}/order-calculation`),
      ]);
      const currentJob = (jobsData.jobs || []).find(job => String(job.jobId) === String(id)) || null;
      let calculation = parseText(text, file, currentJob, calcData.calculation || null);
      if (!calculation.positions.length) throw new Error("Auch das zweite Leseschema findet keine Positionen.");

      const upload = await api(`/admin/api/job/${encodeURIComponent(id)}/order-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, dataBase64: await base64(file) }),
      });
      calculation.sourceDocument = upload.sourceDocument || calculation.sourceDocument;
      await api(`/admin/api/job/${encodeURIComponent(id)}/order-calculation`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ calculation }),
      });
      status(`✓ Repariert: ${calculation.positions.length} Positionen erkannt`);
      setTimeout(() => {
        window.KristaOrderCalculation?.load?.(id);
        window.KristaOrderCalculation?.tab?.();
        setTimeout(() => status(`✓ ${calculation.positions.length} Positionen erkannt aus ${file.name}`), 350);
      }, 150);
    } catch (error) {
      status("PDF konnte auch im zweiten Leseschema nicht erkannt werden: " + error.message, true);
    } finally {
      busy = false;
    }
  }
  function maybeRepair(file, attempt = 0) {
    setTimeout(() => {
      const text = String(document.getElementById("kcv2ParseStatus")?.textContent || "");
      const match = text.match(/(\d+)\s+Position/i);
      if (match && Number(match[1]) > 0) return;
      if (/PDF wird gelesen/i.test(text) && attempt < 12) return maybeRepair(file, attempt + 1);
      const empty = !document.querySelector("#kcv2Rows tr[data-index]");
      if ((match && Number(match[1]) === 0) || /konnte nicht automatisch gelesen/i.test(text) || empty) repair(file);
    }, attempt ? 350 : 900);
  }
  function install() {
    document.addEventListener("change", event => {
      if (event.target?.id !== "kcv2File") return;
      const file = event.target.files?.[0];
      if (file) maybeRepair(file);
    });
    document.addEventListener("drop", event => {
      if (!event.target?.closest?.("#kcv2Drop")) return;
      const file = event.dataTransfer?.files?.[0];
      if (file) maybeRepair(file);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
  window.KristaCalculationParserFix = { version: VERSION, repair };
})();
