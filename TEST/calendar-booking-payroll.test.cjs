"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
(async()=>{
 const root=path.join(__dirname,".."),source=fs.readFileSync(path.join(root,"public/kristool-preview/monthly-report.js"),"utf8");
 const truncated=source.slice(0,source.indexOf("  function selected()"))+"globalThis.test={buildPerson,absence,target};})();";
 class Clock extends Date{constructor(...args){super(...(args.length?args:["2027-02-01T12:00:00Z"]))}}
 const employee={id:"a",name:"Anna",worktimeModelId:"test",employmentPercent:100},model={id:"test",name:"Test",seasons:[{months:[12],weekdays:{3:{payrollTargetHours:7.8},4:{payrollTargetHours:7.8},5:{payrollTargetHours:7.8}}}]};
 const state={bootstrap:{employees:[employee],worktimeModels:[model],assignments:[],employeeWorkRules:{}}};
 let kind="za";const c={state,Date:Clock,document:{getElementById:()=>null},request:async()=>({released:true,segments:[{type:"up",from:"07:00",to:"14:48",reason:kind==="za"?"Zeitausgleich":kind==="feiertag"?"Feiertag":"Urlaub",unproductiveCode:kind==="za"?"930":kind==="feiertag"?"904":"900"}]})};
 vm.createContext(c);vm.runInContext(truncated,c);
 for(const [type,za,vacation,balance] of [["za",468,0,-468],["urlaub",0,468,0],["feiertag",0,0,0]]){
  kind=type;state.bootstrap.assignments=[{employeeId:"a",date:"2026-12-23",cardType:type,jobName:type==="za"?"Zeitausgleich":type==="feiertag"?"Feiertag":"Urlaub"}];
  const result=await c.test.buildPerson(employee,"2026-12-23","2026-12-23",0);
  assert.equal(result.totals.zaUsedMinutes,za,type);assert.equal(result.totals.vacationMinutes,vacation,type);assert.equal(result.totals.balanceMinutes,balance,type);
 }
 const exportCode=fs.readFileSync(path.join(root,"public/kristool-preview/finkzeit-export.js"),"utf8"),finkSource=exportCode.slice(0,exportCode.indexOf("function updateFinkPreview"));
 const fink={state:{bootstrap:{employees:[{...employee,finkzeitPersonnelNumber:"1"}],assignments:[{employeeId:"a",date:"2026-12-23",cardType:"urlaub",jobName:"Urlaub",from:"08:00",to:"17:00",calendarMinutes:192}]}},request:async()=>({segments:[]})};
 vm.createContext(fink);vm.runInContext(finkSource+";globalThis.build=buildFinkRows;",fink);
 const result=await fink.build("2026-12-23","2026-12-23");assert.equal(result.rows.length,1);assert.equal(result.rows[0][3],"08:00");assert.equal(result.rows[0][4],"11:12");assert.equal(result.rows[0][5],"3,20");assert.equal(result.rows[0][7],"900");
 const html=fs.readFileSync(path.join(root,"public/kristine.html"),"utf8"),ui=html.split(/\r?\n/).filter(x=>x.startsWith("function calendarBookingEditor(")||x.startsWith("async function changeCalendarBooking(")).join("\n");
 const row={id:"calendar:a:2026-12-23",employeeId:"a",date:"2026-12-23",source:"company_calendar",cardType:"urlaub"};let payload;
 const u={data:{assignments:[row]},esc:String,cardTypeOf:a=>a.cardType,api:async(url,options)=>{payload=JSON.parse(options.body);return {assignments:[{...row,cardType:payload.type,calendarOverride:true}]}},renderWeek(){},renderAnnualProductivePlanning(){},alert:m=>{throw Error(m)}};
 vm.createContext(u);vm.runInContext(ui,u);assert(u.calendarBookingEditor(row).includes('value="za"'));await u.changeCalendarBooking(row.id,"za");assert.equal(payload.type,"za");assert.equal(u.data.assignments[0].cardType,"za");
 console.log("PASS: released ZA debits its account without consuming vacation, paid vacation/holidays do not debit ZA; part-time Fink hours and times agree; employee card selector saves a persistent per-day override");
})().catch(e=>{console.error(e);process.exitCode=1});
