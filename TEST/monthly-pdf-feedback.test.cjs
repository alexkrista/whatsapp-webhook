"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),{createKriszeitMonthlyPdf}=require("../kriszeit-monthly-pdf");
(async()=>{
 const code=fs.readFileSync(path.join(__dirname,"../public/kristool-preview/monthly-report.js"),"utf8");
 for(const blocked of [false,true]){
  const events={},els={},downloads=[],opened=[],person={employeeId:"a",name:"Anna",days:[],totals:{zaOldMinutes:0}};
  function el(id){if(!els[id])els[id]={value:id==="monthlyFrom"?"2026-10-01":id==="monthlyTo"?"2026-10-31":"",textContent:"",disabled:false,hidden:false,addEventListener:(event,fn)=>events[id+":"+event]=fn,appendChild:node=>opened.push(node)};return els[id]}
  let dayRequests=0,pdfRequests=0;
  const c={state:{bootstrap:{employees:[{id:"a",name:"Anna"}],worktimeModels:[],assignments:[]}},document:{getElementById:el,querySelectorAll:()=>[{value:"a"}],querySelector:()=>({value:"0"}),createElement:()=>({click(){downloads.push(this)},remove(){}}),body:{appendChild(){}}},CSS:{escape:String},request:async()=>{dayRequests++;throw Error("No rebuild should occur for the displayed report")},fetch:async()=>{pdfRequests++;return {ok:true,blob:async()=>({pdf:true})}},AbortController,URL:{createObjectURL:()=>"blob:pdf",revokeObjectURL(){}},setTimeout,clearTimeout,window:{open:()=>blocked?null:{closed:false,location:{},close(){}}},toast:m=>{throw Error(m)},confirm:()=>false};
  vm.createContext(c);vm.runInContext(code.replace(/\}\)\(\);\s*$/,'globalThis.test={seed(people){reportCache={key:reportSelectionKey(),people,at:0}},rebuild,fetchMonthlyPdf};})();'),c);
  c.test.seed([person]);await events["createMonthlyReport:click"]();
  assert.equal(dayRequests,0);assert.equal(pdfRequests,1);assert.equal(el("createMonthlyReport").disabled,false);assert(opened.some(x=>x.href==="blob:pdf"));assert.equal(downloads.length,blocked?1:0);
 }
 const pdf=await createKriszeitMonthlyPdf({from:"2026-10-01",to:"2026-10-31",people:[{name:"Anna Test",employeeId:"a",personnelNumber:"1",days:[],totals:{}}]});assert.equal(pdf.subarray(0,5).toString(),"%PDF-");assert(pdf.length>1000);
 console.log("PASS: bulk PDF reuses exact visible summary without any day requests, button resets, popup-block fallback and persistent PDF link; actual monthly PDF generation succeeds");
})().catch(e=>{console.error(e);process.exitCode=1});
