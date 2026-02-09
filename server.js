/**
 * WhatsApp -> Log (Text/Media/Audio) -> PDF -> Email
 * - Data dir: /var/data (Render Disk) or env DATA_DIR
 * - Trigger: send "pdf" in WhatsApp chat
 * - Output: PDF with one item per page (text/image/audio) incl. timestamp
 */

const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json({ limit: "25mb" }));

// -------------------- ENV --------------------
const PORT = process.env.PORT || 10000;
const DATA_DIR = process.env.DATA_DIR || "/var/data";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || ""; // Meta Graph token
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || ""; // optional, only needed for sending WA messages

// SMTP (or SendGrid SMTP)
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || "587");
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";

const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER || "no-reply@example.com";
const MAIL_TO_DEFAULT = process.env.MAIL_TO_DEFAULT || ""; // you set: alex@krista.at or farben.krista@gmx.at

// Optional: When you want to allowlist senders, etc.
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // optional

// -------------------- Helpers --------------------
function nowIso() {
  return new Date().toISOString();
}
function dateYMD(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function timeHM(d = new Date()) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
function safeName(s) {
  return String(s || "")
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}
function ensureDir(p) {
  return fsp.mkdir(p, { recursive: true });
}
function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}
function tsFromWhatsApp(ts) {
  // WA timestamp is string seconds since epoch
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return new Date();
  return new Date(n * 1000);
}
function itemId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function appendJsonl(filePath, obj) {
  await ensureDir(path.dirname(filePath));
  await fsp.appendFile(filePath, JSON.stringify(obj) + "\n", "utf8");
}

