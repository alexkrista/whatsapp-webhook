const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// ===== ENV =====
const DATA_ROOT = process.env.DATA_DIR || "/var/data";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// dein Render-Env heißt WHATSAPP_TOKEN (nicht META_TOKEN)
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// Debug beim Start (damit wir 100% sehen was aktiv ist)
console.log("DATA_DIR env:", process.env.DATA_DIR);
console.log("DATA_ROOT used:", DATA_ROOT);
console.log("VERIFY_TOKEN set:", Boolean(VERIFY_TOKEN));
console.log("WHATSAPP_TOKEN set:", Boolean(WHATSAPP_TOKEN));

// ===== Helpers =====
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function toISODate(tsSeconds) {
  const d = new Date(Number(tsSeconds) * 1000);
  return d.toISOString().slice(0, 10);
}

function extractSiteCode(text) {
  const m = (text || "").match(/#(\d{6})\b/);
  return m ? m[1] : null;
}

function appendJsonLine(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
}

// ===== Webhook Verify =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (!VERIFY_TOKEN) return res.sendStatus(500);

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===== Receive Messages =====
app.post("/webhook", (req, res) => {
  // sofort ok zurück
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.object !== "whatsapp_business_account") return;

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];

    if (!msg) return;

    const ts = msg.timestamp;
    const isoDate = toISODate(ts);

    let text = "";
    if (msg.type === "text") text = msg.text?.body || "";

    const siteCode = extractSiteCode(text) || "unknown";

    // ✅ HIER ist der einzige Pfad, der zählt:
    // /var/data/<siteCode>/<YYYY-MM-DD>.jsonl
    const baseDir = path.join(DATA_ROOT, siteCode);
    ensureDir(baseDir);

    const filePath = path.join(baseDir, `${isoDate}.jsonl`);

    const record = {
      received_at: new Date().toISOString(),
      site_code: siteCode,
      from: msg.from,
      message_id: msg.id,
      timestamp: ts,
      type: msg.type,
      text,
    };

    appendJsonLine(filePath, record);

    // ✅ Log zeigt IMMER den echten Pfad
    console.log(`✅ saved message for #${siteCode} -> ${filePath}`);
  } catch (err) {
    console.error("❌ webhook error:", err);
  }
});

// Health
app.get("/", (req, res) => res.send("webhook läuft"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server läuft auf Port", PORT));
