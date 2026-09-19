"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), fsp = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const core = require("../public/ui/offer-notepad");
const clone = value => JSON.parse(JSON.stringify(value));
const sample = () => ({ offerType: "facade", notepadBlocks: [{ id: "facade", title: "Fassade", text: "(2+3)*x2x2,5-1,2+2" }], positions: [
  { text: "Gerüst", unit: "m²", unitPrice: 5, quantity: 0, quantityFormula: { blockId: "facade", factor: "1,2" } },
  { text: "Waschen", unit: "m²", unitPrice: 3, quantity: 0, quantityFormula: { blockId: "facade", factor: "1" } },
  { text: "Streichen", unit: "m²", unitPrice: 20, quantity: 0, quantityFormula: { blockId: "facade", factor: "1" } },
] });

test("user formula, comma, multiplication, parentheses and operator precedence", () => {
  assert.equal(core.evaluateExpression("(2+3)*x2x2,5-1,2+2"), 25.8);
  assert.equal(core.evaluateExpression("(2+3) × 2 × 2,5 − 1,2 + 2 ="), 25.8);
  assert.equal(core.evaluateExpression("-(2 + 3) * -2 + 10 ÷ 4"), 12.5);
  assert.equal(core.evaluateExpression("2+3*4"), 14);
  assert.equal(core.evaluateExpression(",5 x 2"), 1);
});

test("no code execution, no guessing invalid arithmetic or concatenating spaced numbers", () => {
  for (const text of ["", "2+", "(2+3", "2 3", "1,2,3", "2**3", "2xx3", "1/0", "Infinity", "Math.random()", "globalThis.hacked=1", "2;process.exit()", "2foo", "1e5"])
    assert.throws(() => core.evaluateExpression(text), undefined, text);
  assert.throws(() => core.evaluateExpression("(".repeat(45) + "1" + ")".repeat(45)));
  assert.throws(() => core.evaluateExpression("1+".repeat(501)));
});

test("block sum includes all formula lines, deductions and notes; invalid lines never give a partial total", () => {
  const result = core.calculateBlock("Fassade Nord\nNordseite: 5 x 2,5\nSüdseite: 6 x 2,5\n-2\n# Fenster abgezogen\n\n2 + 3 # Ergänzung");
  assert.equal(result.total, 30.5); assert.equal(result.count, 4);
  assert.equal(core.calculateBlock("0,1\n0,2").total, 0.3);
  assert.equal(core.calculateBlock("10\n2+").total, null);
  assert.match(core.calculateBlock("10\n2+").error, /Zeile 2/);
  assert.equal(core.calculateBlock("Nur eine Notiz").total, null);
});

test("one block drives several quantities with separate factors and never changes prices", () => {
  const draft = sample(); core.apply(draft, true);
  assert.deepEqual(draft.positions.map(p => p.quantity), [30.96, 25.8, 25.8]);
  assert.deepEqual(draft.positions.map(p => p.unitPrice), [5, 3, 20]);
  draft.notepadBlocks[0].text = "100"; core.apply(draft, true);
  assert.deepEqual(draft.positions.map(p => p.quantity), [120, 100, 100]);
  assert.ok(draft.positions.every(p => p.autoQuantityOverridden));
  draft.notepadBlocks[0].text = "1/3"; draft.positions[0].quantityFormula.factor = "3";
  core.apply(draft, true); assert.equal(draft.positions[0].quantity, 1);
});

test("invalid bound formula, factor or negative quantity keeps the previous value and blocks save", () => {
  for (const damage of [d => d.notepadBlocks[0].text = "5+", d => d.notepadBlocks[0].text = "-5", d => d.positions[0].quantityFormula.factor = "1+", d => d.positions[0].quantityFormula.factor = "-2", d => d.positions[0].quantityFormula.blockId = "missing"] ) {
    const draft = sample(); core.apply(draft, true); const savedQuantity = draft.positions[0].quantity;
    damage(draft);
    const result = core.apply(draft); assert.ok(result.errors.length);
    assert.equal(draft.positions[0].quantity, savedQuantity);
    assert.throws(() => core.prepareForSave(draft));
  }
});

test("bindings survive persistence, reordering, renaming and insertion, and can be unlinked", () => {
  const draft = sample(); core.prepareForSave(draft);
  const reopened = clone(draft);
  reopened.positions.reverse(); reopened.positions[0].text = "Fassade streichen";
  reopened.positions.splice(1, 0, { text: "Unabhängige Position", unit: "PA", quantity: 7 });
  reopened.notepadBlocks[0].text = "50"; core.prepareForSave(reopened);
  assert.deepEqual(reopened.positions.map(p => p.quantity), [50, 7, 50, 60]);
  delete reopened.positions[0].quantityFormula; reopened.notepadBlocks[0].text = "20"; core.apply(reopened, true);
  assert.deepEqual(reopened.positions.map(p => p.quantity), [50, 7, 20, 24]);
});

