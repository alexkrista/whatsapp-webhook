"use strict";

const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const Module = require("module");
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "pdf-lib") return { PDFDocument: {}, StandardFonts: {}, rgb() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const { registerKristine } = require("../kristine");
Module._load = originalLoad;

function appHarness() {
  const routes = new Map();
  const app = {};
  for (const method of ["get", "post", "patch", "put", "delete"]) {
    app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  }
  return { app, routes };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

async function call(routes, method, route, { body = {}, params = {} } = {}) {
  const handler = routes.get(`${method} ${route}`);
  assert(handler, `Route missing: ${method} ${route}`);
  const res = response();
  await handler({ body, params, query: {} }, res);
  return res;
}

(async () => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "material-request-lifecycle-"));
  const root = path.join(temporary, "_kristine");
  const storage = path.join(root, "material-requests.json");
  await fsp.mkdir(root, { recursive: true });
  await fsp.writeFile(storage, JSON.stringify([
    { id: "mat-1", materialText: "Terra Icon", status: "ordered" },
    { id: "mat-2", materialText: "3m gold", status: "ordered" },
  ]));

  const { app, routes } = appHarness();
  registerKristine(app, {
    dataDir: temporary,
    publicDir: temporary,
    requireAdmin: () => true,
    readEmployees: async () => [],
  });

  try {
    const complete = await call(routes, "PATCH", "/kristine/api/material-requests/:id", {
      params: { id: "mat-1" },
      body: { status: "completed" },
    });
    assert.equal(complete.statusCode, 200);
    assert.equal(complete.body.request.status, "completed");

    const remove = await call(routes, "DELETE", "/kristine/api/material-requests/:id", {
      params: { id: "mat-2" },
    });
    assert.equal(remove.statusCode, 200);
    assert.equal(remove.body.deletedId, "mat-2");

    const stored = JSON.parse(await fsp.readFile(storage, "utf8"));
    assert.deepEqual(stored.map(row => [row.id, row.status]), [["mat-1", "completed"]]);

    const missing = await call(routes, "DELETE", "/kristine/api/material-requests/:id", {
      params: { id: "does-not-exist" },
    });
    assert.equal(missing.statusCode, 404);

    const ui = fs.readFileSync(path.join(__dirname, "..", "public", "material-admin.html"), "utf8");
    assert.match(ui, /setRequestFilter\('completed'/);
    assert.match(ui, /wirklich endgültig löschen/);
    assert.doesNotMatch(ui, /deleteMaterialRequest[^}]+class=\"[^\"]*(red|danger)/s);
    console.log("OK: Materialbedarf kann erledigt, wiedergefunden und nach Rückfrage gelöscht werden");
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
