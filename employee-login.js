"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { currentActor, issueSession, revokeSession } = require("./employee-sessions");
const { sameOrigin } = require("./admin-auth");
const { isAlexander } = require("./kristine-user-access");

const { personalLoginEnabled, personalLoginAllowed } = require('./employee-login-policy');

const normalizePhone = value => {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `43${digits.slice(1)}`;
  return digits;
};

function registerEmployeeLogin(app, { dataDir, readEmployees, sendWhatsApp }) {
  const root = path.join(dataDir, "_kristine", "login-challenges");
  const inFlight = new Set();
  const key = phone => crypto.createHash("sha256").update(phone).digest("hex");
  const file = phone => path.join(root, key(phone) + ".json");
  const digest = (salt, code) => crypto.createHash("sha256").update(salt + ":" + code).digest("hex");
  const rejectOrigin = (req, res) => {
    if (sameOrigin(req)) return false;
    res.status(403).json({ ok:false, error:"Fremder Ursprung abgewiesen" });
    return true;
  };
  async function read(phone) {
    try { return JSON.parse(await fs.readFile(file(phone), "utf8")); } catch { return null; }
  }
  async function write(phone, row) {
    await fs.mkdir(root, { recursive:true });
    await fs.writeFile(file(phone), JSON.stringify(row), { mode:0o600 });
  }
  async function employeeFor(phone) {
    const rows = await readEmployees();
    const matches = (Array.isArray(rows) ? rows : []).filter(row => personalLoginAllowed(row) &&
      normalizePhone(row.phone || row.phoneNumber || row.whatsapp || row.mobile || (isAlexander(row) ? process.env.CHEF_PHONE : "")) === phone && String(row.id || row.employeeId || ""));
    return matches.length === 1 ? matches[0] : null;
  }

  app.get("/anmelden", (_req, res) => {
    if (!personalLoginEnabled()) {
      return res.status(503).type("html").send('<!doctype html><html lang="de"><meta charset="utf-8"><title>KRISTINE Anmeldung</title><body><h1>Persönliche Anmeldung wird eingerichtet</h1><p>Die Zugänge werden gerade auf die berechtigten Personen begrenzt.</p></body></html>');
    }
    res.sendFile(path.join(__dirname, "public", "anmelden.html"));
  });
  app.get("/auth/me", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const actor = currentActor(req);
    if (!actor) return res.status(401).json({ ok:false, error:"Nicht angemeldet" });
    res.json({ ok:true, user:actor });
  });
  app.post("/auth/whatsapp/start", async (req, res) => {
    if (!personalLoginEnabled()) return res.status(403).json({ ok:false, error:"Die persönliche Anmeldung wird eingerichtet." });
    if (rejectOrigin(req, res)) return;
    const phone = normalizePhone(req.body?.phone);
    if (phone.length < 9 || phone.length > 16) return res.status(400).json({ ok:false, error:"Bitte eine gültige Mobilnummer eingeben." });
    const challenge = await read(phone), now = Date.now();
    if (inFlight.has(key(phone)) || challenge?.sentAt > now - 60000 ||
        (challenge?.windowAt > now - 3600000 && challenge?.sentCount >= 5)) {
      return res.status(429).json({ ok:false, error:"Bitte kurz warten, bevor du einen weiteren Code anforderst." });
    }
    inFlight.add(key(phone));
    try {
      const employee = await employeeFor(phone);
      if (employee) {
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
        const salt = crypto.randomBytes(16).toString("hex");
        await sendWhatsApp({ to:phone, reply:`Dein KRISTINE-Anmeldecode: ${code}\nGültig für 5 Minuten. Wenn du dich nicht anmeldest, ignoriere diese Nachricht.`, buttons:[], includeGoLink:false });
        await write(phone, { employeeId:String(employee.id || employee.employeeId), salt, codeHash:digest(salt,code),
          expiresAt:now+300000, attempts:0, sentAt:now,
          windowAt:challenge?.windowAt > now-3600000 ? challenge.windowAt : now,
          sentCount:challenge?.windowAt > now-3600000 ? challenge.sentCount+1 : 1 });
      }
      // Never confirm whether a number is in the employee master.
      res.json({ ok:true, message:"Wenn diese Nummer hinterlegt ist, kommt der Code per WhatsApp." });
    } catch (error) {
      res.status(503).json({ ok:false, error:"WhatsApp konnte den Code gerade nicht zustellen. Bitte schreibe Kristine kurz eine Nachricht und versuche es erneut." });
    } finally { inFlight.delete(key(phone)); }
  });

  app.post("/auth/whatsapp/verify", async (req, res) => {
    if (!personalLoginEnabled()) return res.status(403).json({ ok:false, error:"Die persönliche Anmeldung wird eingerichtet." });
    if (rejectOrigin(req, res)) return;
    const phone = normalizePhone(req.body?.phone), code = String(req.body?.code || "").trim();
    const row = await read(phone);
    if (!/^[0-9]{6}$/.test(code) || !row || row.expiresAt <= Date.now() || row.attempts >= 5) {
      return res.status(401).json({ ok:false, error:"Code ungültig oder abgelaufen." });
    }
    row.attempts += 1;
    await write(phone, row);
    if (row.codeHash !== digest(row.salt, code)) return res.status(401).json({ ok:false, error:"Code ungültig oder abgelaufen." });
    const employee = await employeeFor(phone);
    if (!employee || String(employee.id || employee.employeeId) !== row.employeeId) {
      return res.status(401).json({ ok:false, error:"Code ungültig oder abgelaufen." });
    }
    await fs.rm(file(phone), { force:true });
    await issueSession(res, employee);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok:true });
  });

  app.post("/auth/logout", async (req, res) => {
    if (rejectOrigin(req, res)) return;
    await revokeSession(req, res);
    res.json({ ok:true });
  });
}

module.exports = { registerEmployeeLogin };
