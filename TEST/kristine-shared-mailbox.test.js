"use strict";

const assert = require("assert");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { registerKristineInbox } = require("../kristine-inbox");
const { installKristineSharedMailbox } = require("../kristine-shared-mailbox");

function harness() {
  const routes = new Map();
  const app = {};
  for (const method of ["get", "post"]) app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  return { app, routes };
}

function response() {
  return {
    statusCode:200,
    body:null,
    status(code){ this.statusCode = code; return this; },
    json(value){ this.body = value; return this; },
  };
}

async function call(routes, method, route, body = {}) {
  const handler = routes.get(`${method} ${route}`);
  assert(handler, `Route missing: ${method} ${route}`);
  const res = response();
  await handler({ body, params:{}, query:{} }, res);
  return res;
}

(async () => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "kristine-shared-mailbox-test-"));
  const originalFetch = global.fetch;
  const { app, routes } = harness();
  registerKristineInbox(app, { dataDir:temporary, requireAdmin:() => true });
  const deltaLink = "https://graph.microsoft.com/v1.0/delta-next";
  let firstDelta = true;
  global.fetch = async (url) => {
    const value = String(url);
    if (value.includes("/mailFolders/inbox/messages/delta")) {
      firstDelta = false;
      return new Response(JSON.stringify({ value:[{
        id:"message-1", internetMessageId:"<message-1@example.test>", subject:"Rechnung 4711",
        receivedDateTime:"2026-09-12T08:30:00Z", sentDateTime:"2026-09-12T08:29:00Z", hasAttachments:true,
        from:{ emailAddress:{ name:"Lieferant", address:"rechnung@example.test" } },
        toRecipients:[{ emailAddress:{ name:"Kristine", address:"rechnung@krista.at" } }], ccRecipients:[],
        body:{ contentType:"html", content:"<p>Bitte Rechnung prüfen.</p>" }, bodyPreview:"Bitte Rechnung prüfen.",
      }], "@odata.deltaLink":deltaLink }), { status:200, headers:{ "Content-Type":"application/json" } });
    }
    if (value === deltaLink) return new Response(JSON.stringify({ value:[], "@odata.deltaLink":deltaLink }), { status:200, headers:{ "Content-Type":"application/json" } });
    if (value.endsWith("/messages/message-1/$value")) return new Response("Subject: Rechnung 4711\r\nFrom: Lieferant <rechnung@example.test>\r\n\r\nBitte Rechnung prüfen.", { status:200, headers:{ "Content-Type":"message/rfc822" } });
    if (value.endsWith("/messages/message-1/attachments?$select=id,name,contentType,size,isInline")) return new Response(JSON.stringify({ value:[{ id:"attachment-1", name:"Rechnung-4711.pdf", contentType:"application/pdf", size:4, isInline:false }] }), { status:200, headers:{ "Content-Type":"application/json" } });
    if (value.endsWith("/messages/message-1/attachments/attachment-1")) return new Response(JSON.stringify({ id:"attachment-1", name:"Rechnung-4711.pdf", contentType:"application/pdf", contentBytes:Buffer.from("PDF!").toString("base64") }), { status:200, headers:{ "Content-Type":"application/json" } });
    throw new Error(`Unexpected URL: ${value}`);
  };

  const mailbox = installKristineSharedMailbox(app, {
    dataDir:temporary,
    requireAdmin:() => true,
    accessToken:async () => "access-token",
    logger:{ log(){}, warn(){} },
    initialDelayMs:3600000,
    pollMs:3600000,
  });
  try {
    const synced = await call(routes, "POST", "/kristine/api/mailbox/sync");
    assert.equal(synced.statusCode, 200);
    assert.equal(synced.body.imported, 1);
    assert.equal(firstDelta, false);

    const listed = await call(routes, "GET", "/kristine/api/inbox");
    assert.equal(listed.body.items.length, 1);
    const item = listed.body.items[0];
    assert.equal(item.source.mailbox, "kristine@krista.at");
    assert.equal(item.analysis.recommended, "invoice");
    assert.equal(item.mail.senderEmail, "rechnung@example.test");
    assert.equal(item.mail.attachments[0].name, "Rechnung-4711.pdf");
    const attachment = path.join(temporary, "_kristine", "inbox", "files", item.id, item.mail.attachments[0].storedFilename);
    assert.equal(await fsp.readFile(attachment, "utf8"), "PDF!");

    const second = await call(routes, "POST", "/kristine/api/mailbox/sync");
    assert.equal(second.body.imported, 0);
    const listedAgain = await call(routes, "GET", "/kristine/api/inbox");
    assert.equal(listedAgain.body.items.length, 1, "Delta sync must not duplicate an imported mail");
    console.log("OK: shared mailbox mail and attachment arrive once in KRISTINE Eingang");
  } finally {
    mailbox.stop();
    global.fetch = originalFetch;
    await fsp.rm(temporary, { recursive:true, force:true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
