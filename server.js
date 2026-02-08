const express = require("express");
const app = express();

app.use(express.json());

// WhatsApp Webhook Endpoint
app.post("/webhook/whatsapp", (req, res) => {
  console.log("WhatsApp Webhook:", JSON.stringify(req.body));
  res.sendStatus(200);
});

// Health Check
app.get("/", (req, res) => {
  res.send("Webhook läuft");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});

