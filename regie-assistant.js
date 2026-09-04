"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

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
  } = options;
  const ROOT = path.join(dataDir, "_kristine");
  const REPORTS = path.join(ROOT, "regie-reports.json");
  const CONFIRMATIONS = path.join(ROOT, "regie-confirmations.json");
  const TIME_EVENTS = path.join(ROOT, "time-events.json");
  const ASSIGNMENTS = path.join(ROOT, "assignments.json");
  const EMPLOYEES = path.join(ROOT, "employees.json");
  const SYSTEM_EMPLOYEES = path.join(dataDir, "_system", "employees.json");
  const FILES = path.join(ROOT, "regie-files");

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
    const hasHourlyRate = row?.hourlyRate !== undefined && row?.hourlyRate !== null && String(row.hourlyRate).trim() !== "";
    return {
      id: clean(row?.employeeId || row?.id, 100),
      name: clean(row?.name || row?.employeeName, 180),
      from,
      to,
      hours: round(num(row?.hours) || hoursBetween(from, to)),
      hourlyRate: hasHourlyRate ? Math.max(0, round(num(row.hourlyRate))) : null,
    };
  }

  function employeeRate(row, fallback) {
    return row?.hourlyRate === null || row?.hourlyRate === undefined
      ? Math.max(0, num(fallback))
      : Math.max(0, num(row.hourlyRate));
  }

  function normalizeMaterial(row, defaultMarkup = 80) {
    const purchasePrice = round(num(row?.purchasePrice ?? row?.unitPrice ?? row?.ek));
    const markup = Math.max(0, round(num(row?.markup ?? row?.markupPercent ?? defaultMarkup)));
    const explicitSale = num(row?.salePrice ?? row?.vkNet);
    const salePrice = round(explicitSale || purchasePrice * (1 + markup / 100));
    return {
      materialId: clean(row?.materialId, 140),
      product: clean(row?.product || row?.name, 240),
      supplier: clean(row?.supplier, 180),
      quantity: round(num(row?.quantity) || 1),
      unit: clean(row?.unit || "Stk", 40),
      purchasePrice,
      markup,
      salePrice,
      salePriceGross: round(salePrice * 1.2),
      total: round((num(row?.quantity) || 1) * salePrice),
      color: clean(row?.color, 120),
      room: clean(row?.room, 120),
      component: clean(row?.component, 120),
      area: clean(row?.area, 120),
      extraAnswer: clean(row?.extraAnswer, 300),
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

  function fullReportNumber(jobId, sequence) {
    return `${safeId(jobId)}${String(sequence).padStart(3, "0")}`;
  }

  async function nextReportSequence(jobId, reports) {
    const serials = (reports || [])
      .filter(row => String(row.jobId) === String(jobId))
      .map(row => reportSequenceOf(row, jobId))
      .filter(value => value >= 1 && value <= 999);
    return (serials.length ? Math.max(...serials) : 0) + 1;
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

  async function storeInJobFile(report) {
    if (!report.jobId || typeof readDocumentation !== "function" || typeof writeDocumentation !== "function") return;
    const rows = await readDocumentation(report.jobId);
    const item = {
      id: `regie-office-${report.id}`,
      type: "regie_report",
      name: `Regiebericht ${report.reportNumber}`,
      reportNumber: report.reportNumber,
      reportDate: report.date,
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
    const hourlyRate = Math.max(0, num(body.hourlyRate ?? meta.regieHourlyRate ?? 75));
    const materialMarkup = Math.max(0, num(body.materialMarkup ?? meta.regieMaterialMarkup ?? 80));
    if (typeof writeJobMeta === "function") await writeJobMeta(jobId, { regieHourlyRate: hourlyRate, regieMaterialMarkup: materialMarkup });
    const now = new Date().toISOString();
    const employees = (Array.isArray(body.employees) ? body.employees : []).map(normalizeEmployee).filter(row => row.name && row.hours > 0);
    if (!employees.length) throw new Error("Mindestens ein Mitarbeiter mit Stunden fehlt.");
    const materials = (Array.isArray(body.materials) ? body.materials : []).map(row => normalizeMaterial(row, materialMarkup)).filter(row => row.product && row.quantity > 0);
    let reportSequence = Number(body.reportSequence);
    if (!Number.isInteger(reportSequence) || reportSequence < 1 || reportSequence > 999) reportSequence = reportSequenceOf(body, jobId) || reportSequenceOf(existing, jobId);
    if (!Number.isInteger(reportSequence) || reportSequence < 1 || reportSequence > 999) reportSequence = await nextReportSequence(jobId, reports);
    if (reportSequence > 999) throw new Error("Für diese Baustelle sind bereits 999 Rapportnummern vergeben.");
    if (reports.some(row => row.id !== id && String(row.jobId) === jobId && reportSequenceOf(row, jobId) === reportSequence)) {
      throw new Error(`Rapport-Nr. ${reportSequence} ist bei dieser Baustelle bereits vergeben.`);
    }
    const report = {
      ...existing,
      id,
      status: finish ? "completed" : "draft",
      source: clean(existing.source || body.source || "office", 30),
      reportSequence,
      reportNumber: fullReportNumber(jobId, reportSequence),
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
    const employeeRows = report.employees.map(row => { const rate = employeeRate(row, report.hourlyRate); return `<tr><td>${esc(row.name)}</td><td>${esc(row.from || "")}</td><td>${esc(row.to || "")}</td><td class="n">${num(row.hours).toLocaleString("de-AT")} Std</td><td class="n">${money(rate)}</td><td class="n">${money(num(row.hours) * rate)}</td></tr>`; }).join("");
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

  app.get("/kristine/api/regie-reports", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const reports = await readJson(REPORTS, []);
    res.json({ ok: true, reports: reports.slice().sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""))) });
  });
  app.get("/kristine/api/regie-reports/next-number", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const reports = await readJson(REPORTS, []), jobId = safeId(req.query.jobId);
    const reportSequence = await nextReportSequence(jobId, reports);
    res.json({ ok: true, reportSequence, reportNumber: fullReportNumber(jobId, reportSequence) });
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
      else grouped.set(key, { ...current, from: [current.from, row.from].filter(Boolean).sort()[0] || "", to: [current.to, row.to].filter(Boolean).sort().slice(-1)[0] || "", hours: round(num(current.hours) + num(row.hours)) });
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
  app.post("/kristine/api/regie-reports/save", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try { const report = await persistReport(req.body || {}, req.body?.finish === true); res.status(201).json({ ok: true, report }); }
    catch (error) { res.status(400).json({ ok: false, error: String(error.message || error) }); }
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
      const body = req.body || {}, segment = body.segment || {};
      if (!validRange(body.from, body.to, segment.from, segment.to)) return res.status(400).json({ ok: false, error: `Regiezeit muss innerhalb ${segment.from}-${segment.to} liegen` });
      if (!Array.isArray(body.people) || !body.people.length) return res.status(400).json({ ok: false, error: "Mindestens eine Person auswählen" });
      if (!clean(body.description)) return res.status(400).json({ ok: false, error: "Beschreibung fehlt" });
      const reports = await readJson(REPORTS, []), confirmations = await readJson(CONFIRMATIONS, []), now = new Date().toISOString();
      const report = {
        id: `regie_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
        status: "prepared",
        source: "kgo",
        date: clean(body.date, 10),
        jobId: clean(segment.jobId),
        jobName: clean(segment.jobName),
        segment: { from: segment.from, to: segment.to },
        from: clean(body.from, 5),
        to: clean(body.to, 5),
        createdBy: body.createdBy || body.people[0],
        people: body.people.map(person => ({ id: clean(person.id), name: clean(person.name) })),
        employees: body.people.map(person => normalizeEmployee({ ...person, from: body.from, to: body.to })),
        description: clean(body.description, 4000),
        materials: (body.materials || []).map(material => ({ ...normalizeMaterial(material), labelPhotoName: clean(material.labelPhotoName) })),
        photos: (body.photos || []).map(photo => ({ name: clean(photo.name), type: clean(photo.type) })),
        createdAt: now,
        updatedAt: now,
      };
      reports.push(report);
      for (const person of report.people) {
        if (String(person.id) === String(report.createdBy?.id)) continue;
        confirmations.push({ id: `confirm_${report.id}_${person.id}`, reportId: report.id, employeeId: person.id, employeeName: person.name, status: "open", createdAt: now });
      }
      await Promise.all([writeJson(REPORTS, reports.slice(-10000)), writeJson(CONFIRMATIONS, confirmations.slice(-20000))]);
      res.json({ ok: true, report, message: "Regiebericht liegt vorbereitet im KRISTINE-Eingang." });
    } catch (error) { res.status(500).json({ ok: false, error: String(error.message || error) }); }
  });
  app.get("/kristine/api/regie/confirmations", async (req, res) => { const employeeId = clean(req.query.employeeId, 100); const rows = await readJson(CONFIRMATIONS, []); res.json({ ok: true, items: rows.filter(row => row.employeeId === employeeId && row.status === "open") }); });
  app.post("/kristine/api/regie/confirmations/:id", async (req, res) => { try { const rows = await readJson(CONFIRMATIONS, []), item = rows.find(row => row.id === req.params.id); if (!item) return res.status(404).json({ ok: false, error: "Bestätigung nicht gefunden" }); item.status = req.body?.accept === false ? "rejected" : "confirmed"; item.updatedAt = new Date().toISOString(); await writeJson(CONFIRMATIONS, rows); res.json({ ok: true, item }); } catch (error) { res.status(500).json({ ok: false, error: String(error.message || error) }); } });
  app.get("/admin/api/regie-reports", async (req, res) => { if (!requireAdmin(req, res)) return; res.json({ ok: true, reports: await readJson(REPORTS, []) }); });
}

module.exports = { registerRegieAssistant };
