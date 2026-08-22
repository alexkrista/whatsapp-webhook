"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { parseMsg, getMsgAttachment, available: msgReaderAvailable } = require("./kristine-msg-reader");

const MAX_FILE_BYTES = 12 * 1024 * 1024;
const OWN_DOMAINS = ["krista.at"];
const MSG_READER_VERSION = "msgreader-1.28";

function safeFilename(value) {
  const name = path.basename(String(value || "Datei")).replace(/[\x00-\x1f<>:"/\\|?*]+/g, "_").trim();
  return (name || "Datei").slice(0, 180);
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function normalizeSpaces(value) {
  return String(value || "").replace(/\u0000/g, "").replace(/[ \t]+/g, " ").replace(/\r?\n[ \t]+/g, "\n").trim();
}

function utf16Runs(buffer, offset = 0) {
  const out = [];
  let chars = [];
  const flush = () => {
    if (chars.length >= 4) {
      const text = normalizeSpaces(chars.join(""));
      if (text.length >= 4) out.push(text);
    }
    chars = [];
  };
  for (let i = offset; i + 1 < buffer.length; i += 2) {
    const code = buffer[i] | (buffer[i + 1] << 8);
    const printable = code === 9 || code === 10 || code === 13 ||
      (code >= 32 && code <= 0x7e) ||
      (code >= 0x00a0 && code <= 0x024f) ||
      (code >= 0x2000 && code <= 0x206f);
    if (printable) chars.push(String.fromCharCode(code));
    else flush();
  }
  flush();
  return out;
}

function asciiRuns(buffer) {
  const out = [];
  let chars = [];
  const flush = () => {
    if (chars.length >= 6) {
      const text = normalizeSpaces(chars.join(""));
      if (text.length >= 6) out.push(text);
    }
    chars = [];
  };
  for (const code of buffer) {
    const printable = code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126);
    if (printable) chars.push(String.fromCharCode(code));
    else flush();
  }
  flush();
  return out;
}

function extractMsgText(buffer) {
  const runs = unique([...utf16Runs(buffer, 0), ...utf16Runs(buffer, 1), ...asciiRuns(buffer)]);
  const useful = runs.filter((text) => {
    const s = text.toLowerCase();
    return text.length >= 8 && (
      text.length >= 24 || /@|betreff:|subject:|von:|from:|gesendet:|sent:|telefon|tel\.|rechnung|bestell|termin|farbe|jotun|projekt|baustelle/.test(s)
    );
  });
  return useful.join("\n\n").slice(0, 500000);
}

function decodeText(buffer, filename, mimeType) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".msg") return extractMsgText(buffer);
  if ([".eml", ".txt", ".csv", ".md", ".json", ".xml", ".html", ".htm"].includes(ext) || /^text\//i.test(mimeType || "")) {
    return normalizeSpaces(buffer.toString("utf8"));
  }
  return "";
}

function decodeInbox(buffer, filename, mimeType) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".msg" && msgReaderAvailable()) {
    try {
      const parsed = parseMsg(buffer);
      parsed.mail.reader = MSG_READER_VERSION;
      return { text: parsed.text, mail: parsed.mail };
    } catch (error) {
      console.warn("⚠️ KRISTINE MSG konnte nicht strukturiert gelesen werden, Fallback aktiv:", String(error?.message || error));
    }
  }
  return { text: decodeText(buffer, filename, mimeType), mail: null };
}

const MONTHS = {
  januar: 1, january: 1, februar: 2, february: 2, märz: 3, maerz: 3, march: 3,
  april: 4, mai: 5, may: 5, juni: 6, june: 6, juli: 7, july: 7, august: 8,
  september: 9, oktober: 10, october: 10, november: 11, dezember: 12, december: 12,
};

