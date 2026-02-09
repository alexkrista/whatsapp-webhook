import express from "express";
import axios from "axios";
import dayjs from "dayjs";
import fs from "fs-extra";
import path from "path";
import morgan from "morgan";
import cron from "node-cron";
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";

// -------------------- CONFIG --------------------
const PORT = process.env.PORT || 10000;
const DATA_DIR = process.env.DATA_DIR || "/var/data"; // Render Disk: /var/data
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || ""; // Meta WhatsApp "phone_number_id"
const GRAPH_VERSION = process.env.GRAPH_VERSION || "v22.0";

// Brevo SMTP
const SMTP_HOST = process.env.SMTP_HOST || "smtp-relay.brevo.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || "587");
const SMTP_USER = process.env.SMTP_USER || ""; // z.B. a1e02a001@smtp-brevo.com
const SMTP_PASS = process.env.SMTP_PASS || ""; // SMTP KEY (nicht dein Login-Passwort!)
const MAIL_FROM = process.env.MAIL_FROM || ""; // MUSS in Brevo verifiziert sein!
const MAIL_TO = process.env.MAIL_TO || "";     // alex@krista.at

// Verhalten
const CODE_TTL_MINUTES = Number(process.env.CODE_TTL_MINUTES || "10"); // 10-Min-Regel
const DEFAULT_PROMPT_TEXT =
  process.env.PROMPT_TEXT || "Bitte Baustellennummer mit # davor senden.";

// Admin Schutz (optional, empfohlen)
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // wenn gesetzt, muss ?key=... dabei sein

// -------------------- STATE --------------------
const STATE_DIR = path.join(DATA_DIR, "_state");
const STATE_FILE = path.join(STATE_DIR, "last_code_by_sender.json");
const SEEN_DIR = path.join(STATE_DIR, "seen");
const seenMemory = new Map(); // messageId -> timestamp (für Dedupe in RAM)

async function loadState() {
  await fs.ensureDir(STATE_DIR);
  await fs.ensureDir(SEEN_DIR);
  if (await fs.pathExists(STATE_FILE)) {
    try {
      return await fs.readJson(STATE_FILE);
    } catch {
      return {};
    }
  }
  return {};
}

async function saveState(state) {
  await fs.ensureDir(STATE_DIR);
  await fs.writeJson(STATE_FILE, state, { spaces: 2 });
}

let lastCodeBySender = await loadState();

// -------------------- HELPERS --------------------
function nowIso() {
  return dayjs().format("YYYY-MM-DD HH:mm:ss");
}

function getDayFolder(date = dayjs()) {
  return date.format("YYYY-MM-DD");
}

function isExpired(tsIso) {
  if (!tsIso) return true;
  const diffMin = dayjs().diff(dayjs(tsIso), "minute");
  return diffMin > CODE_TTL_MINUTES;
}

function normalizeCode(code) {
  // erwartet "#260016" oder "#0815"
  if (!code) return null;
  const m = String(code).trim().match(/^#(\d{1,12})$/);
  if (!m) return null;
  return m[1].padStart(4, "0"); // #0815 etc.
}

function extractCodeFromText(text) {
  if (!text) return null;
  const m = String(text).trim().match(/(^|\s)#(\d{1,12})(\s|$)/);
  if (!m) return null;
  return m[2].padStart(4, "0");
}

function senderState(sender) {
  return lastCodeBySender?.[sender] || null;
}

async function markSeen(messageId) {
  // RAM Dedupe + File Dedupe (robust gegen doppelte Webhook Zustellung)
  if (!messageId) return false;

  const ramTs = seenMemory.get(messageId);
  if (ramTs) return true;

  const marker = path.join(SEEN_DIR, `${messageId}.seen`);
  if (await fs.pathExists(marker)) return true;

  seenMemory.set(messageId, Date.now());
  await fs.outputFile(marker, String(Date.now()));
  return false;
}

function cleanupSeenMemory() {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000; // 6h
  for (const [k, v] of seenMemory.entries()) {
    if (v < cutoff) seenMemory.delete(k);
  }
}

function ensureAdmin(req, res) {
  if (!ADMIN_KEY) return true; // wenn nicht gesetzt, offen
  const key = req.query.key || req.headers["x-admin-key"];
  if (key !== ADMIN_KEY) {
    res.status(403).send("Forbidden");
    return false;
  }
  return true;
}

async function ensureJobDirs(code) {
  const base = path.join(DATA_DIR, code);
  const day = getDayFolder();
  const dayDir = path.join(base, day);
  await fs.ensureDir(dayDir);
  return { base, dayDir };
}

async function appendJsonl(filePath, obj) {
  await fs.ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, JSON.stringify(obj) + "\n");
}

async function whatsappSendText(toWaId, text) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.log("⚠️ WhatsApp send skipped: token or phone_number_id missing");
    return;
  }
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to: toWaId,
      type: "text",
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 20000
    }
  );
}

