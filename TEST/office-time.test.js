"use strict";
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { normalizeOfficeTimeData, isInternalJobId } = require("../office-time");
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "pdf-lib") return { PDFDocument: {}, StandardFonts: {}, rgb() {} };
  return originalLoad.call(this, request, parent, isMain);
};
const { registerKristine } = require("../kristine");
Module._load = originalLoad;

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "office-time-"));
  try {
    await fsp.mkdir(path.join(root, "_kristine"));
    const events = [
      { id:"start", employeeId:"office", date:"2026-09-10", type:"start", at:"08:00", jobId:"022", activityMode:"productive" },
      { id:"pause", employeeId:"office", date:"2026-09-10", type:"pause", at:"10:00", jobId:"022" },
      { id:"continue", employeeId:"office", date:"2026-09-10", type:"weiter", at:"10:15", jobId:"022" },
      { id:"end", employeeId:"office", date:"2026-09-10", type:"ende", at:"12:00", jobId:"022" },
    ];
    await fsp.writeFile(path.join(root, "_kristine/time-events.json"), JSON.stringify(events));
    const archive = [{employeeId:"office",date:"2026-09-09",segments:[{type:"work",jobId:"022",from:"08:00",to:"12:00"}]}];
    await fsp.writeFile(path.join(root, "_kristine/project-time-archive.json"), JSON.stringify(archive));
    const routes = new Map(), app = {};
    for (const method of ["get","put","post","patch","delete"]) app[method] = (url, handler) => routes.set(`${method} ${url}`, handler);
    registerKristine(app, {dataDir:root,publicDir:root,requireAdmin:()=>true,readEmployees:async()=>[{id:"office",name:"Office"}]});
    async function call(method, url, params={}, body={}) {
      const res={statusCode:200,status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;}};
      await routes.get(`${method} ${url}`)({params,body,query:{}},res);
      assert.equal(res.statusCode,200,JSON.stringify(res.body)); return res.body;
    }
    const segments = await call("get", "/kristine/api/segments/:employeeId/:date", {employeeId:"office",date:"2026-09-10"});
    assert.deepEqual(segments.segments.map(row=>[row.type,row.from,row.to]), [["up","08:00","10:00"],["pause","10:00","10:15"],["up","10:15","12:00"]]);
    assert.equal(segments.segments[0].unproductiveCode,"022");
    const bootstrap = await call("get", "/kristine/api/bootstrap");
    assert.equal(bootstrap.projectTimeArchive[0].segments[0].type,"up");
    assert.deepEqual(JSON.parse(await fsp.readFile(path.join(root,"_kristine/time-events.json"),"utf8")),events,"Reading must not rewrite history");
    await call("put", "/kristine/api/day-release/:employeeId/:date", {employeeId:"office",date:"2026-09-10"}, {employeeName:"Office",reviewer:"Test",checks:{times:true,regie:true,close:true,diet:true,fl:true,ch:true}});
    const personal = JSON.parse(await fsp.readFile(path.join(root,"_kristine/time-events.json"),"utf8"));
    assert.equal(personal.filter(row=>row.type==="up").length,2);
    assert(personal.filter(row=>row.type==="up").every(row=>row.activityMode==="unproductive"&&row.unproductiveCode==="022"));
    assert.equal(personal.at(-1).at,"12:00");
    const ordinary=[{type:"work",jobId:"25018",from:"08:00",to:"12:00"},{type:"pause",jobId:"022"}];
    assert.deepEqual(normalizeOfficeTimeData(ordinary),ordinary);
    for(const id of ["_system","_kristine","System","Kristine","022"]) assert(isInternalJobId(id));
    for(const id of ["25018","26096","keckeis_gabi_harry"]) assert(!isInternalJobId(id));
    console.log("OK: 022 remains paid office time, excluded from productive work; system folders stay hidden.");
  } finally { await fsp.rm(root,{recursive:true,force:true}); }
})().catch(error=>{console.error(error);process.exitCode=1;});
