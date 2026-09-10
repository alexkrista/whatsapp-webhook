"use strict";
// Run with jsdom@26.1.0 installed (also covered by the return hardware workflow).
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { registerPaintLab } = require("../paint-lab");

(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "return-colour-test-"));
  const root = path.join(dataDir, "_kristine", "paint");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "innovatint-catalog.json"), JSON.stringify({ colors: [
    { colourId: 1, colourCode: "Rolling Fog Pale 158", altColourCode: "LG-OLD-7158" },
    { colourId: 2, colourCode: "Rolling Fog 143", altColourCode: "143" },
    { colourId: 3, colourCode: "Rolling Fog Dark 160", altColourCode: "160" },
    { colourId: 4, colourCode: "RAL 9010", altColourCode: "Reinweiß" },
    { colourId: 5, colourCode: "NCS S 0500-N", altColourCode: "Neutral White" },
  ] }));
  const routes = new Map();
  registerPaintLab({ get: (route, handler) => routes.set(route, handler), post() {}, put() {}, delete() {} }, { dataDir });
  const dom = new JSDOM('<div class="tabs"></div><div class="wrap"></div>', {
    url: "https://example.test/paint?token=colour-test", runScripts: "outside-only",
  });
  const w = dom.window;
  const el = (id) => w.document.getElementById(id);
  const observers = [];
  const Observer = w.MutationObserver;
  w.MutationObserver = class extends Observer {
    constructor(callback) { super(callback); observers.push(this); }
  };
  const response = (data, ok = true) => ({ ok, status: ok ? 200 : 503,
    json: async () => data, clone: () => response(data, ok) });
  const requests = [];
  let held = null;
  let heldQuery = "";
  let failSystems = [];
  let customRows = null;
  w.fetch = async (url) => {
    const u = new URL(url, w.location.href);
    requests.push(u);
    if (u.pathname.endsWith("/search")) {
      assert.equal(u.searchParams.get("token"), "colour-test");
      const system = u.searchParams.get("system");
      if (heldQuery && u.searchParams.get("q") === heldQuery && system === "LG") {
        await new Promise((resolve) => { held = resolve; });
      }
      if (failSystems.includes(system)) return response({ ok: false, error: "offline" }, false);
      if (customRows) return response({ results: system === "LG" ? customRows : [] });
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; } };
      await routes.get("/admin/api/paint/search")({ query: Object.fromEntries(u.searchParams), headers: {} }, res);
      return response(res.data, res.statusCode === 200);
    }
    if (u.pathname.endsWith("/jobs")) return response({ jobs: [] });
    if (u.pathname.endsWith("/materials")) return response({ materials: [] });
    if (u.pathname.endsWith("/lookup")) return response({ known: true, material: { manufacturer: "Sto", material: "StoSil" } });
    return response({ items: [] });
  };
  const wait = (ms = 190) => new Promise((resolve) => setTimeout(resolve, ms));
  const type = (value) => {
    el("returnColour").value = value;
    el("returnColour").dispatchEvent(new w.Event("input", { bubbles: true }));
  };
  const key = (value) => el("returnColour").dispatchEvent(new w.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
  const options = () => [...el("returnColourResults").querySelectorAll('[role="option"]')];
  try {
    for (const file of ["paint-return-stock-ui.js", "paint-return-enhancements-ui.js"]) {
      w.eval(await fs.readFile(path.join(__dirname, "../public", file), "utf8"));
    }
    el("returnStockTabBtn").click();
    el("returnEan").value = "9001234567890";
    await el("returnLookupBtn").onclick();
    await wait();
    assert.equal(el("returnColour").hasAttribute("list"), false);
    assert.equal(el("returnColourList"), null);
    // Use the real main-search handler, including normalized names, numbers and altCode.
    for (const [query, expected] of [
      ["rolling", "Rolling Fog Pale 158"], ["158", "Rolling Fog Pale 158"],
      ["  pAlE rolling  ", "Rolling Fog Pale 158"], ["lg old 7158", "Rolling Fog Pale 158"],
      ["9010", "RAL 9010"], ["reinweiß", "RAL 9010"],
      ["0500 n", "NCS S 0500-N"], ["neutral white", "NCS S 0500-N"],
    ]) {
      type(query);
      await wait();
      const hit = options().find((node) => node.querySelector("b").textContent === expected);
      assert.ok(hit, `search ${query} finds ${expected} even for non-LG material`);
      hit.click();
      assert.equal(el("returnColour").value, expected);
      assert.equal(el("returnColourResults").hidden, true);
    }
    assert.deepEqual([...new Set(requests.filter((u) => u.pathname.endsWith("/search")).map((u) => u.searchParams.get("system")))].sort(), ["LG", "NCS", "RAL"]);

    let weighEnter = 0;
    el("returnColour").addEventListener("keydown", (event) => { if (event.key === "Enter") weighEnter++; });
    type("rolling"); await wait();
    key("ArrowUp");
    const selected = options().find((node) => node.getAttribute("aria-selected") === "true");
    assert.ok(selected);
    assert.equal(el("returnColour").getAttribute("aria-activedescendant"), selected.id);
    key("Enter");
    assert.equal(el("returnColour").value, selected.querySelector("b").textContent);
    assert.equal(weighEnter, 0, "selecting does not trigger the scale Enter handler");
    key("Enter");
    assert.equal(weighEnter, 1, "Enter after selection still reaches the scale");

    type("158"); await wait(); key("Escape");
    assert.equal(el("returnColourResults").hidden, true);
    assert.equal(el("returnColour").getAttribute("aria-expanded"), "false");
    type("missing colour"); await wait();
    assert.equal(options().length, 0);
    assert.match(el("returnColourResults").textContent, /Keine passende Farbe/);
    assert.equal(el("returnColour").value, "missing colour");

    heldQuery = "rolling";
    type("rolling"); await wait();
    assert.ok(held);
    type("158");
    held(); heldQuery = "";
    await wait(25);
    assert.equal(el("returnColourResults").hidden, true, "old response cannot reopen during debounce");
    await wait();
    assert.equal(options().length, 1);
    assert.match(options()[0].textContent, /Pale 158/);

    for (const dismiss of [
      () => type(""), () => key("Escape"), () => el("returnColour").blur(),
      () => { el("returnMaterialCard").hidden = true; },
      () => { el("returnMaterialNameView").textContent = "Different material"; },
    ]) {
      el("returnMaterialCard").hidden = false;
      el("returnColour").focus(); await wait(5);
      held = null; heldQuery = "rolling";
      type("rolling"); await wait(); assert.ok(held);
      dismiss(); await wait(5); held(); heldQuery = ""; await wait(25);
      assert.equal(el("returnColourResults").hidden, true, "dismissal invalidates pending requests");
    }

    el("returnMaterialCard").hidden = false;
    await wait(5);
    failSystems = ["RAL"];
    type("158"); await wait();
    assert.equal(options().length, 1, "partial API failure preserves other results");
    assert.match(el("returnColourResults").textContent, /RAL nicht verfügbar/);
    failSystems = ["LG", "RAL", "NCS"];
    type("158"); await wait();
    assert.equal(options().length, 0);
    assert.match(el("returnColourResults").textContent, /nicht verfügbar/);
    failSystems = [];
    customRows = [{ code: "Canonical 7", name: '<img src=x onerror="alert(1)">', altCode: "old7" }];
    type("old7"); await wait();
    assert.equal(el("returnColourResults").querySelector("img"), null, "API strings are rendered as text");
    options()[0].click();
    assert.equal(el("returnColour").value, "Canonical 7");
    assert.equal(requests.some((u) => u.pathname.endsWith("/print")), false);
    console.log("OK: Return colour search, real LG/RAL/NCS API matching, canonical selection, keyboard/scale interaction, races, dismissal, errors and safe rendering.");
  } finally {
    observers.forEach((observer) => observer.disconnect());
    w.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
