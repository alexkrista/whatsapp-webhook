"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "pdf-lib") return { PDFDocument: {}, StandardFonts: {}, rgb() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const { registerKristine } = require("../kristine");
Module._load = originalLoad;

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "day-control-"));
  const dataRoot = path.join(root, "_kristine");
  const date = "2026-09-15";
  const employees = [
    { id:"1", name:"Anna Arbeit" },
    { id:"2", name:"Uwe Urlaub" },
    { id:"3", name:"Bernd Schule" },
  ];
  try {
    await fsp.mkdir(dataRoot);
    await fsp.writeFile(path.join(dataRoot, "time-events.json"), JSON.stringify([
      {employeeId:"1",employeeName:"Anna Arbeit",date,type:"start",at:"07:00",jobId:"25018",jobName:"Baustelle"},
      {employeeId:"1",employeeName:"Anna Arbeit",date,type:"up",at:"12:00",reason:"Werkstatt",unproductiveCode:"913"},
      {employeeId:"1",employeeName:"Anna Arbeit",date,type:"ende",at:"14:00"},
      {employeeId:"2",employeeName:"Uwe Urlaub",date,type:"up",at:"07:00",reason:"Urlaub",unproductiveCode:"900"},
      {employeeId:"2",employeeName:"Uwe Urlaub",date,type:"ende",at:"14:48"},
      {employeeId:"3",employeeName:"Bernd Schule",date,type:"up",at:"07:00",reason:"Berufsschule",unproductiveCode:"903"},
      {employeeId:"3",employeeName:"Bernd Schule",date,type:"ende",at:"14:48"},
    ]));
    await fsp.writeFile(path.join(dataRoot, "day-releases.json"), JSON.stringify(employees.map(employee=>({
      id:`release_${employee.id}_${date}`,employeeId:employee.id,employeeName:employee.name,date,released:true,reviewer:"Bettina",releasedAt:"2026-09-15T15:00:00Z"
    }))));

    const routes = new Map(), app = {};
    for (const method of ["get","put","post","patch","delete"]) app[method] = (url, handler) => routes.set(`${method} ${url}`, handler);
    registerKristine(app, {dataDir:root,publicDir:root,requireAdmin:()=>true,readEmployees:async()=>employees});
    async function call(method, url, params={}, body={}) {
      const res={statusCode:200,status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;}};
      await routes.get(`${method} ${url}`)({params,body,query:{}},res);
      return res;
    }

    let response=await call("get","/kristine/api/day-control/:date",{date});
    assert.equal(response.statusCode,200);
    assert.equal(response.body.allReleased,true);
    assert.equal(response.body.items.length,3);
    assert.equal(response.body.items.find(item=>item.employeeId==="1").totals.work,420,"Werkstatt zählt im Überblick als Arbeit");
    assert.equal(response.body.items.find(item=>item.employeeId==="2").totals.absence,468,"Urlaub zählt als Abwesenheit");
    assert.equal(response.body.items.find(item=>item.employeeId==="3").totals.work,468,"Berufsschule zählt im Überblick als Arbeit");

    response=await call("put","/kristine/api/day-control/:date",{date},{reviewer:"Bettina / Büro"});
    assert.equal(response.statusCode,200);
    assert.equal(response.body.control.confirmed,true);

    response=await call("post","/kristine/api/day-control/:date/return",{date},{employeeId:"1",reason:"Endzeit prüfen",returnedBy:"Bettina"});
    assert.equal(response.statusCode,200);
    assert.equal(response.body.release.returned,true);
    assert.equal(response.body.control.confirmed,false);

    response=await call("get","/kristine/api/day-control/:date",{date});
    assert.equal(response.body.allReleased,false);
    assert.equal(response.body.items.find(item=>item.employeeId==="1").returned,true);

    response=await call("put","/kristine/api/day-control/:date",{date},{reviewer:"Bettina"});
    assert.equal(response.statusCode,409,"Der ganze Tag darf mit einem zurückgegebenen Mitarbeiter nicht bestätigt werden");

    const checks={times:true,regie:true,close:true,diet:true,fl:true,ch:true};
    response=await call("put","/kristine/api/day-release/:employeeId/:date",{employeeId:"1",date},{employeeName:"Anna Arbeit",reviewer:"Bettina",checks});
    assert.equal(response.statusCode,200,"Der Mitarbeiter kann seinen korrigierten Tag erneut abschließen");
    assert.equal(response.body.release.returned,false);

    response=await call("get","/kristine/api/day-control/:date",{date});
    assert.equal(response.body.allReleased,true);
    response=await call("put","/kristine/api/day-control/:date",{date},{reviewer:"Bettina"});
    assert.equal(response.statusCode,200,"Bettina kann den ganzen Tag nach der Korrektur erneut bestätigen");
    assert.equal(response.body.control.confirmed,true);
    console.log("OK: Tageskontrolle zählt Anwesenheit korrekt und unterstützt Rückgabe, Korrektur und erneuten Tagesabschluss.");
  } finally {
    await fsp.rm(root,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
