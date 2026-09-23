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
  let startupReady = Promise.resolve();
  const dataRoot = path.join(root, "_kristine");
  const date = "2026-09-15";
  const nextDate = "2026-09-16";
  const employees = [
    { id:"1", name:"Anna Arbeit", worktimeModelId:"krista-standard" },
    { id:"2", name:"Uwe Urlaub", worktimeModelId:"krista-standard" },
    { id:"3", name:"Bernd Schule" },
    { id:"4", name:"Judith Krista", worktimeModelId:"krista-standard" },
    { id:"5", name:"Alexander Krista", worktimeModelId:"office-alex" },
    { id:"6", name:"Vor Eintritt", employmentStart:"2026-09-16" },
    { id:"7", name:"Bereits ausgetreten", employmentEnd:"2026-09-14" },
    { id:"8", name:"Deaktiviert", active:false },
    { id:"9", name:"Zara Zeitausgleich", worktimeModelId:"krista-standard" },
  ];
  try {
    await fsp.mkdir(dataRoot);
    await fsp.mkdir(path.join(root,"_system"));
    await fsp.writeFile(path.join(root,"_system","worktime-models.json"),JSON.stringify([
      {id:"krista-standard",name:"Produktive MA",blocks:{finkTarget:{rows:[{days:[1,2,3,4,5],from:"07:00",to:"14:48"}]},finkFixed:{enabled:false,rows:[]}}},
      {id:"office-judith",name:"Judith",blocks:{finkFixed:{enabled:true,rows:[{days:[2],from:"07:00",to:"13:48",activityCode:"022",activityLabel:"Baustelle < 120 km"}]}}},
      {id:"office-alex",name:"Alex",blocks:{finkFixed:{enabled:true,rows:[{days:[2],from:"07:00",to:"13:48",activityCode:"022",activityLabel:"Baustelle < 120 km"}]}}}
    ]));
    await fsp.writeFile(path.join(dataRoot, "time-events.json"), JSON.stringify([
      {employeeId:"1",employeeName:"Anna Arbeit",date,type:"start",at:"07:00",jobId:"25018",jobName:"Baustelle"},
      {employeeId:"1",employeeName:"Anna Arbeit",date,type:"up",at:"12:00",reason:"Werkstatt",unproductiveCode:"913"},
      {employeeId:"1",employeeName:"Anna Arbeit",date,type:"ende",at:"14:00"},
      {employeeId:"2",employeeName:"Uwe Urlaub",date,type:"up",at:"07:00",reason:"Urlaub",unproductiveCode:"900"},
      {employeeId:"2",employeeName:"Uwe Urlaub",date,type:"ende",at:"17:00"},
      {employeeId:"3",employeeName:"Bernd Schule",date,type:"up",at:"07:00",reason:"Berufsschule",unproductiveCode:"903"},
      {employeeId:"3",employeeName:"Bernd Schule",date,type:"ende",at:"14:48"},
      {employeeId:"5",employeeName:"Alexander Krista",date,type:"start",at:"07:00",jobId:"25018",jobName:"Baustelle"},
      {employeeId:"5",employeeName:"Alexander Krista",date,type:"mittag",at:"12:00"},
      {employeeId:"5",employeeName:"Alexander Krista",date,type:"weiter",at:"12:29",jobId:"25018",jobName:"Baustelle"},
      {employeeId:"5",employeeName:"Alexander Krista",date,type:"ende",at:"13:48"},
      {employeeId:"9",employeeName:"Zara Zeitausgleich",date,type:"up",at:"07:00",reason:"Zeitausgleich",unproductiveCode:"930"},
      {employeeId:"9",employeeName:"Zara Zeitausgleich",date,type:"ende",at:"17:00"},
      {employeeId:"1",employeeName:"Anna Arbeit",date:nextDate,type:"start",at:"07:00",jobId:"25018",jobName:"Baustelle"},
      {employeeId:"1",employeeName:"Anna Arbeit",date:nextDate,type:"ende",at:"16:30"},
    ]));
    await fsp.writeFile(path.join(dataRoot,"employee-work-rules.json"),JSON.stringify({"1":{activityMode:"productive",buak:true}}));
    await fsp.writeFile(path.join(dataRoot,"assignments.json"),JSON.stringify([
      {id:"vac-1",date:"2026-10-01",employeeId:"1",employeeName:"Anna Arbeit",cardType:"urlaub",jobName:"Urlaub"},
      {id:"vac-2",date:"2026-10-02",employeeId:"2",employeeName:"Uwe Urlaub",cardType:"urlaub",jobName:"Urlaub"}
    ]));
    await fsp.writeFile(path.join(dataRoot, "day-releases.json"), JSON.stringify(employees.map(employee=>({
      id:`release_${employee.id}_${date}`,employeeId:employee.id,employeeName:employee.name,date,released:true,reviewer:"Bettina",releasedAt:"2026-09-15T15:00:00Z"
    }))));

    const routes = new Map(), app = {};
    for (const method of ["get","put","post","patch","delete"]) app[method] = (url, handler) => routes.set(`${method} ${url}`, handler);
    ({ startupReady } = registerKristine(app, {dataDir:root,publicDir:root,requireAdmin:()=>true,readEmployees:async()=>employees,readJobMeta:async()=>({address:"Vaduz, Liechtenstein"})}));
    async function call(method, url, params={}, body={}, query={}) {
      const res={statusCode:200,status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;}};
      await routes.get(`${method} ${url}`)({params,body,query},res);
      return res;
    }

    let response=await call("get","/kristine/api/day-control/:date",{date});
    assert.equal(response.statusCode,200);
    assert.equal(response.body.allReleased,true);
    assert.equal(response.body.items.length,6);
    assert.equal(response.body.items.some(item=>["6","7","8"].includes(item.employeeId)),false,"Personalregeln begrenzen die Tageskontrolle");
    assert.equal(response.body.items.find(item=>item.employeeId==="1").totals.work,420,"Werkstatt zählt im Überblick als Arbeit");
    assert.equal(response.body.items.find(item=>item.employeeId==="2").totals.absence,468,"Urlaub folgt trotz längerem Rohzeitraum den 7,8 Sollstunden des Zeitmodells");
    assert.equal(response.body.items.find(item=>item.employeeId==="2").segments[0].kind,"vacation","Urlaub erhält die Kartenfarbe für Urlaub");
    const za=response.body.items.find(item=>item.employeeId==="9");
    assert.equal(za.totals.za,468,"ZA folgt trotz längerem Rohzeitraum den 7,8 Sollstunden des Zeitmodells");
    assert.equal(za.totals.work,0,"ZA darf nicht als Arbeitszeit erscheinen");
    assert.equal(za.segments[0].kind,"za","ZA erhält eine eigene Kartenfarbe");
    assert.equal(response.body.totals.za,468,"ZA wird in der Tageszusammenfassung separat ausgewiesen");
    assert.equal(response.body.items.find(item=>item.employeeId==="3").totals.work,468,"Berufsschule zählt im Überblick als Arbeit");
    const judith=response.body.items.find(item=>item.employeeId==="4");
    assert.equal(judith.totals.work,0,"Automatische Zeit darf noch nicht als Ist gerechnet werden");
    assert.equal(judith.automatic.from,"07:00");
    assert.equal(judith.automatic.to,"13:48");
    assert.equal(judith.automatic.pauseMinutes,15,"Fixe Pause wird separat angezeigt");
    assert.equal(judith.automatic.counted,false);
    const alex=response.body.items.find(item=>item.employeeId==="5");
    assert.equal(alex.automatic.lunchMinutes,29,"Mittag wird aus der tatsächlichen Stempelung angezeigt");
    assert.equal(alex.totals.work,379,"Die automatische Modellzeit wird nicht zusätzlich zu den Ist-Stunden gerechnet");

    response=await call("put","/kristine/api/day-control/:date",{date},{reviewer:"Bettina / Büro"});
    assert.equal(response.statusCode,200);
    assert.equal(response.body.control.confirmed,true);

    response=await call("get","/kristine/api/diet-report",{}, {}, {from:date,to:nextDate});
    const annaDiet=response.body.employees.find(employee=>employee.employeeId==="1");
    assert.equal(annaDiet.dailyAllowanceModel,"buak","BUAK-Regel wird in den Diätenbericht übernommen");
    assert.equal(annaDiet.rows.find(row=>row.date===date).dietSmall,1,"BUAK klein wird separat gezählt");
    assert.equal(annaDiet.rows.find(row=>row.date===nextDate).dietLarge,1,"BUAK groß wird separat gezählt");
    assert.equal(annaDiet.rows.reduce((sum,row)=>sum+row.taggeld,0),2,"Gesamtdiäten bleiben zusätzlich verfügbar");
    assert(annaDiet.rows.every(row=>row.flMinutes>0),"FL wird nur für tatsächlich betroffene Baustellen ausgewiesen");
    const alexDiet=response.body.employees.find(e=>e.employeeId==="5");
    assert.equal(alexDiet.dailyAllowanceModel,"employee6");
    assert.equal(alexDiet.rows.find(r=>r.date===date).dietEmployee,1);
    assert.equal(alexDiet.rows.find(r=>r.date===nextDate).dietEmployee,0,"no attendance means no automatic allowance");
    assert(response.body.employees.every(e=>e.rows.every(r=>r.taggeld===r.dietPainter+r.dietSmall+r.dietLarge+r.dietEmployee)),"row sum equals total");
    const eventsPath=path.join(dataRoot,"time-events.json");
    const originalEvents=await fsp.readFile(eventsPath,"utf8");
    const officeEvents=JSON.parse(originalEvents).filter(e=>e.employeeId!=="5");
    for(const [d,end,type] of [["2026-09-17","13:00","start"],["2026-09-18","13:01","start"],["2026-09-21","17:00","up"]]){
      officeEvents.push({employeeId:"5",date:d,type,at:"07:00",jobName:type==="up"?"Urlaub":"Büro",reason:type==="up"?"Urlaub":"",unproductiveCode:type==="up"?"900":""},{employeeId:"5",date:d,type:"ende",at:end});
    }
    await fsp.writeFile(eventsPath,JSON.stringify(officeEvents));
    const officeReport=await call("get","/kristine/api/diet-report",{},{},{from:"2026-09-17",to:"2026-09-21"});
    const officeRows=officeReport.body.employees.find(e=>e.employeeId==="5").rows;
    assert.equal(officeRows.find(r=>r.date==="2026-09-17").dietEmployee,0,"exactly six hours does not qualify");
    assert.equal(officeRows.find(r=>r.date==="2026-09-18").dietEmployee,1,"office work over six hours qualifies");
    assert.equal(officeRows.find(r=>r.date==="2026-09-21").dietEmployee,0,"vacation does not qualify");
    await fsp.writeFile(eventsPath,originalEvents);


    response=await call("get","/kristine/api/buak-vacation-report",{}, {}, {from:"2026-10-01",to:"2026-10-31"});
    assert.equal(response.statusCode,200);
    assert.equal(response.body.rows.length,1,"BUAK-Urlaubsplan enthält keine Nicht-BUAK-Mitarbeiter");
    assert.equal(response.body.rows[0].employeeId,"1");
    assert.equal(response.body.rows[0].minutes,468,"Geplanter BUAK-Urlaub folgt den 7,8 Modellstunden");

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
    await startupReady;
    await fsp.rm(root,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