test("two blocks have independent totals; saving an unfinished unassigned note is allowed", () => {
  const draft = sample(); draft.notepadBlocks.push({ id: "south", title: "Süd", text: "10\n5" }, { id: "later", title: "Später", text: "2+" });
  draft.positions[1].quantityFormula.blockId = "south"; core.prepareForSave(draft);
  assert.deepEqual(draft.positions.map(p => p.quantity), [30.96, 15, 25.8]);
  assert.equal(draft.notepadBlocks[2].text, "2+");
});

test("server does not trust client totals or silently truncate mathematical expressions", () => {
  const input = sample(); input.positions[0].quantity = 999; input.notepadBlocks[0].total = 999;
  const sanitized = { offerType: "facade", positions: input.positions.map(p => ({ text: p.text, unit: p.unit, quantity: p.quantity })) };
  core.prepareForSave(sanitized, input);
  assert.equal(sanitized.positions[0].quantity, 30.96); assert.equal(sanitized.notepadBlocks[0].total, undefined);
  assert.throws(() => core.sanitizeBlocks([{ id: "a", text: "1".repeat(12001) }]));
  assert.throws(() => core.sanitizeBlocks([{ id: "same" }, { id: "same" }]));
});

test("legacy room recalculation preserves bound quantities, including during incomplete editing", () => {
  const source = fs.readFileSync(path.join(__dirname, "../public/ui/baustellen-offer-builder.js"), "utf8");
  const fn = source.slice(source.indexOf("function syncPositions("), source.indexOf("function calculatedPrice("));
  const draft = sample(); core.apply(draft, true); draft.notepadBlocks[0].text = "2+";
  const context = { draft, positions: () => draft.positions.map(p => ({ text: p.text, quantity: 999 })), renderPositions: () => core.apply(draft), renderAreaResult() {} };
  vm.runInNewContext(fn + ";syncPositions(true)", context);
  assert.deepEqual(Array.from(draft.positions, p => p.quantity), [30.96, 25.8, 25.8]);
});

test("existing regie material calculation cannot be assigned a second quantity rule", () => {
  const draft = sample(); draft.offerType = "regie_material";
  draft.positions[0].text = "Material und Maschinen für Regiearbeiten";
  assert.throws(() => core.prepareForSave(draft), /Materialmenge/);
});

test("actual offer API stores blocks and factor bindings, reads them back and refuses invalid overwrites", async t => {
  const express = require("express"), app = express(); app.use(express.json());
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "offer-notepad-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const routes = source.slice(source.indexOf('app.get("/admin/api/job/:jobId/offer-draft",'), source.indexOf('app.post("/admin/api/job/:jobId/offer-draft/finalize"'));
  const helper = source.slice(source.indexOf("function sanitizeOfferCalculationNote("), source.indexOf("const offerCounterPath="));
  vm.runInNewContext(helper + routes, { app, fsp, path, DATA_DIR: dir, offerNotepad: core, cleanOfferSchedule:require("../offer-scheduling").cleanOfferSchedule,
    positionId: require("../offer-order-workflow").positionId,
    requireAdmin(req, res) { if (req.get("x-test-admin") === "yes") return true; res.status(403).json({ ok: false }); return false; },
    isSafeJobId: id => /^[A-Za-z0-9_-]+$/.test(id), offerDraftPath: id => path.join(dir, id, ".offer-draft.json"),
    ensureDir: folder => fsp.mkdir(folder, { recursive: true }), appendJobHistory: async () => {},
  });
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/admin/api/job/test-offer/offer-draft`;
  const request = (method, body, admin = true) => fetch(url, { method, headers: { "Content-Type": "application/json", ...(admin ? { "x-test-admin": "yes" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request("PUT", sample(), false)).status, 403);
  const saved = await request("PUT", sample()); assert.equal(saved.status, 200);
  const reopened = (await (await request("GET")).json()).draft;
  assert.equal(reopened.notepadBlocks[0].text, "(2+3)*x2x2,5-1,2+2");
  assert.deepEqual(reopened.positions.map(p => p.quantity), [30.96, 25.8, 25.8]);
  assert.equal(reopened.positions[0].quantityFormula.factor, "1,2");
  reopened.positions.reverse(); reopened.notepadBlocks[0].text = "50";
  assert.equal((await request("PUT", reopened)).status, 200);
  const correct = (await (await request("GET")).json()).draft;
  assert.deepEqual(correct.positions.map(p => p.quantity), [50, 50, 60]);
  const invalid = clone(correct); invalid.notepadBlocks[0].text = "10+";
  const rejected = await request("PUT", invalid); assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /Rechnung|Zahl/);
  assert.deepEqual((await (await request("GET")).json()).draft, correct);
});