async function readJsonl(filePath) {
  try {
    const txt = await fsp.readFile(filePath, "utf8");
    return txt
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch (e) {
    return [];
  }
}

function getChatIdFromText(body) {
  // Expected formats: "#260016 ..." or "260016 ..." or just "pdf" (then unknown)
  const m = String(body || "").match(/#?(\d{3,})/);
  return m ? m[1] : null;
}

function normalizeChatId(chatId) {
  return chatId ? String(chatId) : "unknown";
}

function getDayDir(chatId, day) {
  return path.join(DATA_DIR, normalizeChatId(chatId), day);
}

function getLogPath(chatId, day) {
  return path.join(getDayDir(chatId, day), "log.jsonl");
}

async function downloadWhatsAppMedia(mediaId) {
  if (!WHATSAPP_TOKEN) throw new Error("WHATSAPP_TOKEN missing");

  // 1) get media URL from Graph API
  const meta1 = await fetch(`https://graph.facebook.com/v22.0/${encodeURIComponent(mediaId)}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  if (!meta1.ok) {
    const t = await meta1.text().catch(() => "");
    throw new Error(`Media meta fetch failed (${meta1.status}): ${t}`);
  }
  const j = await meta1.json();
  if (!j || !j.url) throw new Error("Media URL missing from Graph response");

  // 2) download binary using the returned URL
  const meta2 = await fetch(j.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  if (!meta2.ok) {
    const t = await meta2.text().catch(() => "");
    throw new Error(`Media download failed (${meta2.status}): ${t}`);
  }
  const buf = Buffer.from(await meta2.arrayBuffer());
  const mime = j.mime_type || meta2.headers.get("content-type") || "application/octet-stream";
  return { buf, mime, size: buf.length };
}

function mimeToExt(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("jpeg")) return ".jpg";
  if (m.includes("jpg")) return ".jpg";
  if (m.includes("png")) return ".png";
  if (m.includes("pdf")) return ".pdf";
  if (m.includes("ogg")) return ".ogg";
  if (m.includes("audio")) return ".audio";
  if (m.includes("mp4")) return ".mp4";
  return ".bin";
}

function buildMailTransport() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error("SMTP settings missing. Set SMTP_HOST/SMTP_USER/SMTP_PASS (and PORT).");
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

// -------------------- PDF builder --------------------
async function buildPdfForDay(chatId, day) {
  const dayDir = getDayDir(chatId, day);
  const logPath = getLogPath(chatId, day);
  const items = await readJsonl(logPath);

  // Sort chronologically
  items.sort((a, b) => (a.ts || 0) - (b.ts || 0));

  if (items.length === 0) {
    throw new Error(`No items found for ${chatId} ${day}`);
  }

  await ensureDir(dayDir);
  const pdfPath = path.join(dayDir, `${day}.pdf`);

  const doc = new PDFDocument({
    size: "A4",
    margin: 48,
    autoFirstPage: false,
  });

  const ws = fs.createWriteStream(pdfPath);
  doc.pipe(ws);

  const header = (title) => {
    doc.fontSize(14).text(title, { align: "left" });
    doc.moveDown(0.25);
    doc.fontSize(10).fillColor("#444").text(`Chat: #${chatId}   Datum: ${day}`, { align: "left" });
    doc.moveDown(1);
    doc.fillColor("#000");
  };

  for (const it of items) {
    const d = new Date(it.ts || Date.now());
    const stamp = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
      d.getSeconds()
    ).padStart(2, "0")}`;

    if (it.type === "text") {
      doc.addPage();
      header("Text");
      doc.fontSize(11).fillColor("#000").text(`[${stamp}]`, { continued: true });
      doc.fillColor("#111").text(`  ${it.text || ""}`);
      continue;
    }

    if (it.type === "image") {
      doc.addPage();
      header("Foto");
      doc.fontSize(11).fillColor("#000").text(`[${stamp}]  ${it.filename || ""}`);
      doc.moveDown(0.5);

      const abs = path.join(dayDir, it.fileRel || "");
      try {
        // Fit image into page area
        const maxW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
        const maxH = doc.page.height - doc.page.margins.top - doc.page.margins.bottom - 80;
        doc.image(abs, doc.page.margins.left, doc.y, { fit: [maxW, maxH], align: "center", valign: "center" });
      } catch (e) {
        doc.moveDown(1);
        doc.fillColor("red").text(`Bild konnte nicht geladen werden: ${it.fileRel || ""}`);
        doc.fillColor("#000");
      }
      continue;
    }

    if (it.type === "audio") {
      doc.addPage();
      header("Sprachnachricht");
      doc.fontSize(11).fillColor("#000").text(`[${stamp}]  ${it.filename || ""}`);
      doc.moveDown(1);
      doc.fontSize(11).fillColor("#111").text("Audio wurde gespeichert, aber noch nicht transkribiert.");
      if (it.fileRel) {
        doc.moveDown(0.5);
        doc.fontSize(10).fillColor("#444").text(`Datei: ${it.fileRel}`);
      }
      doc.fillColor("#000");
      continue;
    }

    // fallback
    doc.addPage();
    header("Eintrag");
    doc.fontSize(11).text(`[${stamp}]  ${it.type || "unknown"}`);
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor("#444").text(JSON.stringify(it, null, 2));
    doc.fillColor("#000");
  }

  doc.end();

  await new Promise((res, rej) => {
    ws.on("finish", res);
    ws.on("error", rej);
  });

  return pdfPath;
}

// -------------------- Email sender --------------------
async function sendPdfMail({ to, subject, text, pdfPath }) {
  const transport = buildMailTransport();
  const info = await transport.sendMail({
    from: MAIL_FROM,
    to,
    subject,
    text,
    attachments: [{ filename: path.basename(pdfPath), path: pdfPath }],
  });
  return info;
}

// -------------------- Routes --------------------

// Health
app.get("/", (req, res) => res.status(200).send("webhook läuft"));

// Meta webhook verify (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// WhatsApp events (POST)
app.post("/webhook", async (req, res) => {
  // respond quickly
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body || body.object !== "whatsapp_business_account") return;

    const entries = body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value || {};
        const field = change.field;

        if (field !== "messages") continue;

        const messages = value.messages || [];
        const contacts = value.contacts || [];
        const contactName = contacts[0]?.profile?.name || "";
        const waId = contacts[0]?.wa_id || messages[0]?.from || "";

        for (const msg of messages) {
          const tsDate = tsFromWhatsApp(msg.timestamp);
          const ts = tsDate.getTime();
          const day = dateYMD(tsDate);

          // ChatId from message text if present, else fallback to waId
          let chatId = "unknown";

          // ---- TEXT ----
          if (msg.type === "text") {
            const txt = msg.text?.body || "";
            const extracted = getChatIdFromText(txt);
            chatId = normalizeChatId(extracted || waId || "unknown");

            const logPath = getLogPath(chatId, day);
            await appendJsonl(logPath, {
              type: "text",
              ts,
              from: waId,
              contactName,
              text: txt,
              waMessageId: msg.id,
            });

            // trigger pdf if message is exactly "pdf" (case-insensitive) or starts with "pdf "
            const tnorm = txt.trim().toLowerCase();
            const isPdfTrigger = tnorm === "pdf" || tnorm.startsWith("pdf ");
            if (isPdfTrigger) {
              // allow to override recipient via "pdf mail=alex@krista.at" etc (optional)
              // but we keep it simple: use env or ?to parameter via admin route
              const to = MAIL_TO_DEFAULT;
              if (!to) {
                await appendJsonl(logPath, {
                  type: "system",
                  ts: Date.now(),
                  level: "warn",
                  message: "MAIL_TO_DEFAULT missing (set env) - PDF not emailed",
                });
                return;
              }

              const pdfPath = await buildPdfForDay(chatId, day);
              const subject = `Baustellenprotokoll #${chatId} ${day}`;
              const mailText =
                `Automatisch erzeugtes Protokoll\n\nChat: #${chatId}\nDatum: ${day}\n` +
                `Erstellt: ${nowIso()}\n`;

              const info = await sendPdfMail({ to, subject, text: mailText, pdfPath });
              await appendJsonl(logPath, {
                type: "system",
                ts: Date.now(),
                level: "info",
                message: `MAIL sent -> ${to}`,
                messageId: info?.messageId || null,
                pdf: path.basename(pdfPath),
              });
            }

            continue;
          }

          // ---- IMAGE / AUDIO / DOCUMENT ----
          // WhatsApp sends media_id for media
          // We store media and log entry; chatId derived from waId (unless you already used #... earlier that day)
          chatId = normalizeChatId(waId || "unknown");
          const logPath = getLogPath(chatId, day);

          // Determine media id & type
          let mediaId = null;
          let kind = msg.type;

          if (msg.type === "image") mediaId = msg.image?.id;
          if (msg.type === "audio") mediaId = msg.audio?.id;
          if (msg.type === "document") mediaId = msg.document?.id;
          if (msg.type === "video") mediaId = msg.video?.id;

          if (!mediaId) {
            await appendJsonl(logPath, {
              type: "system",
              ts: Date.now(),
              level: "warn",
              message: `Unsupported or missing media id for type=${msg.type}`,
              waMessageId: msg.id,
            });
            continue;
          }

          let dl;
          try {
            dl = await downloadWhatsAppMedia(mediaId);
          } catch (e) {
            await appendJsonl(logPath, {
              type: "system",
              ts: Date.now(),
              level: "error",
              message: `Media download failed: ${String(e.message || e)}`,
              waMessageId: msg.id,
              mediaId,
            });
            continue;
          }

          const ext = mimeToExt(dl.mime);
          const fnameBase = safeName(`${Math.floor(ts / 1000)}_${mediaId}`);
          const filename = `${fnameBase}${ext}`;

          const dayDir = getDayDir(chatId, day);
          await ensureDir(dayDir);

          const absFile = path.join(dayDir, filename);
          await fsp.writeFile(absFile, dl.buf);

          let typeForPdf = "file";
          if (msg.type === "image") typeForPdf = "image";
          if (msg.type === "audio") typeForPdf = "audio";

          await appendJsonl(logPath, {
            type: typeForPdf,
            ts,
            from: waId,
            contactName,
            mime: dl.mime,
            size: dl.size,
            filename,
            fileRel: filename,
            waMessageId: msg.id,
            mediaId,
            originalType: kind,
          });
        }
      }
    }
  } catch (err) {
    // We already sent 200 to Meta; just log
    console.error("Webhook processing error:", err);
  }
});

