"use strict";
const assert=require("assert"),fs=require("fs"),fsp=require("fs/promises"),os=require("os"),path=require("path"),Module=require("module");
const originalLoad=Module._load;Module._load=function(request,parent,isMain){if(request==="pdf-lib")return{PDFDocument:{},StandardFonts:{},rgb(){}};return originalLoad.call(this,request,parent,isMain)};
const {registerKristine}=require("../kristine");Module._load=originalLoad;
function harness(){const routes=new Map(),app={};for(const method of ["get","post","put","patch","delete"])app[method]=(route,handler)=>routes.set(`${method.toUpperCase()} ${route}`,handler);return{app,routes}}
function response(){return{statusCode:200,body:null,status(code){this.statusCode=code;return this},json(body){this.body=body;return this}}}
async function call(routes,key,body={}){const res=response();await routes.get(key)({body,query:{},params:{}},res);return res}
(async()=>{const temp=await fsp.mkdtemp(path.join(os.tmpdir(),"za-old-ledger-")),{app,routes}=harness();registerKristine(app,{dataDir:temp,publicDir:temp,requireAdmin:()=>true,readEmployees:async()=>[]});try{
  let res=await call(routes,"POST /kristine/api/za-old-ledger/monthly-transfer",{from:"2026-09-01",to:"2026-09-30",people:[{employeeId:"139",employeeName:"Clemens Krista",minutes:600}]});assert.equal(res.body.balances["139"],600);
  res=await call(routes,"POST /kristine/api/za-old-ledger/monthly-transfer",{from:"2026-09-01",to:"2026-09-30",people:[{employeeId:"139",employeeName:"Clemens Krista",minutes:540}]});assert.equal(res.body.entries.length,1);assert.equal(res.body.balances["139"],540);
  res=await call(routes,"POST /kristine/api/za-old-ledger/payout",{employeeId:"139",employeeName:"Clemens Krista",date:"2026-10-01",minutes:120});assert.equal(res.body.balances["139"],420);
  res=await call(routes,"POST /kristine/api/za-old-ledger/payout",{employeeId:"139",minutes:421});assert.equal(res.statusCode,400);
  const ui=fs.readFileSync(path.join(__dirname,"..","public","kristool-preview","monthly-report.js"),"utf8");assert.match(ui,/payrollTargetHours/);assert.match(ui,/employmentPercent/);assert.match(ui,/Summe UP/);assert.match(ui,/Summe P/);assert.match(ui,/data-person-pdf/);assert.match(ui,/Urlaub T \/ Std\./);console.log("OK: ZA alt hat ein eigenes Konto mit Monatszugang, Auszahlung und Einzel-PDF");
}finally{await fsp.rm(temp,{recursive:true,force:true})}})().catch(error=>{console.error(error);process.exitCode=1});
