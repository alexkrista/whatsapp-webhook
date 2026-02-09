import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";

// =====================
// Config / ENV
// =====================
const PORT = process.env.PORT || 10000;

// Render Disk empfohlen:
const DATA_DIR = process.env.DATA_DIR || "/var/data";
const STATE_DIR = path.join(DATA_DIR, "_state");
const STATE_FILE = path.join(STATE_DIR, "last_code_by_sender.json");

// Meta Verify Token (Webhook Setup in Meta Dev Console)
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";

// WhatsApp Cloud API
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || ""; // wichtig fürs Antworten

const UNKNOWN_REPLY_TEXT =
  'Bitte Baustellennummer mit # davor senden';

// "10 Minuten Regel" vorbereiten (in späterem Schritt aktivieren)
const CODE_TTL_MS = 10 * 60 * 1000;

// =====================
// Helpers: FS + State
// =====================
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function loadState() {
  ensureDir(STATE_DIR);
  if (!fs.existsSync(STATE_FILE)) return {};
  const raw = fs.readFileSync(STATE_FILE, "utf8");
  return safeJsonParse(raw, {});
}

function saveState(state) {
  ensureDir(STATE_DIR);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

// state: { "<wa_id>": { code: "260016", ts: 1700000000000 } }
let state = loadState();

function getSenderState(sender) {
  return state?.[sender] || null;
}

function setSenderCode(sender, code) {
  state[sender] = { code, ts: Date.now() };
  saveState(state);
}

function getActiveCode(sender) {
  const st = getSenderState(sender);
  if (!st?.code) return null;

  // TTL optional (derzeit NICHT hart entfernen, nur vorbereitet)
  // Wenn du willst, können wir in Schritt 3 "nach 10 Minuten ohne neue #..." zurücksetzen.
  // if (Date.now() - st.ts > CODE_TTL_MS) return null;

  return st.code;
}

// =====================
// Helpers: WhatsApp Reply
// =====================
async function sendWhatsAppText(toWaId, text) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.warn("⚠️ Cannot reply: WHATSAPP_TOKEN or PHONE_NUMBER_ID missing.");
    return;
  }

  const url = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: toWaId,
    type: "text",
    text: { body: text },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("❌ WhatsApp send failed:", res.status, body);
  }
}

// =====================
// Helpers: Save payloads
// =====================
function todayFolder() {
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function writeJsonl(filePath, obj) {
  const line = JSON.stringify(obj);
  fs.appendFileSync(filePath, line + "\n", "utf8");
}

function normalizeCode(code) {
  return String(code).replace(/[^0-9A-Za-z_-]/g, "").trim();
}

function extractCodeFromText(text) {
  // findet z.B. "#260016" auch wenn davor/dahinter Text steht
  const m = String(text || "").match(/#([0-9A-Za-z_-]{2,})/);
  return m ? normalizeCode(m[1]) : null;
}

function getProjectDir(codeOrUnknown) {
  const code = codeOrUnknown || "unknown";
  return path.join(DATA_DIR, code, todayFolder());
}

// =====================
// Express App
// =====================
const app = express();
app.use(express.json({ limit: "20mb" }));

app.get("/", (req, res) => {
  res.status(200).send("Webhook läuft ✅");
});

// Meta Webhook Verification (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    res.status(200).send(challenge);
    return;
  }

  console.warn("❌ Webhook verification failed");
  res.sendStatus(403);
});

// Incoming Webhooks (POST)
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    // Immer sofort antworten, damit Meta nicht erneut schickt
    res.sendStatus(200);

    // Debug log (optional)
    console.log("Incoming webhook:", JSON.stringify(body));

    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const messages = value?.messages || [];
    if (!Array.isArray(messages) || messages.length === 0) return;

    const metadata = value?.metadata || {};
    const waPhoneId = metadata?.phone_number_id;

    // Nachrichten verarbeiten
    for (const msg of messages) {
      const from = msg?.from; // wa_id
      if (!from) continue;

      // 1) Text: evtl. Code setzen
      if (msg?.type === "text") {
        const text = msg?.text?.body || "";
        const code = extractCodeFromText(text);

        if (code) {
          setSenderCode(from, code);

          // Logging
          const dir = getProjectDir(code);
          ensureDir(dir);
          const logFile = path.join(dir, "log.jsonl");
          writeJsonl(logFile, {
            ts: Date.now(),
            from,
            type: "text",
            body: text,
            note: `code_set:${code}`,
          });

          console.log(`✅ saved text for #${code} -> ${logFile}`);
          continue;
        }

        // Kein Code im Text: je nach aktivem Code speichern
        const active = getActiveCode(from);
        const codeOrUnknown = active || "unknown";
        const dir = getProjectDir(codeOrUnknown);
        ensureDir(dir);

        const logFile = path.join(dir, "log.jsonl");
        writeJsonl(logFile, {
          ts: Date.now(),
          from,
          type: "text",
          body: text,
        });

        console.log(`✅ saved text for #${codeOrUnknown} -> ${logFile}`);

        if (!active) {
          await sendWhatsAppText(from, UNKNOWN_REPLY_TEXT);
        }
        continue;
      }

      // 2) Bilder (image)
      if (msg?.type === "image") {
        const active = getActiveCode(from);
        const codeOrUnknown = active || "unknown";

        const dir = getProjectDir(codeOrUnknown);
        ensureDir(dir);

        // Wir speichern erstmal nur METADATEN (kein Download des Bildes hier)
        // -> Bild-Download machen wir im nächsten Schritt, wenn du willst.
        const fileName = `${msg?.timestamp || Date.now()}_${msg?.image?.id || crypto.randomUUID()}.json`;
        const filePath = path.join(dir, fileName);

        fs.writeFileSync(
          filePath,
          JSON.stringify(
            {
              ts: Date.now(),
              from,
              type: "image",
              wa_image_id: msg?.image?.id || null,
              mime_type: msg?.image?.mime_type || null,
              sha256: msg?.image?.sha256 || null,
              caption: msg?.image?.caption || null,
              raw: msg,
            },
            null,
            2
          ),
          "utf8"
        );

        console.log(`✅ saved image meta for #${codeOrUnknown} -> ${filePath}`);

        if (!active) {
          await sendWhatsAppText(from, UNKNOWN_REPLY_TEXT);
        }
        continue;
      }

      // 3) Alles andere: speichern als raw
      const active = getActiveCode(from);
      const codeOrUnknown = active || "unknown";
      const dir = getProjectDir(codeOrUnknown);
      ensureDir(dir);

      const logFile = path.join(dir, "log.jsonl");
      writeJsonl(logFile, {
        ts: Date.now(),
        from,
        type: msg?.type || "unknown_type",
        raw: msg,
      });

      console.log(`✅ saved message type=${msg?.type} for #${codeOrUnknown} -> ${logFile}`);

      if (!active) {
        await sendWhatsAppText(from, UNKNOWN_REPLY_TEXT);
      }
    }
  } catch (err) {
    console.error("Webhook error:", err);
    // response wurde schon gesendet
  }
});

// Health
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

app.listen(PORT, () => {
  ensureDir(DATA_DIR);
  ensureDir(STATE_DIR);

  console.log(`Server läuft auf Port ${PORT}`);
  console.log(`DATA_DIR=${DATA_DIR}`);
  console.log(`STATE_FILE=${STATE_FILE}`);
  console.log(`PHONE_NUMBER_ID set: ${Boolean(PHONE_NUMBER_ID)}`);
});
