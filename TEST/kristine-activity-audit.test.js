"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { registerKristineActivityAudit, describeAction } = require("../kristine-activity-audit");

test("Aktivitätsprotokoll erfasst Einstieg und Aktionen ohne Nutzdaten", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "krista-activity-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const people = [
    { id: "alex", name: "Alexander Krista", nickname: "Alex" },
    { id: "bettina", name: "Bettina Beispiel" },
  ];
  const app = express();
  app.use(express.json());
  const requireAdmin = (req, res) => {
    if (req.headers["x-test-admin"] === "yes") return true;
    res.status(401).json({ ok: false });
    return false;
  };
  const audit = registerKristineActivityAudit(app, {
    dataDir,
    requireAdmin,
    readEmployees: async () => people,
    now: () => new Date("2026-09-18T12:34:56.000Z"),
  });
  app.post("/admin/api/job/:jobId/offer-draft/accept", (req, res) => res.json({ ok: true }));
  app.patch("/admin/api/job/:jobId/meta", (_req, res) => res.status(422).json({ ok: false }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { "Content-Type": "application/json", "x-test-admin": "yes", "X-Krista-User-Id": "alex" };

  let response = await fetch(`${base}/kristine/api/activity/session`, {
    method: "POST",
    headers,
    body: JSON.stringify({ page: "/admin/ui?token=TOP_SECRET", title: "KRISADMIN", sessionId: "visit-1" }),
  });
  assert.equal(response.status, 201);
  response = await fetch(`${base}/admin/api/job/26042/offer-draft/accept`, {
    method: "POST",
    headers,
    body: JSON.stringify({ customerName: "Nicht protokollieren", token: "DO_NOT_LOG" }),
  });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/admin/api/job/26042/meta`, { method: "PATCH", headers, body: JSON.stringify({ secret: "ALSO_PRIVATE" }) });
  assert.equal(response.status, 422);
  await audit.flush();

  const denied = await fetch(`${base}/kristine/api/activity`, { headers: { ...headers, "X-Krista-User-Id": "bettina" } });
  assert.equal(denied.status, 403);
  const allowed = await fetch(`${base}/kristine/api/activity`, { headers });
  assert.equal(allowed.status, 200);
  const payload = await allowed.json();
  assert.equal(payload.entries.length, 3);
  assert(payload.entries.some((entry) => entry.action === "Einstieg: KRISADMIN" && entry.page === "/admin/ui"));
  assert(payload.entries.some((entry) => entry.action === "Angebot als Auftrag übernommen · Baustelle 26042" && entry.statusCode === 200));
  assert(payload.entries.some((entry) => entry.action === "Baustellen-Stammdaten aktualisiert · Baustelle 26042" && entry.status === "failed"));
  const stored = await fs.readFile(audit.logFile, "utf8");
  assert(!stored.includes("DO_NOT_LOG"));
  assert(!stored.includes("ALSO_PRIVATE"));
  assert(!stored.includes("TOP_SECRET"));
  assert(!stored.includes("Nicht protokollieren"));
});

test("wichtige Geschäftsaktionen erhalten verständliche Bezeichnungen", () => {
  assert.equal(describeAction("POST", "/kristool/api/workflows/abc/create-job"), "Baustelle aus Aufgabe angelegt");
  assert.equal(describeAction("POST", "/admin/api/job/26042/customer-portal/invitations/send"), "Persönliche Kundenlinks versendet · Baustelle 26042");
  assert.equal(describeAction("POST", "/admin/api/job/26042/order-schedule/confirm"), "Auftragstermin bestätigt · Baustelle 26042");
  assert.equal(describeAction("PUT", "/kristine/api/tasks"), "Aufgaben aktualisiert");
});