async function metaGetMediaUrl(mediaId) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`;
  const r = await axios.get(url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    timeout: 20000
  });
  return r.data?.url;
}

async function metaDownloadToFile(downloadUrl, outPath) {
  const r = await axios.get(downloadUrl, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    timeout: 45000
  });
  await fs.outputFile(outPath, r.data);
}

// -------------------- EMAIL --------------------
function makeTransporter() {
  if (!SMTP_USER || !SMTP_PASS || !MAIL_FROM || !MAIL_TO) return null;

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}

async function sendMailWithAttachments(subject, text, attachments) {
  const t = makeTransporter();
  if (!t) {
    console.log("⚠️ Mail skipped: missing SMTP_USER/SMTP_PASS/MAIL_FROM/MAIL_TO");
    return;
  }
  await t.sendMail({
    from: MAIL_FROM,
    to: MAIL_TO,
    subject,
    text,
    attachments
  });
}

// -------------------- PDF --------------------
async function buildPdfForCode(code, dayStr) {
  // Liest:
  // - Textlog: /var/data/<code>/<day>/log.jsonl
  // - Bilder:  /var/data/<code>/<day>/*.jpg
  const dayDir = path.join(DATA_DIR, code, dayStr);
  const logFile = path.join(dayDir, "log.jsonl");

  const exists = await fs.pathExists(dayDir);
  if (!exists) throw new Error(`No data folder: ${dayDir}`);

  const outPdf = path.join(dayDir, `baustellenprotokoll_${code}_${dayStr}.pdf`);

  // Daten sammeln
  let entries = [];
  if (await fs.pathExists(logFile)) {
    const lines = (await fs.readFile(logFile, "utf8"))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    for (const l of lines) {
      try {
        entries.push(JSON.parse(l));
      } catch {}
    }
  }

  // Bilder sammeln (nur jpg)
  const files = await fs.readdir(dayDir);
  const jpgs = files
    .filter((f) => f.toLowerCase().endsWith(".jpg") || f.toLowerCase().endsWith(".jpeg"))
    .sort();

  // PDF schreiben (A4 quer, 6 Fotos/Seite wäre möglich – hier: A4 quer, 4 pro Seite als robustes Default)
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 24 });
  const ws = fs.createWriteStream(outPdf);
  doc.pipe(ws);

  // Deckblatt
  doc.fontSize(22).text("Baustellenprotokoll", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(16).text(`Baustelle #${code}`, { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(12).text(`Datum: ${dayStr}`, { align: "center" });
  doc.addPage();

  // Text-Entries
  doc.fontSize(14).text("Text / Ereignisse", { underline: true });
  doc.moveDown(0.5);

  if (entries.length === 0) {
    doc.fontSize(11).text("Keine Texteingänge.", { color: "gray" });
  } else {
    doc.fontSize(11);
    for (const e of entries) {
      const t = e?.ts || "";
      const from = e?.from || "";
      const body = e?.text || "";
      doc.text(`${t}  (${from})`);
      doc.text(body);
      doc.moveDown(0.5);
    }
  }

  doc.addPage();
  doc.fontSize(14).text("Fotos", { underline: true });
  doc.moveDown(0.5);

  if (jpgs.length === 0) {
    doc.fontSize(11).text("Keine Fotos vorhanden.", { color: "gray" });
  } else {
    // 4 pro Seite (2x2) robust, ohne Bildverzerrung
    const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const pageH = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;

    const cols = 2;
    const rows = 2;
    const cellW = pageW / cols;
    const cellH = pageH / rows;

    let idx = 0;
    for (const f of jpgs) {
      const x = doc.page.margins.left + (idx % cols) * cellW;
      const y = doc.page.margins.top + Math.floor(idx / cols) * cellH;

      const full = path.join(dayDir, f);
      // Bild
      doc.image(full, x + 8, y + 8, {
        fit: [cellW - 16, cellH - 40],
        align: "center",
        valign: "center"
      });
      // Dateiname
      doc.fontSize(9).text(f, x + 8, y + cellH - 24, { width: cellW - 16 });

      idx++;
      if (idx === cols * rows) {
        idx = 0;
        doc.addPage();
      }
    }
  }

  doc.end();

  await new Promise((resolve, reject) => {
    ws.on("finish", resolve);
    ws.on("error", reject);
  });

  return outPdf;
}

