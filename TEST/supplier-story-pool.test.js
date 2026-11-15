"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { registerSupplierStoryPool, validateLink, detectSupplier } = require("../supplier-story-pool");

test("link checking blocks non-HTTPS and credential URLs", () => {
  assert.equal(validateLink("javascript:alert(1)"), null);
  assert.equal(validateLink("http://instagram.com/test"), null);
  assert.equal(validateLink("https://abc:pass@instagram.com/test"), null);
  assert.equal(validateLink("https://www.instagram.com/reel/abc"), "https://www.instagram.com/reel/abc");
  assert.equal(detectSupplier("https://www.instagram.com/kalkkind/"), "Kalkkind");
});
test("routes require admin and save entries without duplicate URLs", async () => {
  const routes = {};
  const app = {
    get(p, cb) { routes["GET " + p] = cb; },
    post(p, cb) { routes["POST " + p] = cb; },
    patch(p, cb) { routes["PATCH " + p] = cb; }
  };
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "krista-supplier-"));
  const file = path.join(folder, "items.json");
  const auth = (req, res) => { if (!req.allowed) { res.status(401).json({error:"No access"}); return false; } return true; };
  registerSupplierStoryPool(app, auth, { file });
  const call = (method, route, data = {}, allowed = true) => {
    let status = 200, payload = null;
    const response = {
      set() { return this; },
      status(code) { status = code; return this; },
      json(result) { payload = result; return this; }
    };
    const req = { allowed, body: data, params: {id: data.id} };
    routes[method + " " + route](req, response);
    return { status, payload };
  };
  const base = "/kristine/api/supplier-stories";
  try {
    assert.equal(call("GET", base, {}, false).status, 401);
    assert.equal(call("POST", base, {link:"https://www.instagram.com/kalkkind/"}, false).status, 401);
    assert.equal(fs.existsSync(file), false);
    assert.equal(call("POST", base, {link:"http://wrong.example"}).status, 400);
    const created = call("POST", base, {link:"https://www.instagram.com/kalkkind/",note:"Tolles Material"});
    assert.equal(created.status, 201);
    assert.equal(created.payload.item.supplier, "Kalkkind");
    assert.equal(call("POST", base, {link:"https://www.instagram.com/kalkkind/"}).status, 409);
    assert.equal(call("GET", base).payload.items.length, 1);
    const id = created.payload.item.id;
    assert.equal(call("PATCH", base+"/:id", {id,status:"ungueltig"}).status, 400);
    assert.equal(call("PATCH", base+"/:id", {id,status:"freigabe"}).status, 200);
    assert.equal(call("GET", base).payload.items[0].status, "freigabe");
    assert.equal(call("PATCH", base+"/:id", {id,supplier:"Arte",note:"Neuer Kommentar"}).status, 200);
    assert.equal(call("GET", base).payload.items[0].supplier, "Arte");
    assert.equal(call("GET", base).payload.items[0].note, "Neuer Kommentar");
    assert.equal(call("GET", base).payload.items[0].status, "freigabe");
    assert.equal(call("PATCH", base+"/:id", {id,supplier:""}).status, 400);
    assert.equal(call("GET", base, {}, false).status, 401);
  } finally { fs.rmSync(folder, {recursive:true, force:true}); }
});
