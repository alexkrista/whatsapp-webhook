"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
test("offer lookup and PDF import use the permitted office connection when localhost is unavailable", async () => {
  const requests = [], window = {}, origin = "https://protokoll.krista.at";
  const fetch = async (raw, options = {}) => {
    const url = new URL(raw, origin); requests.push({ url, options });
    if (url.hostname === "127.0.0.1") throw new TypeError("Failed to fetch");
    if (url.origin === origin) return { ok: true, text: async () => JSON.stringify({ permit: "short-lived-permit" }) };
    assert.equal(options.headers["X-Krista-Brain-Permit"], "short-lived-permit");
    assert.equal(options.headers["X-Krista-Token"], undefined);
    if (url.pathname === "/pdf") return { ok: true, blob: async () => new Blob(["%PDF-test"], { type: "application/pdf" }) };
    assert.equal(options.method, "POST"); assert.equal(JSON.parse(options.body).projectNumber, "2606109");
    return { ok: true, text: async () => JSON.stringify({ ok: true, billing: { projectIndex: 123 } }) };
  };
  const source = fs.readFileSync(path.join(__dirname, "../public/ui/baustellen-calculation-v2.js"), "utf8").replace("  window.KristaOrderCalculation=", "  window.testOffer={brainJson,fetchWwOfferFile};\n  window.KristaOrderCalculation=");
  vm.runInNewContext(source, { window, document: { readyState: "loading", addEventListener() {} }, location: { origin, search: "?token=admin-test" }, URL, URLSearchParams, fetch, AbortSignal, File, Blob });
  const data = await window.testOffer.brainJson("/api/outgoing/project-billing", { method: "POST", body: JSON.stringify({ projectNumber: "2606109" }), headers: { "Content-Type": "application/json" } });
  assert.equal(data.billing.projectIndex, 123);
  const file = await window.testOffer.fetchWwOfferFile({ path: "N:\\Angebote\\Jansen.pdf", filename: "Jansen.pdf" });
  assert.equal(file.name, "Jansen.pdf"); assert.equal(await file.text(), "%PDF-test");
  assert.deepEqual(requests.filter(row => row.url.origin === origin).map(row => row.url.searchParams.get("path")), ["/api/outgoing/project-billing", "/pdf"]);
});
