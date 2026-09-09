"use strict";

const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const Module = require("module");
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "pdf-lib") return { PDFDocument:{}, StandardFonts:{}, rgb(){} };
  return originalLoad.call(this, request, parent, isMain);
};
const { registerKristine } = require("../kristine");
Module._load = originalLoad;

function harness() {
  const routes = new Map(), app = {};
  for (const method of ["get","post","patch","put","delete"]) app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  return { app, routes };
}
function response() { return { statusCode:200, body:null, status(code){this.statusCode=code;return this}, json(body){this.body=body;return this} }; }

(async () => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "finished-afterentry-"));
  const root = path.join(temporary, "_kristine");
  await fsp.mkdir(root, {recursive:true});
  await fsp.writeFile(path.join(root, "assignments.json"), JSON.stringify([{date:"2026-08-08",employeeId:"clemens",jobId:"26080",jobName:"Fink_Loos"}]));
  const sent = [];
  const {app, routes} = harness();
  registerKristine(app, {
    dataDir:temporary, publicDir:temporary, requireAdmin:()=>true,
    readEmployees:async()=>[], readJobMeta:async()=>({status:"Geschlossen"}),
    chefPhoneNumber:"+43 664 3203577", sendWhatsApp:async message=>sent.push(message),
  });
  try {
    const handler = routes.get("POST /kristine/api/finished-job-afterentry");
    assert(handler);
    const res = response();
    await handler({body:{employeeId:"clemens",employeeName:"Clemens Krista",date:"2026-09-09",job:"Fink",from:"07:45",to:"12:00",reason:"Restarbeit und Abschlussfoto"}}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.job.jobId, "26080");
    assert.equal(res.body.notification.sent, true);
    const events = JSON.parse(await fsp.readFile(path.join(root, "time-events.json"), "utf8"));
    assert.deepEqual(events.map(row=>row.type), ["start","ende"]);
    assert(events.every(row=>row.afterCompletion === true && row.source === "employee_finished_job_afterentry"));
    assert.match(fs.readFileSync(path.join(__dirname,"..","kristine.js"),"utf8"), /employee_finished_job_afterentry[^\n]+continue/);
    assert.match(sent[0].reply, /Nachtrag auf fertige Baustelle/);
    assert.match(sent[0].reply, /Fink_Loos/);
    const html = fs.readFileSync(path.join(__dirname,"..","public","kristine-go.html"),"utf8");
    const js = fs.readFileSync(path.join(__dirname,"..","public","kristine-go.js"),"utf8");
    assert.match(html, /Nachtrag fertige Baustelle/);
    assert.match(js, /finished-job-afterentry/);
    console.log("OK: Nachtrag auf fertige Baustelle speichert Stunden und informiert Alexander privat");
  } finally { await fsp.rm(temporary,{recursive:true,force:true}); }
})().catch(error=>{console.error(error);process.exitCode=1});