// -------------------- EXPRESS APP --------------------
const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(morgan("tiny"));

app.get("/", (req, res) => {
  res.status(200).send("webhook läuft");
});

// Meta verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    res.sendStatus(200); // sofort ack

    const body = req.body;
    if (!body?.entry?.length) return;

    cleanupSeenMemory();

    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        const value = change.value;
        const messages = value?.messages || [];
        const contacts = value?.contacts || [];
        const waFromProfile = contacts?.[0]?.profile?.name || "";

        for (const msg of messages) {
          const messageId = msg.id;
          const already = await markSeen(messageId);
          if (already) continue;

          const from = msg.from; // wa_id
          const ts = dayjs.unix(Number(msg.timestamp || "0")).format("YYYY-MM-DD HH:mm:ss");

          // Baustellencode ermitteln
          let code = null;

          if (msg.type === "text") {
            const txt = msg.text?.body || "";
            const extracted = extractCodeFromText(txt);
            if (extracted) {
              code = extracted;
              lastCodeBySender[from] = { code, updatedAt: nowIso() };
              await saveState(lastCodeBySender);
            } else {
              const st = senderState(from);
              if (st?.code && !isExpired(st.updatedAt)) code = st.code;
            }
          } else {
            const st = senderState(from);
            if (st?.code && !isExpired(st.updatedAt)) code = st.code;
          }

          // Wenn kein Code -> unknown + WhatsApp Prompt
          if (!code) {
            const unknownDir = await ensureJobDirs("unknown");
            const info = {
              ts,
              from,
              name: waFromProfile,
              type: msg.type,
              messageId
            };
            await appendJsonl(path.join(unknownDir.dayDir, "log.jsonl"), info);

            // Prompt an den User
            await whatsappSendText(from, DEFAULT_PROMPT_TEXT);
            console.log(`✅ saved ${msg.type} for #unknown -> ${unknownDir.dayDir}`);
            continue;
          }

          // ordner sicherstellen
          const { dayDir } = await ensureJobDirs(code);

          // TEXT
          if (msg.type === "text") {
            const txt = msg.text?.body || "";
            const obj = { ts, from, name: waFromProfile, type: "text", text: txt, messageId };
            await appendJsonl(path.join(dayDir, "log.jsonl"), obj);

            console.log(`✅ saved text for #${code} -> ${path.join(dayDir, "log.jsonl")}`);

            // Befehle
            const t = txt.trim().toLowerCase();
            if (t === "pdf" || t === "pdf bitte" || t === "protokoll") {
              await whatsappSendText(from, `OK – ich erstelle das PDF für #${code} (${getDayFolder()}) und sende es per Mail.`);
              await runPdfAndMailFor(code, getDayFolder(), { onlyThisCode: true });
            }
          }

          // IMAGE
          if (msg.type === "image") {
            const mediaId = msg.image?.id;
            const metaPath = path.join(dayDir, `${msg.timestamp || Date.now()}_${mediaId}.json`);
            await fs.writeJson(metaPath, { ts, from, name: waFromProfile, messageId, mediaId, raw: msg }, { spaces: 2 });
            console.log(`✅ saved image meta for #${code} -> ${metaPath}`);

            // Download JPG
            if (mediaId && WHATSAPP_TOKEN) {
              try {
                const mediaUrl = await metaGetMediaUrl(mediaId);
                const outJpg = path.join(dayDir, `${msg.timestamp || Date.now()}_${mediaId}.jpg`);
                await metaDownloadToFile(mediaUrl, outJpg);
                console.log(`✅ saved image for #${code} -> ${outJpg}`);
              } catch (e) {
                console.log(`❌ media download failed: ${e?.response?.status || ""} ${e?.response?.data ? JSON.stringify(e.response.data) : e.message}`);
              }
            } else {
              console.log("⚠️ image download skipped: missing mediaId or WHATSAPP_TOKEN");
            }
          }

          // Andere Typen: nur loggen
          if (msg.type !== "text" && msg.type !== "image") {
            const obj = { ts, from, name: waFromProfile, type: msg.type, messageId, raw: msg };
            await appendJsonl(path.join(dayDir, "log.jsonl"), obj);
            console.log(`✅ saved ${msg.type} for #${code} -> ${path.join(dayDir, "log.jsonl")}`);
          }
        }
      }
    }
  } catch (err) {
    console.log("Webhook error:", err?.stack || err?.message || err);
  }
});

