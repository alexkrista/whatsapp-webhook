const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// Verify Token (muss mit Meta übereinstimmen)
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// --- Helpers ---
function toISODate(tsSeconds) {
  const d = new Date(Number(tsSeconds) * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function extractSiteCode(text) {
  // sucht #260016 (dein Format: # + 6 Ziffern)
  const m = (text || "").match(/#(\d{6})\b/);
  return m ? m[1] : null;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function appendJsonLine(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
}

// --- Meta Webhook Verify (GET /webhook) ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- Receive WhatsApp events (POST /webhook) ---
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    // Immer sofort 200 zurückgeben (Meta will schnelle Antwort)
    res.sendStatus(200);

    // Nur WhatsApp Events verarbeiten
    if (body.object !== "whatsapp_business_account") return;

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];

    if (!msg) return;

    const from = msg.from;
    const ts = msg.timestamp; // seconds
    const isoDate = toISODate(ts);

    let text = "";
    if (msg.type === "text") text = msg.text?.body || "";

    const siteCode = extractSiteCode(text) || "unknown";

    // Speicherpfad: data/<baustelle>/<YYYY-MM-DD>.jsonl
    const baseDir = path.join(process.cwd(), "data", siteCode);
    ensureDir(baseDir);

    const filePath = path.join(baseDir, `${isoDate}.jsonl`);

    const record = {
      received_at: new Date().toISOString(),
      site_code: siteCode,
      from,
      message_id: msg.id,
      timestamp: ts,
      type: msg.type,
      text,
      raw: msg,
    };

    appendJsonLine(filePath, record);

    console.log(`✅ saved message for #${siteCode} -> ${filePath}`);
  } catch (err) {
    console.error("❌ webhook handler error:", err);
    // response wurde schon gesendet; hier nur loggen
  }
});

// Health
app.get("/", (req, res) => res.send("webhook läuft"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server läuft auf Port", PORT));

