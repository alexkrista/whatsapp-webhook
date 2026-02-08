const express = require("express");
const app = express();

app.use(express.json());

// ✅ Verify Token (aus Render Environment)
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "Alex0780";

// ✅ Webhook Verifizierung (Meta ruft GET /webhook auf)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ✅ WhatsApp Events (Meta sendet POST /webhook)
app.post("/webhook", (req, res) => {
  // hier kommen WhatsApp Events rein (messages, statuses, etc.)
  console.log("Incoming webhook:", JSON.stringify(req.body));
  res.sendStatus(200);
});

// (optional) Dein eigener Endpoint für Protokoll-Uploads etc.
app.post("/webhook/whatsapp", (req, res) => {
  console.log("WhatsApp Webhook (custom):", JSON.stringify(req.body));
  res.sendStatus(200);
});

// Health Check
app.get("/", (req, res) => {
  res.send("webhook läuft");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});
