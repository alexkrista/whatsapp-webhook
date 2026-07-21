"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

function registerDailyReport(app, { dataDir, requireAdmin }) {
  const ROOT = path.join(dataDir, "_kristine");
  const TIME_EVENTS = path.join(ROOT, "time-events.json");
  const REVIEW_ENTRIES = path.join(ROOT, "day-review-entries.json");
  const REPORTS_DIR = path.join(ROOT, "reports");

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await fsp.readFile(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  function viennaParts(d = new Date()) {
    const parts = new Intl.DateTimeFormat("de-AT", {
      timeZone: "Europe/Vienna",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    return Object.fromEntries(parts.map((part) => [part.type, part.value]));
  }

  function localDateISO(d = new Date()) {
    const p = viennaParts(d);
    return `${p.year}-${p.month}-${p.day}`;
  }

  function yesterdayISO() {
    return localDateISO(new Date(Date.now() - 24 * 60 * 60 * 1000));
  }

  function minutesFromHM(value) {
    const m = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  function formatDateDE(dateStr) {
    const [y, m, d] = String(dateStr || "").split("-");
    return y && m && d ? `${d}.${m}.${y}` : String(dateStr || "");
  }

  function safeName(value) {
    return String(value || "")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "ohne_name";
  }

  function wrap(text, maxChars) {
    const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    const lines = [];
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (next.length > maxChars && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function buildBlocks(events) {
    const sorted = events
      .map((event, index) => ({ ...event, _index: index, _minutes: minutesFromHM(event.at) }))
      .filter((event) => event._minutes !== null)
      .sort((a, b) => a._minutes - b._minutes || String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || a._index - b._index);

    const blocks = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const event = sorted[i];
      const next = sorted[i + 1];
      if (next._minutes < event._minutes) continue;
      if (!["start", "weiter"].includes(event.type)) continue;

      const block = {
        from: event.at,
        to: next.at,
        jobId: String(event.jobId || ""),
        jobName: String(event.jobName || event.jobId || "Ohne Baustelle"),
      };
      const previous = blocks.at(-1);
      if (previous && previous.to === block.from && previous.jobId === block.jobId && previous.jobName === block.jobName) {
        previous.to = block.to;
      } else {
        blocks.push(block);
      }
    }
    return blocks;
  }

  async function imageBytes(entry) {
    const rel = String(entry.file || "").replace(/^\/+/, "");
    if (!rel) return null;
    const full = path.join(dataDir, rel);
    if (!full.startsWith(path.resolve(dataDir)) || !fs.existsSync(full)) return null;
    try {
      return await sharp(full)
        .rotate()
        .resize({ width: 260, height: 180, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();
    } catch {
      return null;
    }
  }

  async function collect(date, jobFilter = null) {
    const [timeEvents, reviewEntries] = await Promise.all([
      readJson(TIME_EVENTS, []),
      readJson(REVIEW_ENTRIES, []),
    ]);

    const byEmployee = new Map();
    const ensure = (id, name) => {
      const key = String(id || name || "unbekannt");
      if (!byEmployee.has(key)) byEmployee.set(key, { employeeId: key, employeeName: name || key, events: [], reviews: [] });
      return byEmployee.get(key);
    };

    for (const event of timeEvents) {
      if (String(event.date) !== String(date)) continue;
      if (jobFilter && String(event.jobId || "") !== String(jobFilter)) continue;
      ensure(event.employeeId, event.employeeName).events.push(event);
    }
    for (const entry of reviewEntries) {
      if (String(entry.date) !== String(date)) continue;
      if (jobFilter && String(entry.jobId || "") !== String(jobFilter)) continue;
      ensure(entry.employeeId, entry.employeeName).reviews.push(entry);
    }

    return [...byEmployee.values()]
      .map((employee) => ({ ...employee, blocks: buildBlocks(employee.events) }))
      .filter((employee) => employee.blocks.length || employee.reviews.length)
      .sort((a, b) => String(a.employeeName).localeCompare(String(b.employeeName), "de"));
  }

  async function buildPdf({ date, employees, titleSuffix = "" }) {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const PAGE_W = 841.89;
    const PAGE_H = 595.28;
    const margin = 34;
    let page;
    let y;

    function newPage() {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      page.drawText("KRISTA TAGESREPORT", { x: margin, y: PAGE_H - 38, size: 20, font: bold });
      page.drawText(`${formatDateDE(date)}${titleSuffix ? ` - ${titleSuffix}` : ""}`, { x: margin, y: PAGE_H - 59, size: 11, font });
      page.drawLine({ start: { x: margin, y: PAGE_H - 69 }, end: { x: PAGE_W - margin, y: PAGE_H - 69 }, thickness: 1, color: rgb(0.82, 0.82, 0.82) });
      y = PAGE_H - 91;
    }

    newPage();

    for (const employee of employees) {
      const materials = employee.reviews.filter((entry) => entry.category === "material");
      const photos = employee.reviews.filter((entry) => entry.category === "photo");
      const regie = employee.reviews.filter((entry) => entry.category === "regie");
      const blockLines = employee.blocks.slice(0, 6);
      const materialText = materials.map((entry) => entry.content || entry.transcript || (entry.source === "image" ? "Materialfoto" : "Material")).filter(Boolean).join("; ");
      const regieText = regie.map((entry) => entry.content || entry.transcript || "Regie vorgemerkt").filter(Boolean).join("; ");
      const approxHeight = 44 + blockLines.length * 14 + (materialText ? 28 : 0) + (regieText ? 24 : 0) + (photos.length ? 74 : 0);
      if (y - approxHeight < 42) newPage();

      page.drawText(employee.employeeName, { x: margin, y, size: 13, font: bold });
      y -= 18;

      if (blockLines.length) {
        for (const block of blockLines) {
          page.drawText(`${block.from}-${block.to}`, { x: margin, y, size: 9.5, font: bold });
          page.drawText(block.jobName, { x: margin + 76, y, size: 9.5, font, maxWidth: 310 });
          y -= 14;
        }
      } else {
        page.drawText("Keine vollständigen Zeitblöcke", { x: margin, y, size: 9.5, font });
        y -= 14;
      }

      if (materialText) {
        page.drawText("Material:", { x: margin, y, size: 9, font: bold });
        const lines = wrap(materialText, 92).slice(0, 2);
        lines.forEach((line, idx) => page.drawText(line, { x: margin + 50, y: y - idx * 12, size: 8.5, font, maxWidth: PAGE_W - margin * 2 - 50 }));
        y -= Math.max(14, lines.length * 12);
      }

      if (regieText) {
        page.drawText("Regie:", { x: margin, y, size: 9, font: bold });
        const lines = wrap(regieText, 95).slice(0, 2);
        lines.forEach((line, idx) => page.drawText(line, { x: margin + 40, y: y - idx * 12, size: 8.5, font, maxWidth: PAGE_W - margin * 2 - 40 }));
        y -= Math.max(14, lines.length * 12);
      }

      if (photos.length) {
        page.drawText(`Fotos: ${photos.length}`, { x: margin, y, size: 9, font: bold });
        let x = margin + 54;
        const shown = photos.slice(0, 6);
        for (const photo of shown) {
          const bytes = await imageBytes(photo);
          if (!bytes) continue;
          try {
            const img = await pdf.embedJpg(bytes);
            const boxW = 72;
            const boxH = 50;
            const scale = Math.min(boxW / img.width, boxH / img.height);
            const w = img.width * scale;
            const h = img.height * scale;
            page.drawImage(img, { x, y: y - 53 + (boxH - h) / 2, width: w, height: h });
            x += 82;
          } catch {}
        }
        y -= 58;
      }

      page.drawLine({ start: { x: margin, y: y - 2 }, end: { x: PAGE_W - margin, y: y - 2 }, thickness: 0.5, color: rgb(0.9, 0.9, 0.9) });
      y -= 15;
    }

    if (!employees.length) {
      page.drawText("Für diesen Tag sind noch keine auswertbaren Daten vorhanden.", { x: margin, y, size: 12, font });
    }

    const pages = pdf.getPages();
    pages.forEach((p, index) => {
      p.drawText(`Seite ${index + 1}/${pages.length}`, { x: PAGE_W - 88, y: 18, size: 8, font });
    });

    return Buffer.from(await pdf.save());
  }

  async function generate(date = yesterdayISO()) {
    await fsp.mkdir(REPORTS_DIR, { recursive: true });
    const employees = await collect(date);
    const overallBytes = await buildPdf({ date, employees });
    const overallPath = path.join(REPORTS_DIR, `Tagesreport_${date}.pdf`);
    await fsp.writeFile(overallPath, overallBytes);

    const jobs = new Map();
    for (const employee of employees) {
      for (const block of employee.blocks) {
        if (block.jobId) jobs.set(block.jobId, block.jobName || block.jobId);
      }
      for (const review of employee.reviews) {
        if (review.jobId) jobs.set(String(review.jobId), review.jobName || review.jobId);
      }
    }

    const siteReports = [];
    for (const [jobId, jobName] of jobs.entries()) {
      const siteEmployees = await collect(date, jobId);
      if (!siteEmployees.length) continue;
      const bytes = await buildPdf({ date, employees: siteEmployees, titleSuffix: jobName || jobId });
      const chronikDir = path.join(dataDir, String(jobId), "_chronik");
      await fsp.mkdir(chronikDir, { recursive: true });
      const filePath = path.join(chronikDir, `Tagesreport_${date}.pdf`);
      await fsp.writeFile(filePath, bytes);
      siteReports.push({ jobId, jobName, filePath });
    }

    return { date, overallPath, siteReports };
  }

  app.post("/admin/api/daily-report/:date?", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const date = String(req.params.date || yesterdayISO()).slice(0, 10);
      const result = await generate(date);
      res.json({ ok: true, date, viewUrl: `/admin/daily-report/${date}`, sites: result.siteReports.length });
    } catch (error) {
      console.error("Daily report generation failed:", error);
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/admin/daily-report/:date?", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const date = String(req.params.date || yesterdayISO()).slice(0, 10);
      const filePath = path.join(REPORTS_DIR, `Tagesreport_${date}.pdf`);
      if (!fs.existsSync(filePath) || String(req.query.rebuild || "") === "1") await generate(date);
      res.type("application/pdf");
      res.sendFile(filePath);
    } catch (error) {
      res.status(500).send(String(error?.message || error));
    }
  });

  app.get("/admin/daily-report/:date/download", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const date = String(req.params.date || yesterdayISO()).slice(0, 10);
      const filePath = path.join(REPORTS_DIR, `Tagesreport_${date}.pdf`);
      if (!fs.existsSync(filePath)) await generate(date);
      res.download(filePath, `KRISTA Tagesreport ${date}.pdf`);
    } catch (error) {
      res.status(500).send(String(error?.message || error));
    }
  });

  return { generate, yesterdayISO };
}

module.exports = { registerDailyReport };
