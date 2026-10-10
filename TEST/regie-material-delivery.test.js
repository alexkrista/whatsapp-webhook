"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { registerRegieAssistant } = require("../regie-assistant");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "krista-regie-test-"));
const routes = new Map();
const app = {
  get(route, handler) { routes.set(`GET ${route}`, handler); },
  post(route, handler) { routes.set(`POST ${route}`, handler); },
  delete(route, handler) { routes.set(`DELETE ${route}`, handler); },
};
let documentation = [];
let savedMeta = null;
let sentMail = null;

registerRegieAssistant(app, {
  dataDir: temporaryRoot,
  publicDir: path.join(__dirname, "..", "public"),
  requireAdmin: () => true,
  readJobMeta: async () => ({ name: "Musterbaustelle", contactName: "Familie Muster", contactEmail: "kunde@example.test", regieHourlyRate: 75, regieMaterialMarkup: 80 }),
  writeJobMeta: async (_jobId, patch) => { savedMeta = patch; return patch; },
  appendJobHistory: async () => {},
  readDocumentation: async () => documentation,
  writeDocumentation: async (_jobId, rows) => { documentation = rows; },
  sendRegieMail: async input => { sentMail = input; return { messageId: "mail-1" }; },
});

function invoke(handler, req) {
  return new Promise((resolve, reject) => {
    const result = { statusCode: 200, body: null, type: "" };
    const res = {
      status(code) { result.statusCode = code; return this; },
      json(body) { result.body = body; resolve(result); },
      type(value) { result.type = value; return this; },
      send(body) { result.body = body; resolve(result); },
      sendFile(file) { result.body = file; resolve(result); },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

(async () => {
 const save=routes.get("POST /kristine/api/regie-reports/save"),split=routes.get("POST /kristine/api/regie-reports/:id/material-delivery");
 const result=await invoke(save,{body:{jobId:"24138",date:"2026-09-24",description:"Ausbessern",hourlyRate:75,materialMarkup:80,employees:[{name:"Max",hours:2,discountPercent:50},{name:"Anna",hours:1,discountPercent:100}],materials:[{product:"Kleber",quantity:1,purchasePrice:10,markup:50,markupOverride:true},{product:"Unbekannt",quantity:2,purchasePrice:0}]}});
 assert.equal(result.statusCode,201);const report=result.body.report;
 assert.equal(report.totals.laborHours,3);assert.equal(report.totals.laborTotal,75);assert.equal(report.materials[0].salePrice,15);
 const moved=await invoke(split,{params:{id:report.id},body:{}});assert.equal(moved.statusCode,200);
 assert.equal(moved.body.report.status,"draft");assert.equal(moved.body.report.materials.length,1);assert.equal(moved.body.report.materials[0].product,"Kleber");assert.equal(moved.body.report.totals.net,90);
 assert.equal(moved.body.delivery.status,"draft");assert.equal(moved.body.delivery.pricePending,true);assert.equal(moved.body.delivery.employees.length,0);
 assert.equal(moved.body.delivery.sourceRegieId,report.id);assert.equal(moved.body.report.materialDeliveryId,moved.body.delivery.id);
 assert.equal(documentation.find(x=>x.id===`regie-office-${moved.body.delivery.id}`)?.totalNet,0);
 const again=await invoke(split,{params:{id:report.id},body:{}});assert.equal(again.body.delivery.id,moved.body.delivery.id);
 const all=JSON.parse(fs.readFileSync(path.join(temporaryRoot,"_kristine","regie-reports.json")));assert.equal(all.length,2);
 const stale=await invoke(save,{body:{...report,correctReport:true}});assert.equal(stale.body.report.materials.length,1,"Old editor cannot put transferred unknown material back");
 const printed=await invoke(routes.get("GET /kristine/regie-report/:id/print"),{params:{id:report.id},query:{}});assert.match(printed.body,/50 % Nachlass/);assert.match(printed.body,/100 % Nachlass/);assert.match(printed.body,/geschenkt/);assert.match(printed.body,/Material siehe Lieferschein/);
 const priced=await invoke(save,{body:{...moved.body.delivery,correctReport:true,materials:moved.body.delivery.materials.map(m=>m.product==="Unbekannt"?{...m,purchasePrice:5}:m)}});
 assert.equal(priced.body.report.pricePending,false);assert.equal(priced.body.report.status,"completed");assert.equal(priced.body.report.materials[0].salePrice,15);
 const forbidden=await invoke(split,{params:{id:priced.body.report.id},body:{}});assert.equal(forbidden.statusCode,404);
 console.log("Discounts 50/100, row markup, linked atomic move, open unpriced delivery, retry and stale-editor protection passed");
})().finally(()=>fs.rmSync(temporaryRoot,{recursive:true,force:true}));