// -------------------- ADMIN ROUTES --------------------
app.get("/admin/run-daily", async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  try {
    await runDailyForAllCodes();
    res.status(200).send("OK");
  } catch (e) {
    res.status(500).send(e?.message || String(e));
  }
});

app.get("/admin/run-code", async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  const code = normalizeCode("#" + String(req.query.code || ""));
  const dayStr = String(req.query.day || getDayFolder());
  if (!code) return res.status(400).send("Missing/invalid code");
  try {
    await runPdfAndMailFor(code, dayStr, { onlyThisCode: true });
    res.status(200).send(`OK ${code} ${dayStr}`);
  } catch (e) {
    res.status(500).send(e?.message || String(e));
  }
});

// -------------------- DAILY JOB (22:00 Europe/Vienna) --------------------
// Render läuft oft auf UTC. Wir setzen TZ auf Europe/Vienna, wenn vorhanden.
process.env.TZ = process.env.TZ || "Europe/Vienna";

cron.schedule("0 22 * * *", async () => {
  try {
    console.log("🕙 22:00 job: daily PDFs + mail");
    await runDailyForAllCodes();
  } catch (e) {
    console.log("❌ daily job error:", e?.stack || e?.message || e);
  }
});

// -------------------- JOB LOGIC --------------------
async function listCodes() {
  await fs.ensureDir(DATA_DIR);
  const items = await fs.readdir(DATA_DIR);
  // codes sind Ordner, die nur Ziffern haben + exclude _state
  return items
    .filter((n) => n !== "_state")
    .filter((n) => /^\d+$/.test(n))
    .sort();
}

async function runPdfAndMailFor(code, dayStr, opts = {}) {
  const pdfPath = await buildPdfForCode(code, dayStr);

  // Mail subject/text
  const subject = `Baustellenprotokoll #${code} – ${dayStr}`;
  const text = `Im Anhang: Baustellenprotokoll #${code} vom ${dayStr}.`;

  await sendMailWithAttachments(subject, text, [
    {
      filename: path.basename(pdfPath),
      path: pdfPath
    }
  ]);

  console.log(`📧 mailed PDF for #${code} -> ${MAIL_TO || "(MAIL_TO fehlt)"}`);
  return pdfPath;
}

async function runDailyForAllCodes() {
  const dayStr = getDayFolder();
  const codes = await listCodes();
  if (codes.length === 0) {
    console.log("ℹ️ daily: no codes found");
    return;
  }

  // optional: 1 Mail mit mehreren PDFs oder pro Baustelle eine Mail
  // hier: pro Baustelle eine Mail (übersichtlich)
  for (const code of codes) {
    try {
      // nur wenn es heute etwas gibt
      const dayDir = path.join(DATA_DIR, code, dayStr);
      if (!(await fs.pathExists(dayDir))) continue;

      const files = await fs.readdir(dayDir);
      const hasSomething =
        files.some((f) => f === "log.jsonl") ||
        files.some((f) => f.toLowerCase().endsWith(".jpg") || f.toLowerCase().endsWith(".jpeg"));

      if (!hasSomething) continue;

      await runPdfAndMailFor(code, dayStr);
    } catch (e) {
      console.log(`❌ daily failed for #${code}:`, e?.message || e);
    }
  }
}

// -------------------- START --------------------
app.listen(PORT, async () => {
  await fs.ensureDir(DATA_DIR);
  await fs.ensureDir(STATE_DIR);

  console.log(`Server läuft auf Port ${PORT}`);
  console.log(`DATA_DIR=${DATA_DIR}`);
  console.log(`STATE_FILE=${STATE_FILE}`);
  console.log(`PHONE_NUMBER_ID set: ${Boolean(PHONE_NUMBER_ID)}`);
});