function isoDate(year, month, day) {
  const y = Number(year), m = Number(month), d = Number(day);
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return "";
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function extractDates(text) {
  const found = [];
  const numeric = /\b(\d{1,2})[.\/-](\d{1,2})[.\/-](20\d{2}|\d{2})\b/g;
  for (const match of text.matchAll(numeric)) {
    let year = Number(match[3]); if (year < 100) year += 2000;
    found.push({ raw: match[0], iso: isoDate(year, match[2], match[1]), index: match.index || 0 });
  }
  const word = /\b(\d{1,2})[.,]?\s+(Januar|January|Februar|February|März|Maerz|March|April|Mai|May|Juni|June|Juli|July|August|September|Oktober|October|November|Dezember|December)\s+(20\d{2})\b/gi;
  for (const match of text.matchAll(word)) {
    const month = MONTHS[String(match[2]).toLowerCase()];
    found.push({ raw: match[0], iso: isoDate(match[3], month, match[1]), index: match.index || 0 });
  }
  return found.filter((x) => x.iso);
}

function externalEmail(value) {
  const email = String(value || "").toLowerCase();
  return email && !OWN_DOMAINS.some((domain) => email.endsWith(`@${domain}`));
}

function cleanSubject(value) {
  return String(value || "").replace(/^\s*((fw|fwd|wg|aw|re)\s*:\s*)+/i, "").trim().slice(0, 240);
}

function bestBody(text) {
  const markers = ["Von:", "From:"];
  let candidate = "";
  for (const marker of markers) {
    const idx = text.lastIndexOf(marker);
    if (idx >= 0) candidate = text.slice(idx);
  }
  if (!candidate) candidate = text;
  return normalizeSpaces(candidate).slice(0, 12000);
}

function analyzeText(text, filename, mimeType) {
  const source = normalizeSpaces(text);
  const body = bestBody(source);
  const lower = body.toLowerCase();

  const subjectMatches = [...source.matchAll(/(?:^|\n)\s*(?:Betreff|Subject)\s*:\s*([^\r\n]+)/gim)].map((m) => cleanSubject(m[1]));
  const filenameSubject = cleanSubject(path.basename(filename, path.extname(filename)).replace(/_/g, " "));
  const subject = subjectMatches.at(-1) || filenameSubject || "Dokument";

  const fromMatches = [...body.matchAll(/(?:^|\n)\s*(?:Von|From)\s*:\s*([^<\r\n]{2,100})\s*<([^>\s]+@[^>\s]+)>/gim)];
  const from = fromMatches.at(-1);
  const contactName = normalizeSpaces(from?.[1] || "").replace(/\s*\|.*$/, "").slice(0, 120);
  const allEmails = unique([...body.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((m) => m[0].toLowerCase()));
  const contactEmail = (from && externalEmail(from[2]) ? from[2].toLowerCase() : allEmails.find(externalEmail)) || allEmails[0] || "";

  const explicitPhone = body.match(/(?:tel(?:efon)?\.?|phone|mobil|handy)\s*(?:unter|:)?\s*(\+?\d[\d\s().\/-]{6,}\d)/i)?.[1] || "";
  const phoneMatches = unique([explicitPhone, ...[...body.matchAll(/(?:\+?\d[\d\s().\/-]{6,}\d)/g)].map((m) => normalizeSpaces(m[0]))]);
  const plausiblePhones = phoneMatches.filter((value) => {
    const digits = value.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) return false;
    if (/^(\d)\1{6,}$/.test(digits)) return false;
    if (/^00{2,}/.test(digits)) return false;
    return true;
  });
  const contactPhone = plausiblePhones.find((value) => /(?:\+43|0043|\b0[1-9])/.test(value)) || plausiblePhones[0] || "";

  const dates = extractDates(body);
  let dueDate = "";
  const dueWords = /(abhol|fällig|faellig|termin|bis\s|am\s|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)/i;
  for (const d of dates) {
    const context = body.slice(Math.max(0, d.index - 80), d.index + d.raw.length + 80);
    if (dueWords.test(context)) dueDate = d.iso;
  }
  if (!dueDate && dates.length === 1) dueDate = dates[0].iso;

  const productMatch = body.match(/\b(\d+(?:[.,]\d+)?\s*x\s*)?(\d+(?:[.,]\d+)?)\s*(Liter|L|kg|Stk\.?|Stück)\s+([^\r\n]{3,100})/i);
  const colorName = body.match(/Farbtonname\s*:\s*([^\r\n]+)/i)?.[1]?.trim() || "";
  const colorCode = body.match(/Farbtoncode\s*:\s*([^\r\n]+)/i)?.[1]?.trim() || "";
  const recipe = body.match(/Rezeptur\s*:\s*([^\r\n]+)/i)?.[1]?.trim() || "";
  const product = productMatch ? normalizeSpaces(productMatch[0]) : "";

  let recommended = "filing";
  let confidence = 0.72;
  const reasons = [];
  if (/\b(rechnung|invoice|gutschrift)\b/i.test(subject + " " + lower)) {
    recommended = "invoice"; confidence = 0.96; reasons.push("Rechnung erkannt");
  } else if (/\b(farbbestellung|bestellung|bestellen|abholen|anfrage|bitte|rückruf|rueckruf)\b/i.test(subject + " " + lower)) {
    recommended = "task"; confidence = 0.95; reasons.push("konkrete Erledigung erkannt");
  } else if (/\b(termin|besprechung|meeting)\b/i.test(subject + " " + lower) && dueDate) {
    recommended = "appointment"; confidence = 0.9; reasons.push("Termin mit Datum erkannt");
  }

  const detailLines = [];
  if (product) detailLines.push(product);
  if (colorName) detailLines.push(`Farbton: ${colorName}`);
  if (colorCode) detailLines.push(`Farbcode: ${colorCode}`);
  if (recipe) detailLines.push(`Rezeptur: ${recipe}`);
  if (dueDate) detailLines.push(`Termin/Fälligkeit: ${dueDate}`);
  if (contactName || contactEmail || contactPhone) detailLines.push(`Kontakt: ${[contactName, contactEmail, contactPhone].filter(Boolean).join(" · ")}`);

  const meaningfulLines = body.split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !/^(von|from|an|to|gesendet|sent|betreff|subject)\s*:/i.test(x));
  const excerpt = meaningfulLines.slice(0, 18).join("\n").slice(0, 5000);

  return {
    recommended,
    confidence,
    reasons,
    subject,
    title: subject,
    contactName,
    contactEmail,
    contactPhone,
    dueDate,
    product,
    colorName,
    colorCode,
    recipe,
    summary: detailLines.join("\n") || excerpt.slice(0, 1200),
    excerpt,
    textAvailable: Boolean(source),
    mimeType: String(mimeType || ""),
  };
}

