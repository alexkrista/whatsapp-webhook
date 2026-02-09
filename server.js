const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 10000;
const DATA_DIR = process.env.DATA_DIR || "/var/data";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";

const STATE_DIR = path.join(DATA_DIR, "_state");
const STATE_FILE = path.join(STATE_DIR, "last_code_by_sender.json");

const UNASSIGNED_DIRNAME = "_unassigned";

const LAST_CODE_BY_SENDER = new Map();

// -------- Helpers --------
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const obj = JSON.parse(raw);
    for (const [sender, v] of Object.entries(obj)) {
      if (v?.code) LAST_CODE_BY_SENDER.set(sender, v);
    }
    console.log(`✅ state loaded: ${LAST_CODE_BY_SENDER.size} senders`);
  } catch (e) {
    console.log("⚠️ state load failed (ignored):", e.message);
  }
}

function saveState() {
  try {
    ensureDir(STATE_DIR);
    const obj = {};
    for (const [sender, v] of LAST_CODE_BY_SENDER.entries()) obj[sender] = v;
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.log("⚠️ state save failed (ignored):", e.message);
  }
}

function ymdFromTsSeconds(tsSeconds) {
  const d = tsSeconds ? new Date(Number(tsSeconds) * 1000) : new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function extractCode(text) {
  const m = (text || "").match(/#(\d{3,})\b/);
  return m ? m[1] : null;
}

function appendJsonl(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
}

function extFromMime(mime) {
  if (!mime) return "";
  const map = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
  };
  return map[mime] || "";
}

function safeName(name) {
  return String(name || "").replace(/[^\w.\-]+/g, "_").slice(0, 160);
}

async function graphGetJson(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Graph GET failed ${res.status}: ${txt}`);
  }
  return res.json();
}

async function graphDownloadBuffer(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Download failed ${res.status}: ${txt}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function downloadWhatsAppMedia(mediaId) {
  if (!WHATSAPP_TOKEN) throw new Error("WHATSAPP_TOKEN missing");
  const meta = await graphGetJson(`https://graph.facebook.com/v22.0/${mediaId}`);
  if (!meta.url) throw new Error("No media url from Meta");
  const buffer = await graphDownloadBuffer(meta.url);
  return { buffer, mimeType: meta.mime_type || "" };
}

// ✅ Zusatz: Hinweis ins Log, wenn unassigned
function writeUnassignedHint(logPath, from) {
  appendJsonl(logPath, {
    kind: "system_hint",
    ts: Math.floor(Date.now() / 1000),
    from,
    message:
      "⚠️ Kein Baustellencode gesetzt. Bitte zuerst eine Nachricht wie '#260016' senden, dann Fotos/Audio.",
  });
}

// -------- Routes --------
app.get("/", (req, res) => res.status(200).send("webhook läuft ✅"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const payload = req.body;
    const entry = payload?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const messages = value?.messages || [];
    const contacts = value?.contacts || [];
    const contactName = contacts?.[0]?.profile?.name || null;

    if (!messages.length) return;

    for (const msg of messages) {
      const from = msg.from || "unknown_sender";
      const ts = msg.timestamp ? Number(msg.timestamp) : Math.floor(Date.now() / 1000);
      const day = ymdFromTsSeconds(ts);

      const text =
        msg.type === "text"
          ? (msg.text?.body || "")
          : (msg.image?.caption || msg.video?.caption || msg.document?.caption || "");

      // Code setzen, wenn vorhanden
      const newCode = extractCode(text);
      if (newCode) {
        LAST_CODE_BY_SENDER.set(from, { code: newCode, setAt: Date.now() });
        saveState();
      }

      const current = LAST_CODE_BY_SENDER.get(from);
      const code = current?.code || UNASSIGNED_DIRNAME;

      const dayDir = path.join(DATA_DIR, code, day);
      ensureDir(dayDir);

      const logPath = path.join(dayDir, "log.jsonl");

      // ✅ wenn unassigned: einmal Hinweis schreiben (nur bei der jeweiligen Nachricht)
      if (code === UNASSIGNED_DIRNAME) {
        writeUnassignedHint(logPath, from);
      }

      appendJsonl(logPath, {
        kind: "message",
        ts,
        from,
        contactName,
        msgId: msg.id || null,
        type: msg.type,
        text: text || null,
        assigned_code: code,
      });

      const mediaTypes = ["image", "document", "audio", "video", "sticker"];
      if (mediaTypes.includes(msg.type)) {
        const mediaObj = msg[msg.type];
        const mediaId = mediaObj?.id;

        if (!mediaId) {
          appendJsonl(logPath, { kind: "media_error", ts, type: msg.type, error: "No media id found" });
          continue;
        }

        try {
          const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId);
          const ext = extFromMime(mimeType) || "";

          const filename =
            msg.type === "document" && mediaObj?.filename
              ? safeName(mediaObj.filename)
              : `${ts}_${from}_${mediaId}${ext}`;

          const outPath = path.join(dayDir, filename);
          fs.writeFileSync(outPath, buffer);

          appendJsonl(logPath, {
            kind: "media_saved",
            ts,
            type: msg.type,
            mediaId,
            mimeType,
            file: filename,
          });

          console.log(`✅ saved ${msg.type} for #${code} -> ${outPath}`);
        } catch (e) {
          appendJsonl(logPath, {
            kind: "media_error",
            ts,
            type: msg.type,
            mediaId,
            error: String(e?.message || e),
          });
          console.log(`❌ media download failed for #${code}: ${e?.message || e}`);
        }
      }

      if (msg.type === "text") console.log(`✅ saved message for #${code} -> ${logPath}`);
    }
  } catch (err) {
    console.error("❌ webhook handler error:", err);
  }
});

app.get("/admin/last", (req, res) => {
  const out = {};
  for (const [sender, v] of LAST_CODE_BY_SENDER.entries()) out[sender] = v;
  res.json(out);
});

// Start
ensureDir(DATA_DIR);
loadState();

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
  console.log(`DATA_DIR=${DATA_DIR}`);
  console.log(`STATE_FILE=${STATE_FILE}`);
});
