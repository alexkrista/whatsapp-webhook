"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const validStatuses = new Set(["idee", "gestaltung", "freigabe", "freigegeben", "geplant", "veroeffentlicht"]);
const suppliers = [
  ["littlegreene", "Little Greene"], ["kalkkind", "Kalkkind"],
  ["artewalls", "Arte"], ["glamora", "Glamora"],
  ["instabilelab", "Instabilelab"], ["omexco", "Omexco"],
  ["wallanddeco", "Wall&decò"], ["terralilia", "Terra Lilia"]
];
function detectSupplier(link) {
  const lower = link.toLowerCase();
  const matched = suppliers.find(([term]) => lower.includes(term));
  return matched ? matched[1] : "Lieferant noch zuordnen";
}
function validateLink(input) {
  if (typeof input !== "string" || input.length > 1800) return null;
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
}
function registerSupplierStoryPool(app, requireAdmin, options = {}) {
  const file = options.file || path.join(__dirname, "data", "supplier-story-items.json");
  const load = () => {
    try {
      const content = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(content) ? content : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  const save = (items) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
    try {
      fs.writeFileSync(temp, JSON.stringify(items, null, 2), "utf8");
      fs.renameSync(temp, file);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  };
  app.get("/kristine/api/supplier-stories", (req, res) => {
    if (!requireAdmin(req, res)) return;
    try { res.set("Cache-Control", "no-store").json({ items: load() }); }
    catch { res.status(500).json({ error: "Ideenpool konnte nicht gelesen werden." }); }
  });
  app.post("/kristine/api/supplier-stories", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const link = validateLink(req.body?.link);
    if (!link) return res.status(400).json({ error: "Bitte einen gültigen HTTPS-Link einfügen." });
    const note = String(req.body?.note || "").slice(0, 1200);
    const supplier = String(req.body?.supplier || "").trim().slice(0, 90) || detectSupplier(link);
    try {
      const items = load();
      if (items.some((x) => x.link === link)) return res.status(409).json({ error: "Dieser Link ist bereits im Pool." });
      const item = { id: crypto.randomUUID(), link, supplier, note, status: "idee", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      items.unshift(item); save(items);
      res.status(201).json({ item });
    } catch { res.status(500).json({ error: "Idee konnte nicht gespeichert werden." }); }
  });
  app.patch("/kristine/api/supplier-stories/:id", (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!validStatuses.has(req.body?.status)) return res.status(400).json({ error: "Unbekannter Status." });
    try {
      const items = load();
      const item = items.find((x) => x.id === req.params.id);
      if (!item) return res.status(404).json({ error: "Eintrag nicht gefunden." });
      item.status = req.body.status;
      item.updatedAt = new Date().toISOString();
      save(items); res.json({ item });
    } catch { res.status(500).json({ error: "Status konnte nicht gespeichert werden." }); }
  });
}
module.exports = { registerSupplierStoryPool, validateLink, detectSupplier };