function applyMailToAnalysis(analysis, mail) {
  if (!mail) return analysis;
  const senderEmail = String(mail.senderEmail || "").toLowerCase();
  const body = String(mail.body || "").trim();
  return {
    ...analysis,
    subject: mail.subject || analysis.subject,
    title: mail.subject || analysis.title,
    contactName: mail.senderName || analysis.contactName,
    contactEmail: senderEmail || analysis.contactEmail,
    excerpt: body ? body.slice(0, 5000) : analysis.excerpt,
    textAvailable: Boolean(body || mail.bodyHtml || analysis.textAvailable),
    mailReader: mail.reader || MSG_READER_VERSION,
  };
}

function analyzeInboxBuffer(buffer, filename, mimeType) {
  const decoded = decodeInbox(buffer, filename, mimeType);
  const analysisSource = decoded.mail?.body || decoded.text;
  const analysis = applyMailToAnalysis(analyzeText(analysisSource, filename, mimeType), decoded.mail);
  return { text: decoded.text, analysis, mail: decoded.mail };
}

function registerKristineInbox(app, { dataDir, requireAdmin }) {
  const ROOT = path.join(dataDir, "_kristine", "inbox");
  const ITEMS = path.join(ROOT, "items");
  const FILES = path.join(ROOT, "files");

  async function ensure() {
    await Promise.all([fsp.mkdir(ITEMS, { recursive: true }), fsp.mkdir(FILES, { recursive: true })]);
  }
  function itemPath(id) { return path.join(ITEMS, `${String(id).replace(/[^A-Za-z0-9_-]/g, "")}.json`); }
  async function readItem(id) { try { return JSON.parse(await fsp.readFile(itemPath(id), "utf8")); } catch { return null; } }
  async function writeItem(item) { await ensure(); await fsp.writeFile(itemPath(item.id), JSON.stringify(item, null, 2), "utf8"); }
  function originalFilePath(item) { return path.join(FILES, item.id, safeFilename(item.storedFilename || item.name)); }
  function isMsgItem(item) { return path.extname(String(item?.storedFilename || item?.name || "")).toLowerCase() === ".msg"; }

  async function hydrateMsgItem(item) {
    if (!item || !isMsgItem(item) || !msgReaderAvailable()) return item;
    if (item.mail?.reader === MSG_READER_VERSION && item.mail?.body !== undefined) return item;
    const file = originalFilePath(item);
    if (!fs.existsSync(file)) return item;
    try {
      const buffer = await fsp.readFile(file);
      const parsed = analyzeInboxBuffer(buffer, item.name, item.mimeType);
      item.mail = parsed.mail;
      item.analysis = parsed.analysis;
      item.textPreview = parsed.text.slice(0, 12000);
      item.updatedAt = new Date().toISOString();
      await writeItem(item);
    } catch (error) {
      console.warn("⚠️ Bestehende MSG konnte nicht neu gelesen werden:", item.id, String(error?.message || error));
    }
    return item;
  }

  app.post("/kristine/api/inbox/import", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const name = safeFilename(req.body?.name);
      const mimeType = String(req.body?.type || "application/octet-stream").slice(0, 160);
      const base64 = String(req.body?.data || "").replace(/^data:[^;]+;base64,/, "");
      if (!base64) return res.status(400).json({ ok: false, error: "Datei fehlt" });
      const buffer = Buffer.from(base64, "base64");
      if (!buffer.length) return res.status(400).json({ ok: false, error: "Datei ist leer" });
      if (buffer.length > MAX_FILE_BYTES) return res.status(413).json({ ok: false, error: "Datei ist größer als 12 MB" });

      await ensure();
      const id = `inbox_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const dir = path.join(FILES, id);
      await fsp.mkdir(dir, { recursive: true });
      const originalPath = path.join(dir, name);
      await fsp.writeFile(originalPath, buffer);
      const { text, analysis, mail } = analyzeInboxBuffer(buffer, name, mimeType);
      const now = new Date().toISOString();
      const item = {
        id,
        name,
        mimeType,
        size: buffer.length,
        createdAt: now,
        updatedAt: now,
        status: "analyzed",
        route: "",
        links: { taskIds: [], jobIds: [] },
        analysis,
        textPreview: text.slice(0, 12000),
        storedFilename: name,
        ...(mail ? { mail } : {}),
      };
      await writeItem(item);
      res.json({ ok: true, item });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/kristine/api/inbox", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      await ensure();
      const files = (await fsp.readdir(ITEMS)).filter((name) => name.endsWith(".json"));
      const items = [];
      for (const file of files) {
        try { items.push(JSON.parse(await fsp.readFile(path.join(ITEMS, file), "utf8"))); } catch {}
      }
      items.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      res.json({ ok: true, items: items.slice(0, 100) });
    } catch (error) { res.status(500).json({ ok: false, error: String(error?.message || error) }); }
  });

  app.get("/kristine/api/inbox/:id/file", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const item = await readItem(req.params.id);
    if (!item) return res.status(404).send("Eingang nicht gefunden");
    const file = originalFilePath(item);
    if (!fs.existsSync(file)) return res.status(404).send("Originaldatei fehlt");
    res.setHeader("Content-Type", item.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(item.name || "Datei")}`);
    res.sendFile(file);
  });

  app.get("/kristine/api/inbox/:id/msg-attachment/:index", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const item = await readItem(req.params.id);
    if (!item) return res.status(404).send("Eingang nicht gefunden");
    if (!isMsgItem(item)) return res.status(400).send("Keine MSG-Datei");
    const file = originalFilePath(item);
    if (!fs.existsSync(file)) return res.status(404).send("Originaldatei fehlt");
    try {
      const buffer = await fsp.readFile(file);
      const attachment = getMsgAttachment(buffer, req.params.index);
      if (!attachment) return res.status(404).send("Mail-Anlage nicht gefunden");
      const disposition = String(req.query.download || "") === "1" ? "attachment" : "inline";
      res.setHeader("Content-Type", attachment.mimeType || "application/octet-stream");
      res.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(attachment.name || "Anlage")}`);
      res.send(attachment.content);
    } catch (error) {
      res.status(500).send(`Mail-Anlage konnte nicht gelesen werden: ${String(error?.message || error)}`);
    }
  });

  app.get("/kristine/api/inbox/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    let item = await readItem(req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: "Eingang nicht gefunden" });
    item = await hydrateMsgItem(item);
    res.json({ ok: true, item });
  });

  app.post("/kristine/api/inbox/:id/route", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const item = await readItem(req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: "Eingang nicht gefunden" });
    const allowed = ["task", "invoice", "filing", "appointment", "order"];
    const route = String(req.body?.route || "");
    if (!allowed.includes(route)) return res.status(400).json({ ok: false, error: "Unbekanntes Ziel" });
    item.route = route; item.status = route === "task" ? "routed" : "queued"; item.updatedAt = new Date().toISOString();
    await writeItem(item);
    res.json({ ok: true, item });
  });

  app.post("/kristine/api/inbox/:id/link-task", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const item = await readItem(req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: "Eingang nicht gefunden" });
    const taskId = String(req.body?.taskId || "").trim().slice(0, 160);
    if (!taskId) return res.status(400).json({ ok: false, error: "taskId fehlt" });
    item.links = item.links || { taskIds: [], jobIds: [] };
    item.links.taskIds = unique([...(item.links.taskIds || []), taskId]);
    item.route = "task"; item.status = "linked"; item.updatedAt = new Date().toISOString();
    await writeItem(item);
    res.json({ ok: true, item });
  });

  app.get("/kristine/api/inbox/task/:taskId", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      await ensure();
      const taskId = String(req.params.taskId || "");
      const results = [];
      for (const file of (await fsp.readdir(ITEMS)).filter((name) => name.endsWith(".json"))) {
        try {
          const item = JSON.parse(await fsp.readFile(path.join(ITEMS, file), "utf8"));
          if ((item.links?.taskIds || []).map(String).includes(taskId)) results.push(item);
        } catch {}
      }
      results.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
      res.json({ ok: true, items: results });
    } catch (error) { res.status(500).json({ ok: false, error: String(error?.message || error) }); }
  });

  console.log(`✅ KRISTINE Eingang registriert · MSG Reader ${msgReaderAvailable() ? "aktiv" : "Fallback"}`);
}

module.exports = { registerKristineInbox, analyzeInboxBuffer, extractMsgText };
