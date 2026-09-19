"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");

test("produktive V1/V2-Kette liefert Angebots-Soll und fertigen Baustellen-Stundenstand",async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),"hours-preloads-"));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  process.env.DATA_DIR=dataDir;process.env.ADMIN_TOKEN="fixture-token";
  require("../order-calculation-v2-preload");require("../order-calculation-preload");
  const express=require("express"),app=express();app.use(express.json());
  const {createBaustellenHoursService}=require("../baustellen-hours-service");
  const attach=createBaustellenHoursService({dataDir,readBootstrap:async()=>({})});
  for(const id of ["26100","26101"]){await fs.mkdir(path.join(dataDir,id),{recursive:true});await fs.writeFile(path.join(dataDir,id,".meta.json"),JSON.stringify({status:"Auftrag"}));}
  const draft={offerNumber:"2609003",offerRevision:1,offerType:"regie_material",positions:[{id:"hours",text:"Regiearbeit",quantity:18,unit:"Std",unitPrice:75},{id:"material",text:"Material",quantity:1,unit:"PA",unitPrice:270}]};
  await fs.writeFile(path.join(dataDir,"26100/.offer-draft.json"),JSON.stringify(draft));
  const {buildAcceptedOrder,buildOrderCalculation}=require("../offer-order-workflow");
  const mixed=buildAcceptedOrder({draft:{...draft,offerType:"mixed",positions:[{id:"fixed",text:"Wände",quantity:12,unit:"m²",unitPrice:30,laborHoursPerUnit:.5},{id:"extra",text:"Regiearbeiten",quantity:4,unit:"Std",unitPrice:75}]},jobId:"26101"});
  await fs.writeFile(path.join(dataDir,"26101/.accepted-order.json"),JSON.stringify(mixed));await fs.writeFile(path.join(dataDir,"26101/.order-calculation.json"),JSON.stringify(buildOrderCalculation(mixed)));
  app.get("/admin/api/jobs",(req,res)=>{res.locals.buildBaustellenHours=attach;if(req.query.token!=="fixture-token")return res.status(403).json({ok:false});res.json({ok:true,jobs:[{jobId:"26100",status:"Auftrag",calculation:{billingRate:90,actualHours:3}},{jobId:"26101",status:"Auftrag",calculation:{billingRate:90,actualHours:2}}],collections:[]});});
  app.use((req,res)=>res.status(404).send("Not found: "+req.path));
  const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s))});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(base+"/admin/api/jobs?token=fixture-token"),payload=await response.json();
  assert.equal(response.status,200);assert.equal(payload.jobs[0].calculation.calculatedHours,18);assert.equal(payload.jobs[0].contractAmount,1620);
  assert.equal(payload.jobs[1].calculation.fixedCalculatedHours,6);assert.equal(payload.jobs[1].calculation.plannedRegieHours,4);assert.equal(payload.jobs[1].calculation.calculatedHours,10);
  assert.equal(payload.baustellenHours.remainingHours,23);assert.equal(payload.baustellenHours.targetHours,28);assert.equal(payload.baustellenHours.workedHours,5);
  const calc=await (await fetch(base+"/admin/api/job/26100/order-calculation?token=fixture-token")).json();assert.equal(calc.calculation.positions[0].plannedHours,18);
  const forbidden=await fetch(base+"/admin/api/jobs");assert.equal(forbidden.status,403);assert.equal((await forbidden.json()).baustellenHours,undefined);
});