// Download PDF directly
app.get("/pdf/:chatId/:day", async (req, res) => {
  try {
    const chatId = normalizeChatId(req.params.chatId);
    const day = safeName(req.params.day);
    const pdfPath = path.join(getDayDir(chatId, day), `${day}.pdf`);
    await fsp.access(pdfPath);
    res.setHeader("Content-Type", "application/pdf");
    res.sendFile(pdfPath);
  } catch (e) {
    res.status(404).send("PDF not found. Trigger it by sending 'pdf' in WhatsApp.");
  }
});

// Admin: build+mail today for a chatId (optional)
app.get("/admin/run-daily", async (req, res) => {
  try {
    if (ADMIN_KEY && req.query.key !== ADMIN_KEY) return res.status(403).send("Forbidden");

    const chatId = normalizeChatId(req.query.chatId || "unknown");
    const day = req.query.day ? safeName(req.query.day) : dateYMD(new Date());
    const to = req.query.to || MAIL_TO_DEFAULT;

    if (!to) return res.status(400).send("MAIL_TO_DEFAULT missing (or pass ?to=...)");

    const pdfPath = await buildPdfForDay(chatId, day);
    const subject = `Baustellenprotokoll #${chatId} ${day}`;
    const info = await sendPdfMail({
      to,
      subject,
      text: `Automatisch erzeugtes Protokoll\nChat: #${chatId}\nDatum: ${day}\n`,
      pdfPath,
    });

    res.json({ ok: true, to, pdf: `/pdf/${chatId}/${day}`, messageId: info?.messageId || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
  console.log(`DATA_DIR=${DATA_DIR}`);
});
