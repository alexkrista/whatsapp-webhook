"use strict";
const assert=require("node:assert/strict");
const XLSX=require("xlsx");
const express=require("express");
const {buildCompareWorkbook,registerPaintCompareExcel}=require("../paint-compare-excel");
function fixtures(){
 const colors=["Windmill Lane 296","Ambleside 304","Livid 263","Green Stone Light 269","Tuscan 120","Sondermischung 6"];
 const bases=["Medium","Deep","Deep","Hi White","Deep","Medium"];
 return colors.map((name,i)=>({
   color:{id:i+1,system:"LG",name,code:name,rgb:[200-i,199-i,195-i]},
   product:{productId:100+i,productName:"Absolute Matt Emulsion",baseName:bases[i]},
   size:{canSizeId:200+i,size:"5 L"},
   recipe:{baseName:bases[i],canSize:"5 L",formulaId:95561+i,recipeUnitMl:0.16435185185,
     calibrationNote:"Kalibriert mit Stock 37",
     recipe:[
       {code:"AK",description:"Black",machineUnits:81.65+i,ml:13.42+i},
       {code:"OC",description:"Ochre",machineUnits:637.89+i,ml:104.84+i},
       {code:"RO",description:"Red Oxide",machineUnits:183.71+i,ml:30.19+i},
       {code:i===5?"XX":"UB",description:i===5?"Extra Paste":"Blue",machineUnits:163.30+i,ml:26.84+i},
     ]},
 }));
}
(async()=>{
 const items=fixtures(),before=JSON.stringify(items);
 const report=buildCompareWorkbook({items},new Date("2026-11-03T14:40:00Z"));
 assert.equal(report.colourCount,6);
 assert.equal(report.inconsistent,true);
 assert.equal(JSON.stringify(items),before);
 assert(Buffer.isBuffer(report.buffer) && report.buffer.length>5000);
 const book=XLSX.read(report.buffer,{type:"buffer",cellFormula:true});
 assert.deepEqual(book.SheetNames,["Rezeptdaten","Rezeptvergleich","Hinweise"]);
 const matrix=book.Sheets.Rezeptvergleich;
 const columns=["C","E","G","I","K","M"];
 columns.forEach((col,i)=>{
   assert.equal(matrix[col+"6"].v,items[i].color.name,"All 6 colours including offscreen 6th");
   assert.equal(matrix[col+"7"].v,i+1);
   assert.match(matrix[col+"15"].f,/SUMIFS\(/);
   assert.match(matrix[col+"15"].f,/'Rezeptdaten'!\$A\$2/);
 });
 const records=XLSX.utils.sheet_to_json(book.Sheets.Rezeptdaten);
 assert.equal(records.length,24);
 assert.equal(records[0]["Farbe / Farbton"],"Windmill Lane 296");
 assert.equal(records[0].Paste,"AK");
 assert.equal(records[0].Einheiten,81.65);
 assert.equal(records[0].ml,13.42);
 assert.equal(typeof records[0].Einheiten,"number");
 assert.equal(typeof records[0].ml,"number");
 assert.equal(records.at(-1)["Farbe / Farbton"],"Sondermischung 6");
 assert.equal(records.at(-1).Paste,"XX");
 assert.match(matrix.A3.v,/nur eingeschraenkt direkt vergleichbar/);
 assert.match(matrix.A4.v,/Rezeptdaten/);
 assert.throws(()=>buildCompareWorkbook({items:[]}),/Keine Farben/);
 assert.throws(()=>buildCompareWorkbook({items:[{...items[0],recipe:null}]}),/Rezept.*fehlt/);
 assert.throws(()=>buildCompareWorkbook({items:[{...items[0],recipe:{recipe:[{code:"AK",machineUnits:null,ml:2}]}}]}),/Einheiten/);
 const malicious=JSON.parse(JSON.stringify([items[0]]));
 malicious[0].color.name='=HYPERLINK("evil")';
 malicious[0].recipe.recipe[0].code="@SUM(A1:A9)";
 const sanitized=XLSX.read(buildCompareWorkbook({items:malicious}).buffer,{type:"buffer",cellFormula:true});
 assert.equal(sanitized.Sheets.Rezeptdaten.B2.t,"s");
 assert.equal(sanitized.Sheets.Rezeptdaten.B2.f,undefined);
 assert(sanitized.Sheets.Rezeptdaten.B2.v.startsWith("'="));
 assert.equal(sanitized.Sheets.Rezeptdaten.H2.f,undefined);
 const old=process.env.ADMIN_TOKEN;
 process.env.ADMIN_TOKEN="compare-export-test";
 const app=express();
 app.use(express.json({limit:"25mb"}));
 registerPaintCompareExcel(app);
 const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});
 try{
   const url="http://127.0.0.1:"+server.address().port+"/admin/api/paint/compare/export-xlsx";
   const request=(data,auth)=>fetch(url,{method:"POST",headers:{"content-type":"application/json",...(auth?{"x-admin-token":"compare-export-test"}:{})},body:JSON.stringify(data)});
   let response=await request({items},false);
   assert.equal(response.status,403);
   response=await request({items},true);
   assert.equal(response.status,200);
   assert.match(response.headers.get("content-disposition"),/_6_Farben\.xlsx/);
   assert.match(response.headers.get("content-type"),/spreadsheetml/);
   assert(XLSX.read(Buffer.from(await response.arrayBuffer()),{type:"buffer"}).SheetNames.includes("Rezeptvergleich"));
   response=await request({items:[{...items[0],recipe:null}]},true);
   assert.equal(response.status,400);
   assert.match((await response.json()).error,/Rezept.*fehlt/);
   console.log("6-colour Excel comparison: data/formulas/security/HTTP export OK");
 }finally{
   await new Promise(resolve=>server.close(resolve));
   if(old===undefined)delete process.env.ADMIN_TOKEN;else process.env.ADMIN_TOKEN=old;
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
