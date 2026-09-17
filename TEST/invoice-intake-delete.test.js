const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerKristineInvoiceIntake } = require('../kristine-invoice-intake');

function appStub() {
  const routes = new Map();
  return {
    routes,
    post(url, handler) { routes.set(`POST ${url}`, handler); },
    get(url, handler) { routes.set(`GET ${url}`, handler); },
    delete(url, handler) { routes.set(`DELETE ${url}`, handler); },
  };
}

async function call(handler, req = {}) {
  let status = 200;
  let body;
  const res = {
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
    setHeader() {},
    sendFile() {},
    send(value) { body = value; return this; },
  };
  await handler({ body: {}, query: {}, params: {}, ...req }, res);
  return { status, body };
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'krista-intake-delete-'));
  try {
    const app = appStub();
    registerKristineInvoiceIntake(app, { dataDir: temp, requireAdmin: () => true });

    const imported = await call(app.routes.get('POST /kristine/api/invoice-intake/import'), {
      body: {
        name: 'Doppelt.pdf',
        type: 'application/pdf',
        data: Buffer.from('%PDF test').toString('base64'),
        submittedByName: 'Bettina',
      },
    });
    assert.equal(imported.status, 200);
    assert.equal(imported.body.ok, true);
    const item = imported.body.item;

    const removed = await call(app.routes.get('DELETE /kristine/api/invoice-intake/:id'), {
      params: { id: item.id },
      body: { reason: 'Doppelt eingegangen', deletedBy: 'Bettina' },
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.archived, true);
    assert.equal(removed.body.filesPreserved, true);

    const visible = await call(app.routes.get('GET /kristine/api/invoice-intake'));
    assert.equal(visible.body.count, 0);
    const archived = await call(app.routes.get('GET /kristine/api/invoice-intake'), { query: { includeProcessed: 'true' } });
    assert.equal(archived.body.items[0].status, 'deleted');
    assert.equal(archived.body.items[0].deleteReason, 'Doppelt eingegangen');

    const stored = path.join(temp, '_kristine', 'invoice-intake', 'files', item.id, item.storedFilename);
    assert.equal(fs.existsSync(stored), true);
    console.log('invoice intake archive-delete: ok');
  } finally {
    const resolved = path.resolve(temp);
    assert(resolved.startsWith(path.resolve(os.tmpdir())));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
