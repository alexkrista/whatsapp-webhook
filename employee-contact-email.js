"use strict";

const fsp = require("fs/promises");
const path = require("path");

function registerEmployeeContactEmail(app, { dataDir, requireAdmin, readEmployees }) {
  const file = path.join(dataDir, "_kristine", "employee-contact-emails.json");

  async function readJson() {
    try { return JSON.parse(await fsp.readFile(file, "utf8")); }
    catch { return { emails: {} }; }
  }

  async function writeJson(value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify(value, null, 2), "utf8");
  }

  async function employeeExists(employeeId) {
    if (typeof readEmployees !== "function") return true;
    const rows = await readEmployees().catch(() => []);
    return (rows || []).some(e => String(e?.id || e?.employeeId || "") === String(employeeId || ""));
  }

  app.get("/kristine/api/employee-emails", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const data = await readJson();
      res.json({ ok: true, emails: data.emails || {} });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.put("/kristine/api/employee-emails/:employeeId", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const employeeId = String(req.params.employeeId || "").trim().slice(0, 100);
      if (!employeeId) return res.status(400).json({ ok: false, error: "Mitarbeiter fehlt." });
      if (!(await employeeExists(employeeId))) return res.status(404).json({ ok: false, error: "Mitarbeiter nicht gefunden." });

      const email = String(req.body?.email || "").trim().slice(0, 180);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ ok: false, error: "Ungültige E-Mail-Adresse." });
      }

      const data = await readJson();
      data.emails = data.emails || {};
      if (email) data.emails[employeeId] = email;
      else delete data.emails[employeeId];
      data.updatedAt = new Date().toISOString();
      await writeJson(data);
      res.json({ ok: true, employeeId, email });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  console.log("✅ Mitarbeiter-Mailadressen registriert");
}

module.exports = { registerEmployeeContactEmail };
