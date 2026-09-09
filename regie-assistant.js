"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

function registerRegieAssistant(app, options) {
  const {
    dataDir,
    requireAdmin,
    publicDir,
    readJobMeta,
    writeJobMeta,
    appendJobHistory,
    readDocumentation,
    writeDocumentation,
    sendRegieMail,
  } = options;
  const ROOT = path.join(dataDir, "_kristine");
  const REPORTS = path.join(ROOT, "regie-reports.json");
  const CONFIRMATIONS = path.join(ROOT, "regie-confirmations.json");
  const TIME_EVENTS = path.join(ROOT, "time-events.json");
  const ASSIGNMENTS = path.join(ROOT, "assignments.json");
  const EMPLOYEES = path.join(ROOT, "employees.json");
  const SYSTEM_EMPLOYEES = path.join(dataDir, "_system", "employees.json");
  const FILES = path.join(ROOT, "regie-files");
  const REVIEWS = path.join(ROOT, "day-review-entries.json");

  async function readJson(file, fallback) {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; }
  }
  async function writeJson(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(tmp, file);
  }
  const clean = (value, max = 1000) => String(value ?? "").trim().slice(0, max);
  const safeId = value => clean(value, 140).replace(/[^a-zA-Z0-9_-]/g, "");
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
  const num = value => {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    let text = String(value ?? "").trim().replace(/\s/g, "");
    if (text.includes(",")) text = text.replace(/\./g, "").replace(",", ".");
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const round = value => Math.round((num(value) + Number.EPSILON) * 100) / 100;
  const minutes = value => {
    const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const hoursBetween = (from, to) => {
    const a = minutes(from), b = minutes(to);
    return a === null || b === null || b <= a ? 0 : round((b - a) / 60);
  };
  const quarterHours = value => Math.ceil(Math.max(0, num(value)) * 4) / 4;
  const validRange = (from, to, min, max) => {
    const a = minutes(from), b = minutes(to), lo = minutes(min), hi = minutes(max);
    return a !== null && b !== null && lo !== null && hi !== null && a >= lo && b <= hi && b > a;
  };
  const esc = value => String(value ?? "").replace(/[&<>\"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));
  const money = value => new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR" }).format(num(value));
  const dateLabel = value => validDate(value) ? new Intl.DateTimeFormat("de-AT").format(new Date(`${value}T12:00:00`)) : clean(value, 20);

  function buildSegments(events, employeeId, date) {
    const rows = (events || [])
      .filter(event => String(event.employeeId) === String(employeeId) && String(event.date) === String(date))
      .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
    const result = [];
    for (let index = 0; index < rows.length - 1; index += 1) {
      const current = rows[index], next = rows[index + 1];
      if (!["start", "weiter", "resume"].includes(String(current.type || current.command || "").toLowerCase())) continue;
      result.push({
        id: `seg_${index}`,
        from: clean(current.at, 5),
        to: clean(next.at, 5),
        jobId: clean(current.jobId, 100),
        jobName: clean(current.jobName || current.jobId, 180),
        employeeId: clean(current.employeeId, 100),
        employeeName: clean(current.employeeName, 180),
      });
    }
    return result;
  }

  function normalizeEmployee(row) {
    const from = clean(row?.from, 5), to = clean(row?.to, 5);
    const blocks = (Array.isArray(row?.blocks) && row.blocks.length ? row.blocks : [{ from, to }])
      .map(block => ({ from: clean(block?.from, 5), to: clean(block?.to, 5) }))
      .filter(block => hoursBetween(block.from, block.to) > 0);
    const hasHourlyRate = row?.hourlyRate !== undefined && row?.hourlyRate !== null && String(row.hourlyRate).trim() !== "";
    return {
      id: clean(row?.employeeId || row?.id, 100),
      name: clean(row?.name || row?.employeeName, 180),
      from,
      to,
      hours: round(num(row?.hours) || hoursBetween(from, to)),
      blocks,
      timeLabel: blocks.map(block => `${block.from}–${block.to}`).join(" / "),
      hourlyRate: hasHourlyRate ? Math.max(0, round(num(row.hourlyRate))) : null,
    };
  }

  function normalizeIssuedEmployee(row) {
    const employee = normalizeEmployee(row);
    const netHours = row?.netMinutes !== undefined
      ? Math.max(0, num(row.netMinutes) / 60)
      : (num(row?.hours) || hoursBetween(employee.from, employee.to));
    employee.netMinutes = Math.round(netHours * 60);
    employee.hours = quarterHours(netHours);
    return employee;
  }

  function employeeRate(row, fallback) {
    return row?.hourlyRate === null || row?.hourlyRate === undefined
      ? Math.max(0, num(fallback))
      : Math.max(0, num(row.hourlyRate));
  }

  function normalizeMaterial(row, defaultMarkup = 80, preservePrice = false) {
    const purchasePrice = round(num(row?.purchasePrice ?? row?.unitPrice ?? row?.ek));
    const explicitSale = num(row?.salePrice ?? row?.vkNet);
    const fixedSalePrice = row?.fixedSalePrice === true || (!purchasePrice && explicitSale > 0);
    const markup = fixedSalePrice
      ? 0
      : Math.max(0, round(num(preservePrice ? (row?.markup ?? row?.markupPercent ?? defaultMarkup) : defaultMarkup)));
    const salePrice = round(
      fixedSalePrice || preservePrice
        ? (explicitSale || purchasePrice * (1 + markup / 100))
        : purchasePrice * (1 + markup / 100)
    );
    return {
      materialId: clean(row?.materialId, 140),
      product: clean(row?.product || row?.name, 240),
      supplier: clean(row?.supplier, 180),
      quantity: round(num(row?.quantity) || 1),
      unit: clean(row?.unit || "Stk", 40),
      containerSize: round(num(row?.containerSize) || 1),
      purchasePrice,
      markup,
      salePrice,
      fixedSalePrice,
      salePriceGross: round(salePrice * 1.2),
      total: round((num(row?.quantity) || 1) * salePrice),
      color: clean(row?.color, 120),
      room: clean(row?.room, 120),
      component: clean(row?.component, 120),
      area: clean(row?.area, 120),
      extraAnswer: clean(row?.extraAnswer, 300),
      provisional: row?.provisional === true,
      unknownMaterialId: clean(row?.unknownMaterialId, 150),
      regieEntryId: clean(row?.regieEntryId, 150),
      labelPhotoName: clean(row?.labelPhotoName, 500),
      searchAlias: clean(row?.searchAlias, 240),
    };
  }

  function calculateTotals(report) {
    const laborHours = round((report.employees || []).reduce((sum, row) => sum + num(row.hours), 0));
    const laborTotal = round((report.employees || []).reduce((sum, row) => sum + num(row.hours) * employeeRate(row, report.hourlyRate), 0));
    const materialTotal = round((report.materials || []).reduce((sum, row) => sum + num(row.quantity) * num(row.salePrice), 0));
    const net = round(laborTotal + materialTotal);
    const vat = round(net * 0.2);
    return { laborHours, laborTotal, materialTotal, net, vat, gross: round(net + vat) };
  }

  function reportSequenceOf(report, jobId = report?.jobId) {
    const direct = Number(report?.reportSequence);
    if (Number.isInteger(direct) && direct >= 1 && direct <= 999) return direct;
    const raw = clean(report?.reportNumber, 60);
    if (/^\d{1,3}$/.test(raw)) return Number(raw);
    const prefix = safeId(jobId);
    if (prefix && raw.startsWith(prefix) && /^\d{3}$/.test(raw.slice(prefix.length))) return Number(raw.slice(prefix.length));
    const suffix = raw.match(/(\d{3})$/)?.[1];
    return suffix ? Number(suffix) : 0;
  }

  const isExpressJob = jobId => /^express(?:_|-|$)/i.test(clean(jobId, 140));

  function expressMonth(date) {
    return validDate(date) ? String(date).slice(0, 7).replace("-", "") : new Date().toISOString().slice(0, 7).replace("-", "");
  }

  function fullReportNumber(jobId, sequence, date) {
    return isExpressJob(jobId)
      ? `Express ${expressMonth(date)}${String(sequence).padStart(3, "0")}`
      : `${safeId(jobId)}${String(sequence).padStart(3, "0")}`;
  }

  async function nextReportSequence(jobId, reports, date) {
    const month = expressMonth(date);
    const serials = (reports || [])
      .filter(row => isExpressJob(jobId)
        ? isExpressJob(row.jobId) && expressMonth(row.date) === month
        : String(row.jobId) === String(jobId))
      .map(row => reportSequenceOf(row, jobId))
      .filter(value => value >= 1 && value <= 999);
    return (serials.length ? Math.max(...serials) : 0) + 1;
  }

  function normalizeLegacyExpressNumbers(reports) {
    let changed = false;
    const months = [...new Set((reports || []).filter(row => isExpressJob(row.jobId)).map(row => expressMonth(row.date)))];
    for (const month of months) {
      const rows = reports.filter(row => isExpressJob(row.jobId) && expressMonth(row.date) === month)
        .sort((a, b) => String(a.createdAt || a.id).localeCompare(String(b.createdAt || b.id)));
      const used = new Set(rows.map(row => String(row.reportNumber || "").match(new RegExp(`^Express ${month}(\\d{3})$`))?.[1]).filter(Boolean).map(Number));
      for (const row of rows) {
        if (new RegExp(`^Express ${month}\\d{3}$`).test(String(row.reportNumber || ""))) continue;
        let sequence = reportSequenceOf(row, row.jobId);
        if (!Number.isInteger(sequence) || sequence < 1 || sequence > 999 || used.has(sequence)) {
          sequence = 1;
          while (used.has(sequence) && sequence <= 999) sequence += 1;
        }
        if (sequence > 999) continue;
        used.add(sequence);
        row.reportSequence = sequence;
        row.reportNumber = fullReportNumber(row.jobId, sequence, row.date);
        changed = true;
      }
    }
    return changed;
  }

  async function saveAttachments(reportId, uploads, existing = []) {
    const directory = path.join(FILES, safeId(reportId));
    await fsp.mkdir(directory, { recursive: true });
    const rows = Array.isArray(existing) ? existing.filter(item => item?.storedName) : [];
    for (const upload of (Array.isArray(uploads) ? uploads : []).slice(0, 30)) {
      const match = String(upload?.data || "").match(/^data:([^;,]+);base64,(.+)$/s);
      if (!match) continue;
      const buffer = Buffer.from(match[2], "base64");
      if (!buffer.length || buffer.length > 20 * 1024 * 1024) continue;
      const originalName = path.basename(clean(upload.name, 180)).replace(/[^a-zA-Z0-9äöüÄÖÜß._ -]/g, "_") || "Anlage";
      const storedName = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${originalName}`;
      await fsp.writeFile(path.join(directory, storedName), buffer);
      rows.push({ id: `file_${crypto.randomBytes(6).toString("hex")}`, name: originalName, storedName, type: clean(match[1], 100), size: buffer.length, createdAt: new Date().toISOString() });
    }
    return rows.slice(-100);
  }

  async function storeRegiePhotos(report, uploads) {
    const images = (Array.isArray(uploads) ? uploads : []).filter(upload => String(upload?.data || "").startsWith("data:image/")).slice(0, 30);
    if (!images.length) return [];
    const employeeId = safeId(report.createdBy?.id || "regie") || "regie";
    const directory = path.join(ROOT, "media", report.date, employeeId);
    await fsp.mkdir(directory, { recursive: true });
    const reviews = await readJson(REVIEWS, []), stored = [];
    for (const upload of images) {
      const match = String(upload.data).match(/^data:([^;,]+);base64,(.+)$/s);
      if (!match) continue;
      const buffer = Buffer.from(match[2], "base64");
      if (!buffer.length || buffer.length > 20 * 1024 * 1024) continue;
      const extension = String(match[1]).includes("png") ? ".png" : String(match[1]).includes("webp") ? ".webp" : ".jpg";
      const filename = `${Math.floor(Date.now() / 1000)}_${safeId(report.id)}_${crypto.randomBytes(3).toString("hex")}${extension}`;
      const absolute = path.join(directory, filename);
      await fsp.writeFile(absolute, buffer);
      const relative = path.relative(dataDir, absolute).split(path.sep).join("/");
      const entry = {
        id: `regie_photo_${safeId(report.id)}_${crypto.randomBytes(4).toString("hex")}`,
        createdAt: new Date().toISOString(),
        employeeId: clean(report.createdBy?.id, 100),
        employeeName: clean(report.createdBy?.name, 180),
        date: report.date,
        category: "photo",
        kind: "photo",
        source: "regie",
        tag: "Regie",
        tags: ["Regie"],
        file: relative,
        mime: clean(match[1], 100),
        jobId: report.jobId,
        jobName: report.jobName,
        assignmentStatus: "assigned",
        needsOfficeReview: false,
        content: `Regie · ${clean(report.description, 500)}`,
        reportId: report.id,
      };
      reviews.push(entry);
      stored.push(entry);
    }
    await writeJson(REVIEWS, reviews.slice(-20000));
    return stored;
  }

  async function storeInDayRegie(report) {
    if (!validDate(report.date) || !safeId(report.jobId)) return;
    const [year, month, day] = report.date.split("-");
    const directory = path.join(dataDir, safeId(report.jobId), year, month, day);
    const file = path.join(directory, "regie.json");
    await fsp.mkdir(directory, { recursive: true });
    const existing = await readJson(file, {}), reportIds = Array.isArray(existing.reportIds) ? existing.reportIds : [];
    const materialRows = (Array.isArray(existing.materials) ? existing.materials : []).filter(row => row.reportId !== report.id).concat(report.materials.map(row => ({
      name: row.product,
      quantity: String(row.quantity),
      unit: row.unit,
      source: "Regie",
      reportId: report.id,
    })));
    const employeeRows = (Array.isArray(existing.employees) ? existing.employees : []).filter(row => row.reportId !== report.id).concat(report.employees.map(row => ({
      employeeId: row.id,
      name: row.name,
      from: row.from,
      to: row.to,
      breakMinutes: 0,
      totalHours: row.hours,
      regieHours: row.hours,
      regieDescription: report.description,
      reportId: report.id,
    })));
    const previousDescription = clean(existing.regieDescriptions?.[report.id], 4000);
    let customerText = clean(existing.customerText, 12000);
    if (previousDescription && customerText.includes(previousDescription)) customerText = customerText.replace(previousDescription, report.description);
    else if (!reportIds.includes(report.id)) customerText = [customerText, report.description].filter(Boolean).join("\n\n").slice(0, 12000);
    await writeJson(file, {
      ...existing,
      version: existing.version || "3.2.0",
      jobId: report.jobId,
      day: report.date,
      status: report.processingStatus === "draft" ? "Entwurf" : "Ausgestellt",
      employees: employeeRows,
      customerText,
      internalNote: clean(existing.internalNote, 12000),
      materials: materialRows,
      specialMaterial: clean(existing.specialMaterial, 4000),
      materialTomorrow: existing.materialTomorrow || { needed: false, text: "" },
      reportIds: [...new Set([...reportIds, report.id])],
      regieDescriptions: { ...(existing.regieDescriptions || {}), [report.id]: report.description },
      createdAt: existing.createdAt || report.createdAt,
      updatedAt: new Date().toISOString(),
    });
  }

  function recipientRows(meta) {
    const contacts = meta?.projectContacts || {}, owner = contacts.owner || {}, siteManager = contacts.siteManager || {};
    const rows = [];
    const add = (role, name, email) => {
      const cleanEmail = clean(email, 180).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || rows.some(row => row.email === cleanEmail)) return;
      rows.push({ role, name: clean(name, 180) || role, email: cleanEmail });
    };
    add("Kunde", owner.customer || meta?.contactName, owner.womanEmail || owner.email || meta?.contactEmail);
    add("Kunde", [owner.manFirstName, owner.manLastName].filter(Boolean).join(" "), owner.manEmail);
    add("Bauleiter", [siteManager.firstName, siteManager.lastName].filter(Boolean).join(" ") || siteManager.company, siteManager.email);
    return rows;
  }

  async function createRegiePdf(report, meta) {
    const pdf = await PDFDocument.create(), regular = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const size = [595.28, 841.89], margin = 48, line = 15;
    const wrap = (text, maxWidth, font = regular, fontSize = 10) => {
      const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean), lines = []; let current = "";
      for (const word of words) { const candidate = current ? `${current} ${word}` : word; if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) current = candidate; else { if (current) lines.push(current); current = word; } }
      if (current) lines.push(current); return lines.length ? lines : [""];
    };
    let page, y;
    const newPage = () => { page = pdf.addPage(size); y = size[1] - margin; page.drawText("KRISTA GmbH", { x: margin, y, size: 15, font: bold, color: rgb(.12,.34,.2) }); y -= 30; };
    const ensure = height => { if (y - height < margin) newPage(); };
    const text = (value, options = {}) => { const font = options.bold ? bold : regular, fontSize = options.size || 10, rows = wrap(value, options.width || size[0] - margin * 2, font, fontSize); ensure(rows.length * (options.line || line)); for (const row of rows) { page.drawText(row, { x: options.x || margin, y, size: fontSize, font, color: options.color || rgb(.08,.12,.09) }); y -= options.line || line; } };
    newPage(); text(`Regiebericht Nr. ${reportSequenceOf(report, report.jobId) || report.reportNumber}`, { bold: true, size: 20, line: 26 });
    text(`Projekt ${report.jobId} · ${report.jobName}`, { bold: true, size: 11 }); text(`Datum: ${dateLabel(report.date)}`); y -= 10;
    text("Durchgeführte Arbeiten", { bold: true, size: 12, color: rgb(.12,.34,.2) }); text(report.description, { size: 11, line: 16 }); y -= 10;
    text("Arbeitszeit", { bold: true, size: 12, color: rgb(.12,.34,.2) });
    for (const row of report.employees) text(`${row.name} · ${row.from || ""}–${row.to || ""} · ${num(row.hours).toLocaleString("de-AT")} Std. · ${money(num(row.hours) * employeeRate(row, report.hourlyRate))}`);
    if (report.materials.length) { y -= 8; text("Material", { bold: true, size: 12, color: rgb(.12,.34,.2) }); for (const row of report.materials) text(`${row.product} · ${num(row.quantity).toLocaleString("de-AT")} ${row.unit} · ${money(num(row.quantity) * num(row.salePrice))}`); }
    y -= 12; text(`Arbeit: ${money(report.totals.laborTotal)}`, { bold: true }); text(`Material: ${money(report.totals.materialTotal)}`, { bold: true }); text(`Netto: ${money(report.totals.net)} · 20 % MwSt.: ${money(report.totals.vat)} · Brutto: ${money(report.totals.gross)}`, { bold: true });
    y -= 35; ensure(80); page.drawLine({ start: { x: margin, y }, end: { x: margin + 190, y }, thickness: .7 }); page.drawLine({ start: { x: size[0] - margin - 190, y }, end: { x: size[0] - margin, y }, thickness: .7 }); y -= 14; text("Ort, Datum                              Auftraggeber", { size: 9 });
    const bytes = await pdf.save(); return Buffer.from(bytes);
  }

  async function storeInJobFile(report) {
    if (!report.jobId || typeof readDocumentation !== "function" || typeof writeDocumentation !== "function") return;
    const rows = await readDocumentation(report.jobId);
    const item = {
      id: `regie-office-${report.id}`,
      type: "regie_report",
      name: `Regiebericht ${report.reportNumber}`,
      reportNumber: report.reportNumber,
      reportDate: report.date,
      description: report.description,
      employees: report.employees.map(row => row.name).filter(Boolean).join(", "),
      totalHours: report.totals.laborHours,
      employeeDetails: report.employees.map(row => ({ name: row.name, hours: row.hours, hourlyRate: employeeRate(row, report.hourlyRate), cost: round(num(row.hours) * employeeRate(row, report.hourlyRate)) })),
      laborCost: report.totals.laborTotal,
      materialTotal: money(report.totals.materialTotal),
      materialCost: report.totals.materialTotal,
      materials: report.materials.map(row => ({ name: row.product, quantity: row.quantity, unit: row.unit, cost: round(num(row.quantity) * num(row.salePrice)) })),
      importedAt: report.completedAt || report.updatedAt,
      source: report.source || "office",
      url: `/kristine/regie-report/${encodeURIComponent(report.id)}/print`,
      attachments: report.attachments || [],
      processingStatus: report.processingStatus || (report.status === "completed" ? "approved" : "issued"),
      billingStatus: report.billingStatus || "open",
    };
    const index = rows.findIndex(row => row.id === item.id);
    if (index >= 0) rows[index] = item; else rows.unshift(item);
    await writeDocumentation(report.jobId, rows.slice(0, 1000));
  }

  async function persistReport(body, finish) {
    const reports = await readJson(REPORTS, []);
    const id = safeId(body.id) || `regie_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const existingIndex = reports.findIndex(row => row.id === id);
    const existing = existingIndex >= 0 ? reports[existingIndex] : {};
    const jobId = safeId(body.jobId || existing.jobId);
    if (!jobId) throw new Error("Bitte eine Baustelle auswählen.");
    if (!clean(body.description || existing.description, 4000)) throw new Error("Beschreibung der Arbeit fehlt.");
    const meta = typeof readJobMeta === "function" ? await readJobMeta(jobId) : {};
    const priceLocked = existing.status === "completed";
    const hourlyRate = Math.max(0, num(priceLocked ? existing.hourlyRate : (body.hourlyRate ?? meta.regieHourlyRate ?? 75)));
    const materialMarkup = Math.max(0, num(priceLocked ? existing.materialMarkup : (body.materialMarkup ?? meta.regieMaterialMarkup ?? 80)));
    if (!priceLocked && typeof writeJobMeta === "function") await writeJobMeta(jobId, { regieHourlyRate: hourlyRate, regieMaterialMarkup: materialMarkup });
    const now = new Date().toISOString();
    const employeeSource = priceLocked ? existing.employees : (Array.isArray(body.employees) ? body.employees : []);
    const employees = employeeSource
      .map(normalizeEmployee)
      .map(row => priceLocked ? row : { ...row, hourlyRate: null })
      .filter(row => row.name && row.hours > 0);
    if (!employees.length) throw new Error("Mindestens ein Mitarbeiter mit Stunden fehlt.");
    const materialSource = priceLocked ? existing.materials : (Array.isArray(body.materials) ? body.materials : []);
    const materials = materialSource
      .map(row => normalizeMaterial(row, materialMarkup, priceLocked))
      .filter(row => row.product && row.quantity > 0);
    let reportSequence = Number(body.reportSequence);
    if (!Number.isInteger(reportSequence) || reportSequence < 1 || reportSequence > 999) reportSequence = reportSequenceOf(body, jobId) || reportSequenceOf(existing, jobId);
    if (!Number.isInteger(reportSequence) || reportSequence < 1 || reportSequence > 999) reportSequence = await nextReportSequence(jobId, reports, body.date || existing.date);
    if (reportSequence > 999) throw new Error("Für diese Baustelle sind bereits 999 Rapportnummern vergeben.");
    if (reports.some(row => row.id !== id &&
      (isExpressJob(jobId) ? isExpressJob(row.jobId) && expressMonth(row.date) === expressMonth(body.date || existing.date) : String(row.jobId) === jobId) &&
      reportSequenceOf(row, jobId) === reportSequence)) {
      throw new Error(`Rapport-Nr. ${reportSequence} ist bei dieser Baustelle bereits vergeben.`);
    }
    const report = {
      ...existing,
      id,
      status: priceLocked ? existing.status : (finish ? "completed" : "draft"),
      processingStatus: priceLocked ? existing.processingStatus : (finish ? "approved" : (existing.processingStatus || (existing.status === "prepared" ? "issued" : "draft"))),
      billingStatus: existing.billingStatus || body.billingStatus || "open",
      source: clean(existing.source || body.source || "office", 30),
      reportSequence,
      reportNumber: fullReportNumber(jobId, reportSequence, body.date || existing.date),
      date: validDate(body.date) ? body.date : new Date().toISOString().slice(0, 10),
      jobId,
      jobName: clean(body.jobName || meta.name || existing.jobName || jobId, 220),
      description: clean(body.description, 5000),
      employees,
      people: employees.map(row => ({ id: row.id, name: row.name })),
      materials,
      hourlyRate: round(hourlyRate),
      materialMarkup: round(materialMarkup),
      internalNote: clean(body.internalNote, 4000),
      attachments: await saveAttachments(id, body.uploads, existing.attachments),
      createdAt: existing.createdAt || now,
      updatedAt: now,
      completedAt: finish ? (existing.completedAt || now) : existing.completedAt || null,
    };
    report.totals = calculateTotals(report);
    if (existingIndex >= 0) reports[existingIndex] = report; else reports.push(report);
    await writeJson(REPORTS, reports.slice(-10000));
    if (finish) {
      await storeInJobFile(report);
      if (typeof appendJobHistory === "function") await appendJobHistory(jobId, {
        type: "regie_report_completed",
        title: `Regiebericht ${report.reportNumber} gespeichert`,
        detail: `${report.totals.laborHours} h · Material ${money(report.totals.materialTotal)} · Gesamt ${money(report.totals.net)}`,
        source: "KRISTINE Eingang",
        data: { reportId: report.id },
      }).catch(() => {});
    }
    return report;
  }

  function printHtml(report, meta) {
    const employeeRows = report.employees.map(row => { const rate = employeeRate(row, report.hourlyRate), time = clean(row.timeLabel, 300); const timeCells = time && (row.blocks || []).length > 1 ? `<td colspan="2">${esc(time)}</td>` : `<td>${esc(row.from || "")}</td><td>${esc(row.to || "")}</td>`; return `<tr><td>${esc(row.name)}</td>${timeCells}<td class="n">${num(row.hours).toLocaleString("de-AT")} Std</td><td class="n">${money(rate)}</td><td class="n">${money(num(row.hours) * rate)}</td></tr>`; }).join("");
    const materialRows = report.materials.map(row => `<tr><td>${esc(row.product)}</td><td class="n">${num(row.quantity).toLocaleString("de-AT")} ${esc(row.unit)}</td><td class="n">${money(row.salePrice)}</td><td class="n">${money(num(row.quantity) * num(row.salePrice))}</td></tr>`).join("");
    const address = [meta?.contactName || meta?.name || report.jobName, `${meta?.street || ""} ${meta?.houseNumber || ""}`.trim(), `${meta?.postalCode || ""} ${meta?.city || ""}`.trim()].filter(Boolean);
    const sequence = reportSequenceOf(report, report.jobId) || report.reportNumber;
    return `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Regiebericht ${esc(report.reportNumber)}</title><style>
@font-face{font-family:Titillium;src:url('/public/fonts/TitilliumWeb-Regular.ttf')}@font-face{font-family:Titillium;src:url('/public/fonts/TitilliumWeb-SemiBold.ttf');font-weight:600}
@page{size:A4;margin:22mm 18mm 18mm;@top-right{content:"";width:30mm;height:13mm;background:url('/public/krista-logo.png') no-repeat right bottom/25mm auto;}@bottom-left{content:"Seite " counter(page) " / " counter(pages);font-family:Titillium,Arial,sans-serif;font-size:9px;color:#49604f}}
@page:first{@top-right{content:none}}
*{box-sizing:border-box}body{font-family:Titillium,Arial,sans-serif;color:#142019;font-size:12px;margin:0}.page{display:block}.head{display:flex;justify-content:space-between;align-items:flex-start}.brand{width:48mm}.logo{display:block;width:48mm;height:auto}.address{line-height:1.35;margin-top:15mm}.project{text-align:left;margin-top:7mm}.project strong{font-size:13px}.title{margin-top:13mm;border-bottom:2px solid #31583b;padding-bottom:4px;display:flex;align-items:baseline;justify-content:space-between;gap:12px}.title h1,.title-meta{font-size:23px;line-height:1.1;margin:0}.title-meta{font-weight:600;white-space:nowrap}.work-box{border:1.5px solid #879b89;border-radius:5px;margin:12px 0 15px;padding:8px 10px;display:grid;grid-template-columns:125px 1fr;gap:10px;background:#fbfcfa;break-inside:avoid}.work-box strong{font-size:14px}.work-description{white-space:pre-wrap;line-height:1.4;font-size:14px}.section{margin-top:12px;font-size:15px;font-weight:600;color:#31583b}table{width:100%;border-collapse:collapse;margin-top:5px;break-inside:auto}thead{display:table-header-group}tr{break-inside:avoid}th{font-weight:600;text-align:left;border-bottom:1.5px solid #31583b;padding:4px 6px}td{padding:5px 6px;border-bottom:1px solid #d9ded9}.n{text-align:right;white-space:nowrap}.totals{margin:16px 0 0 auto;width:75mm;break-inside:avoid}.totals div{display:flex;justify-content:space-between;padding:3px 2px}.totals .net{border-top:2px solid #31583b;font-weight:600}.totals .gross{border-top:1.5px solid #31583b;font-weight:600;font-size:13px}.closing{break-inside:avoid}.accept{margin-top:18px;line-height:1.5}.signatures{display:grid;grid-template-columns:1fr 1fr;gap:22mm;margin-top:18mm}.signature{border-top:1px solid #333;padding-top:4px}.footer{margin-top:7mm;padding-top:4px;font-size:9px;color:#49604f;display:flex;justify-content:space-between}@media print{.no-print{display:none!important}}
</style></head><body><main class="page"><header class="head"><div class="address">${address.map(esc).join("<br>")}</div><div class="brand"><img class="logo" src="/public/krista-logo.png" alt="Krista"><div class="project"><strong>Projekt ${esc(report.jobId)}</strong><br>${esc(report.jobName)}</div></div></header><section class="title"><h1>Regiebericht</h1><div class="title-meta">Nr. ${esc(sequence)} vom ${dateLabel(report.date)}</div></section><div class="work-box"><strong>Durchgeführte Arbeiten</strong><span class="work-description">${esc(report.description)}</span></div><div class="section">Arbeitszeit</div><table><thead><tr><th>Mitarbeiter</th><th>Von</th><th>Bis</th><th class="n">Stunden</th><th class="n">Stundensatz</th><th class="n">Betrag</th></tr></thead><tbody>${employeeRows}</tbody></table>${materialRows ? `<div class="section">Material</div><table><thead><tr><th>Material</th><th class="n">Menge</th><th class="n">Einzelpreis</th><th class="n">Betrag</th></tr></thead><tbody>${materialRows}</tbody></table>` : ""}<div class="totals"><div><span>Arbeit</span><strong>${money(report.totals.laborTotal)}</strong></div><div><span>Material</span><strong>${money(report.totals.materialTotal)}</strong></div><div class="net"><span>Netto</span><strong>${money(report.totals.net)}</strong></div><div><span>20 % MwSt.</span><strong>${money(report.totals.vat)}</strong></div><div class="gross"><span>Brutto</span><strong>${money(report.totals.gross)}</strong></div></div><div class="closing"><div class="accept">Die angeführten Arbeiten und Materialien wurden ordnungsgemäß ausgeführt bzw. geliefert. Mit der Unterschrift bestätigt der Auftraggeber die Richtigkeit dieses Regieberichts.</div><div class="signatures"><div class="signature">Ort, Datum</div><div class="signature">Auftraggeber</div></div><footer class="footer"><span>Krista GmbH · Studa 104 · 6800 Feldkirch</span><span>Regiebericht ${esc(report.reportNumber)}</span></footer></div></main><script>if(new URLSearchParams(location.search).has('print'))setTimeout(()=>print(),350)<\/script></body></html>`;
  }

  const sendPage = (name, req, res) => {
    if (!requireAdmin(req, res)) return;
    const file = path.join(publicDir || path.join(process.cwd(), "public"), name);
    if (!fs.existsSync(file)) return res.status(404).send(`${name} fehlt`);
    res.sendFile(file);
  };

  app.get("/kristine/regie", (req, res) => {
    const file = path.join(publicDir || path.join(process.cwd(), "public"), "regie-assistant.html");
    if (!fs.existsSync(file)) return res.status(404).send("regie-assistant.html fehlt");
    res.sendFile(file);
  });
  app.get("/kristine/eingang", (req, res) => sendPage("regie-workbench.html", req, res));

  app.get("/kristine/api/regie/context", async (req, res) => {
    try {
      const date = clean(req.query.date, 10) || new Date().toISOString().slice(0, 10), employeeId = clean(req.query.employeeId, 100);
      const [events, assignments, employees] = await Promise.all([readJson(TIME_EVENTS, []), readJson(ASSIGNMENTS, []), readJson(EMPLOYEES, [])]);
      let segments = buildSegments(events, employeeId, date);
      if (!segments.length) segments = assignments.filter(row => String(row.employeeId) === employeeId && String(row.date) === date).map((row, index) => ({ id: `assignment_${index}`, from: row.from || "07:00", to: row.to || "17:00", jobId: clean(row.jobId), jobName: clean(row.jobName || row.jobId), employeeId, employeeName: clean(row.employeeName) }));
      const dayJobIds = new Set(segments.map(row => row.jobId).filter(Boolean));
      const team = assignments.filter(row => String(row.date) === date && dayJobIds.has(String(row.jobId))).map(row => ({ id: clean(row.employeeId), name: clean(row.employeeName || employees.find(employee => String(employee.id) === String(row.employeeId))?.name || row.employeeId) }));
      res.json({ ok: true, date, segments, team: [...new Map(team.map(row => [row.id, row])).values()] });
    } catch (error) { res.status(500).json({ ok: false, error: String(error.message || error) }); }
  });

  app.get("/kristine/api/regie/drafts", async (req, res) => {
    try {
      const employeeId = clean(req.query.employeeId, 100), jobId = safeId(req.query.jobId), date = clean(req.query.date, 10);
      const drafts = (await readJson(REPORTS, []))
        .filter(report => report.status === "draft")
        .filter(report => !employeeId || String(report.createdBy?.id) === employeeId || (report.people || []).some(person => String(person.id) === employeeId))
        .filter(report => !jobId || String(report.jobId) === jobId)
        .filter(report => !date || String(report.date) === date)
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
      res.json({ ok: true, drafts });
    } catch (error) { res.status(500).json({ ok: false, error: String(error.message || error) }); }
  });

  app.get("/kristine/api/regie-reports", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const reports = await readJson(REPORTS, []);
    if (normalizeLegacyExpressNumbers(reports)) await writeJson(REPORTS, reports);
    res.json({ ok: true, reports: reports.slice().sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""))) });
  });
  app.get("/kristine/api/regie-reports/next-number", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const reports = await readJson(REPORTS, []), jobId = safeId(req.query.jobId), date = clean(req.query.date, 10);
    const reportSequence = await nextReportSequence(jobId, reports, date);
    res.json({ ok: true, reportSequence, reportNumber: fullReportNumber(jobId, reportSequence, date) });
  });
  app.get("/kristine/api/regie-reports/time-suggestions", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const jobId = safeId(req.query.jobId), date = clean(req.query.date, 10);
    const [events, assignments, systemEmployees, legacyEmployees] = await Promise.all([readJson(TIME_EVENTS, []), readJson(ASSIGNMENTS, []), readJson(SYSTEM_EMPLOYEES, []), readJson(EMPLOYEES, [])]);
    const employeeMaster = [...systemEmployees, ...legacyEmployees];
    const normName = value => clean(value, 180).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const resolveEmployee = row => {
      const rawId = clean(row.id || row.employeeId, 100), rawName = clean(row.name || row.employeeName, 180);
      const found = employeeMaster.find(employee => String(employee.id) === rawId)
        || employeeMaster.find(employee => normName(employee.name) === normName(rawName));
      return { ...row, id: clean(found?.id || rawId, 100), name: clean(found?.name || rawName || rawId, 180) };
    };
    const assigned = assignments.filter(row => String(row.jobId) === jobId && String(row.date) === date).map(row => resolveEmployee(normalizeEmployee({ id: row.employeeId, name: row.employeeName, from: row.from || "07:00", to: row.to || "", hours: row.hours || row.durationHours })));
    const ids = [...new Set(events.filter(row => String(row.jobId) === jobId && String(row.date) === date).map(row => String(row.employeeId || "")).filter(Boolean))];
    const eventRows = ids.flatMap(id => buildSegments(events, id, date)).filter(row => String(row.jobId) === jobId).map(row => resolveEmployee(normalizeEmployee(row)));
    const actualEmployeeIds = new Set(eventRows.map(row => String(row.id || normName(row.name))).filter(Boolean));
    const fallbackRows = assigned.filter(row => !actualEmployeeIds.has(String(row.id || normName(row.name))));
    const grouped = new Map();
    for (const row of [...eventRows, ...fallbackRows].filter(row => row.name && row.hours > 0)) {
      const key = String(row.id || normName(row.name));
      const current = grouped.get(key);
      if (!current) grouped.set(key, { ...row });
      else {
        const blocks = [...(current.blocks || []), ...(row.blocks || [])];
        grouped.set(key, {
          ...current,
          from: [current.from, row.from].filter(Boolean).sort()[0] || "",
          to: [current.to, row.to].filter(Boolean).sort().slice(-1)[0] || "",
          hours: round(num(current.hours) + num(row.hours)),
          blocks,
          timeLabel: blocks.map(block => `${block.from}–${block.to}`).join(" / "),
        });
      }
    }
    const suggestions = [...grouped.values()];
    res.json({ ok: true, suggestions });
  });
  app.get("/kristine/api/regie-reports/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const reports = await readJson(REPORTS, []), report = reports.find(row => row.id === safeId(req.params.id));
    if (!report) return res.status(404).json({ ok: false, error: "Regiebericht nicht gefunden" });
    res.json({ ok: true, report });
  });
  app.get("/kristine/api/regie-reports/:id/recipients", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const report = (await readJson(REPORTS, [])).find(row => row.id === safeId(req.params.id));
    if (!report) return res.status(404).json({ ok: false, error: "Regiebericht nicht gefunden" });
    const meta = typeof readJobMeta === "function" ? await readJobMeta(report.jobId) : {};
    res.json({ ok: true, recipients: recipientRows(meta) });
  });
  app.post("/kristine/api/regie-reports/save", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try { const report = await persistReport(req.body || {}, req.body?.finish === true); res.status(201).json({ ok: true, report }); }
    catch (error) { res.status(400).json({ ok: false, error: String(error.message || error) }); }
  });
  app.post("/kristine/api/regie-reports/:id/status", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const reports = await readJson(REPORTS, []), report = reports.find(row => row.id === safeId(req.params.id));
      if (!report) return res.status(404).json({ ok: false, error: "Regiebericht nicht gefunden" });
      const processing = clean(req.body?.processingStatus, 30), billing = clean(req.body?.billingStatus, 30);
      const allowedProcessing = ["issued", "approved", "sent", "signed"];
      const allowedBilling = ["open", "billed"];
      if (processing && !allowedProcessing.includes(processing)) return res.status(400).json({ ok: false, error: "Ungültiger Bearbeitungsstatus" });
      if (billing && !allowedBilling.includes(billing)) return res.status(400).json({ ok: false, error: "Ungültiger Abrechnungsstatus" });
      if (processing) report.processingStatus = processing;
      if (billing) report.billingStatus = billing;
      if (["approved", "sent", "signed"].includes(report.processingStatus)) report.status = "completed";
      report.updatedAt = new Date().toISOString();
      if (report.processingStatus === "approved" && !report.approvedAt) report.approvedAt = report.updatedAt;
      if (report.processingStatus === "sent" && !report.sentAt) report.sentAt = report.updatedAt;
      if (report.processingStatus === "signed" && !report.signedAt) report.signedAt = report.updatedAt;
      if (report.billingStatus === "billed" && !report.billedAt) report.billedAt = report.updatedAt;
      await writeJson(REPORTS, reports);
      report.totals = report.totals || calculateTotals(report);
      await storeInJobFile(report);
      if (typeof appendJobHistory === "function") await appendJobHistory(report.jobId, {
        type: "regie_status_changed",
        title: `Regiebericht ${report.reportNumber} · ${report.processingStatus}`,
        detail: `Bearbeitung ${report.processingStatus} · Abrechnung ${report.billingStatus}`,
        source: "KRISTINE Eingang",
        data: { reportId: report.id, processingStatus: report.processingStatus, billingStatus: report.billingStatus },
      }).catch(() => {});
      res.json({ ok: true, report });
    } catch (error) { res.status(500).json({ ok: false, error: String(error.message || error) }); }
  });
  app.post("/kristine/api/regie-reports/:id/send", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const reports = await readJson(REPORTS, []), report = reports.find(row => row.id === safeId(req.params.id));
      if (!report) return res.status(404).json({ ok: false, error: "Regiebericht nicht gefunden" });
      if (!["approved", "sent", "signed"].includes(report.processingStatus)) return res.status(409).json({ ok: false, error: "Regiebericht zuerst prüfen und freigeben." });
      const to = clean(req.body?.to, 180).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ ok: false, error: "Gültige Empfänger-E-Mail fehlt." });
      if (typeof sendRegieMail !== "function") return res.status(503).json({ ok: false, error: "E-Mail-Versand ist nicht eingerichtet." });
      report.totals = report.totals || calculateTotals(report);
      const meta = typeof readJobMeta === "function" ? await readJobMeta(report.jobId) : {};
      const directory = path.join(FILES, safeId(report.id)); await fsp.mkdir(directory, { recursive: true });
      const filename = `Regiebericht_${safeId(report.reportNumber)}.pdf`, filePath = path.join(directory, filename);
      await fsp.writeFile(filePath, await createRegiePdf(report, meta));
      const info = await sendRegieMail({
        to,
        subject: `Regiebericht ${reportSequenceOf(report, report.jobId) || report.reportNumber} · ${report.jobName}`,
        text: `Guten Tag,\n\nim Anhang erhalten Sie den Regiebericht ${report.reportNumber} vom ${dateLabel(report.date)}.\n\nFreundliche Grüße\nKrista GmbH`,
        filePath,
      });
      if (!info) return res.status(502).json({ ok: false, error: "E-Mail konnte nicht versendet werden." });
      report.processingStatus = "sent"; report.status = "completed"; report.sentAt = new Date().toISOString(); report.sentTo = to; report.updatedAt = report.sentAt;
      const existingPdf = (report.attachments || []).find(row => row.kind === "generated_pdf");
      const pdfAttachment = { id: existingPdf?.id || `file_${crypto.randomBytes(6).toString("hex")}`, name: filename, storedName: filename, type: "application/pdf", kind: "generated_pdf", createdAt: report.sentAt };
      report.attachments = [...(report.attachments || []).filter(row => row.kind !== "generated_pdf"), pdfAttachment];
      await writeJson(REPORTS, reports); await storeInJobFile(report);
      if (typeof appendJobHistory === "function") await appendJobHistory(report.jobId, { type: "regie_report_sent", title: `Regiebericht ${report.reportNumber} versendet`, detail: `PDF an ${to}`, source: "KRISTINE Eingang", data: { reportId: report.id, to } }).catch(() => {});
      res.json({ ok: true, report, to });
    } catch (error) { res.status(500).json({ ok: false, error: String(error.message || error) }); }
  });
  app.delete("/kristine/api/regie-reports/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = safeId(req.params.id), reports = await readJson(REPORTS, []);
      const index = reports.findIndex(row => row.id === id);
      if (index < 0) return res.status(404).json({ ok: false, error: "Regiebericht nicht gefunden" });
      if (reports[index].status === "completed") return res.status(409).json({ ok: false, error: "Fertiggestellte Regieberichte bleiben geschützt und können nicht gelöscht werden." });
      reports.splice(index, 1);
      const confirmations = (await readJson(CONFIRMATIONS, [])).filter(row => row.reportId !== id);
      await Promise.all([writeJson(REPORTS, reports), writeJson(CONFIRMATIONS, confirmations)]);
      const attachmentDir = path.resolve(FILES, id), filesRoot = `${path.resolve(FILES)}${path.sep}`;
      if (attachmentDir.startsWith(filesRoot)) await fsp.rm(attachmentDir, { recursive: true, force: true });
      res.json({ ok: true, deleted: id });
    } catch (error) { res.status(500).json({ ok: false, error: String(error.message || error) }); }
  });
  app.get("/kristine/api/regie-reports/:id/file/:fileId", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const report = (await readJson(REPORTS, [])).find(row => row.id === safeId(req.params.id));
    const file = report?.attachments?.find(row => row.id === safeId(req.params.fileId));
    if (!file) return res.status(404).send("Datei nicht gefunden");
    const absolute = path.join(FILES, safeId(report.id), path.basename(file.storedName));
    if (!fs.existsSync(absolute)) return res.status(404).send("Datei nicht gefunden");
    res.type(file.type || path.extname(file.name)).sendFile(absolute);
  });
  app.get("/kristine/regie-report/:id/print", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const report = (await readJson(REPORTS, [])).find(row => row.id === safeId(req.params.id));
    if (!report) return res.status(404).send("Regiebericht nicht gefunden");
    const meta = typeof readJobMeta === "function" ? await readJobMeta(report.jobId) : {};
    res.type("html").send(printHtml({ ...report, totals: report.totals || calculateTotals(report) }, meta));
  });

  app.post("/kristine/api/regie", async (req, res) => {
    try {
      const body = req.body || {}, segment = body.segment || {}, draft = body.draft === true;
      if (!Array.isArray(body.people) || !body.people.length) return res.status(400).json({ ok: false, error: "Mindestens eine Person auswählen" });
      if (!clean(body.description)) return res.status(400).json({ ok: false, error: "Beschreibung fehlt" });
      const reports = await readJson(REPORTS, []), confirmations = await readJson(CONFIRMATIONS, []), now = new Date().toISOString();
      const jobId = safeId(segment.jobId);
      if (!jobId) return res.status(400).json({ ok: false, error: "Baustelle fehlt" });
      const requestedId = safeId(body.id);
      const existingIndex = reports.findIndex(report => report.status === "draft" && (
        (requestedId && report.id === requestedId) ||
        (!requestedId && String(report.jobId) === jobId && String(report.date) === String(body.date) && String(report.createdBy?.id) === String(body.createdBy?.id))
      ));
      const existing = existingIndex >= 0 ? reports[existingIndex] : null;
      const incomingEmployees = Array.isArray(body.employees) && body.employees.length
        ? body.employees
        : body.people.map(person => ({ ...person, from: body.from, to: body.to }));
      const employees = incomingEmployees.map(normalizeIssuedEmployee).map(row => ({ ...row, hourlyRate: null })).filter(row => row.name && row.hours > 0);
      if (!employees.length) return res.status(400).json({ ok: false, error: "Mindestens ein Mitarbeiter mit Regiestunden fehlt" });
      const meta = typeof readJobMeta === "function" ? await readJobMeta(jobId) : {};
      const reportSequence = reportSequenceOf(existing, jobId) || await nextReportSequence(jobId, reports, body.date);
      const report = {
        id: existing?.id || `regie_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
        status: draft ? "draft" : "prepared",
        processingStatus: draft ? "draft" : "issued",
        billingStatus: "open",
        source: "kgo",
        reportSequence,
        reportNumber: fullReportNumber(jobId, reportSequence, body.date),
        date: validDate(body.date) ? body.date : new Date().toISOString().slice(0, 10),
        jobId,
        jobName: clean(segment.jobName || meta.name || jobId),
        segment: { from: segment.from, to: segment.to },
        hoursMode: body.hoursMode === "range" ? "range" : "day",
        teamMode: body.teamMode === "partial" ? "partial" : "all",
        from: clean(body.from || employees.map(row => row.from).filter(Boolean).sort()[0], 5),
        to: clean(body.to || employees.map(row => row.to).filter(Boolean).sort().slice(-1)[0], 5),
        createdBy: body.createdBy || body.people[0],
        people: employees.map(person => ({ id: person.id, name: person.name })),
        employees,
        description: clean(body.description, 4000),
        materials: (body.materials || []).map(material => normalizeMaterial(material, meta.regieMaterialMarkup ?? 80)),
        hourlyRate: round(Math.max(0, num(meta.regieHourlyRate ?? 75))),
        materialMarkup: round(Math.max(0, num(meta.regieMaterialMarkup ?? 80))),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      report.attachments = await saveAttachments(report.id, body.uploads, existing?.attachments || []);
      report.photos = report.attachments.filter(file => String(file.type || "").startsWith("image/"));
      report.totals = calculateTotals(report);
      if (existingIndex >= 0) reports[existingIndex] = report; else reports.push(report);
      if (!draft) for (const person of report.people) {
        if (String(person.id) === String(report.createdBy?.id) || confirmations.some(item => item.reportId === report.id && String(item.employeeId) === String(person.id))) continue;
        confirmations.push({ id: `confirm_${report.id}_${person.id}`, reportId: report.id, employeeId: person.id, employeeName: person.name, status: "open", createdAt: now });
      }
      await Promise.all([
        writeJson(REPORTS, reports.slice(-10000)),
        writeJson(CONFIRMATIONS, confirmations.slice(-20000)),
        storeRegiePhotos(report, body.uploads),
        storeInDayRegie(report),
        storeInJobFile(report),
      ]);
      if (typeof appendJobHistory === "function") await appendJobHistory(jobId, {
        type: draft ? "regie_report_draft_saved" : "regie_report_issued",
        title: draft ? `Regiebericht ${report.reportNumber} als Entwurf gespeichert` : `Regiebericht ${report.reportNumber} ausgestellt`,
        detail: `${report.totals.laborHours} h · ${report.materials.length} Materialposition(en) · ${report.photos.length} Foto(s)`,
        source: "KGO",
        data: { reportId: report.id, processingStatus: report.processingStatus, billingStatus: "open" },
      }).catch(() => {});
      res.json({ ok: true, report, message: draft ? "Regiebericht ist gespeichert und kann später fertig gemacht werden." : "Regiebericht ist ausgestellt und liegt bei Alex zur Prüfung." });
    } catch (error) { res.status(500).json({ ok: false, error: String(error.message || error) }); }
  });
  app.get("/kristine/api/regie/confirmations", async (req, res) => { const employeeId = clean(req.query.employeeId, 100); const rows = await readJson(CONFIRMATIONS, []); res.json({ ok: true, items: rows.filter(row => row.employeeId === employeeId && row.status === "open") }); });
  app.post("/kristine/api/regie/confirmations/:id", async (req, res) => { try { const rows = await readJson(CONFIRMATIONS, []), item = rows.find(row => row.id === req.params.id); if (!item) return res.status(404).json({ ok: false, error: "Bestätigung nicht gefunden" }); item.status = req.body?.accept === false ? "rejected" : "confirmed"; item.updatedAt = new Date().toISOString(); await writeJson(CONFIRMATIONS, rows); res.json({ ok: true, item }); } catch (error) { res.status(500).json({ ok: false, error: String(error.message || error) }); } });
  app.get("/admin/api/regie-reports", async (req, res) => { if (!requireAdmin(req, res)) return; res.json({ ok: true, reports: await readJson(REPORTS, []) }); });
}

module.exports = { registerRegieAssistant };
