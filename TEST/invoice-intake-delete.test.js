const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerKristineInvoiceIntake, backfillInvoiceInbox } = require('../kristine-invoice-intake');

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

    const reimported = await call(app.routes.get('POST /kristine/api/invoice-intake/import'), {
      body: { name:'Umbenannt.pdf', data:Buffer.from('%PDF test').toString('base64'), source:'E-Mail' },
    });
    assert.equal(reimported.body.duplicate, true);
    assert.equal(reimported.body.suppressed, true);
    assert.equal(reimported.body.item.id, item.id);

    // Reproduce an old revival already saved before the fix.
    const itemsDir=path.join(temp,'_kristine','invoice-intake','items');
    const revived={...item,id:'revived_legacy',status:'queued',createdAt:'2099-01-01T00:00:00Z'};
    fs.writeFileSync(path.join(itemsDir,revived.id+'.json'),JSON.stringify(revived));
    assert.equal((await call(app.routes.get('GET /kristine/api/invoice-intake'))).body.count,0);

    const inboxId='mail_original', inboxDir=path.join(temp,'_kristine','inbox');
    fs.mkdirSync(path.join(inboxDir,'items'),{recursive:true});
    fs.mkdirSync(path.join(inboxDir,'files',inboxId),{recursive:true});
    fs.writeFileSync(path.join(inboxDir,'files',inboxId,'Doppelt.pdf'),'%PDF test');
    fs.writeFileSync(path.join(inboxDir,'items',inboxId+'.json'),JSON.stringify({id:inboxId,route:'invoice',mail:{to:[{email:'rechnung@krista.at'}],attachments:[{name:'Doppelt.pdf'}]}}));
    assert.equal((await backfillInvoiceInbox(temp)).files,0);
    assert.equal((await backfillInvoiceInbox(temp)).files,0);
    assert.equal((await call(app.routes.get('GET /kristine/api/invoice-intake'))).body.count,0);
    assert.equal(fs.readdirSync(itemsDir).length,2);

    const restored=await call(app.routes.get('POST /kristine/api/invoice-intake/:id/reopen'),{params:{id:item.id}});
    assert.equal(restored.body.item.status,'queued');
    const restoredList=await call(app.routes.get('GET /kristine/api/invoice-intake'));
    assert.equal(restoredList.body.count,1);
    assert.equal(restoredList.body.items[0].id,item.id);
    await call(app.routes.get('DELETE /kristine/api/invoice-intake/:id'),{params:{id:item.id},body:{reason:'Erneut entfernt'}});
    assert.equal((await call(app.routes.get('GET /kristine/api/invoice-intake'))).body.count,0);

    const genuinelyNew=await call(app.routes.get('POST /kristine/api/invoice-intake/import'),{body:{name:'NeueRechnung.pdf',data:Buffer.from('%PDF new invoice').toString('base64')}});
    assert.equal(genuinelyNew.body.duplicate,false);
    assert.equal((await call(app.routes.get('GET /kristine/api/invoice-intake'))).body.count,1);
    console.log('invoice intake archive-delete: ok');
  } finally {
    const resolved = path.resolve(temp);
    assert(resolved.startsWith(path.resolve(os.tmpdir())));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
