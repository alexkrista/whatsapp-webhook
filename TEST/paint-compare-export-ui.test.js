"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {JSDOM}=require("jsdom");

(async()=>{
 const dom=new JSDOM('<div id="tab-search"><div id="detail"></div></div>',{
   url:"https://protokoll.krista.at/admin/paint?token=ui-compare-test",
   runScripts:"outside-only",pretendToBeVisual:true,
 });
 const w=dom.window;
 const names=["Windmill Lane 296","Ambleside 304","Livid 263","Green Stone Light 269","Tuscan 120","Sondermischung 6"];
 const calls=[],downloads=[],exportRequests=[];
 let exportError=false;
 w.eval("var system='LG'; var selected=null;");
 w.api=async function(url){
   calls.push(url);
   if(url.includes("/admin/api/paint/color/")){
     const id=Number(url.match(/\/color\/(\d+)/)[1]);
     return {
       color:{id,name:names[id-1],code:names[id-1],system:"LG",rgb:[180,181,174]},
       products:[{productId:100+id,productName:"Absolute Matt Emulsion",baseName:"Deep",recipeAvailable:true,
         sizes:[{canSizeId:200+id,size:"5 L"}]}],
     };
   }
   if(url.includes("/admin/api/paint/recipe?")){
     const id=Number(new URL("https://test"+url).searchParams.get("colourId"));
     return {baseName:"Deep",canSize:"5 L",formulaId:95500+id,recipeUnitMl:0.16435185185,
       recipe:[{code:"AK",description:"Black",machineUnits:id*100,ml:id*16.435}]};
   }
   throw new Error("Unexpected API: "+url);
 };
 w.URL.createObjectURL=function(){return "blob:KRISTINE";};
 w.URL.revokeObjectURL=function(){};
 w.HTMLAnchorElement.prototype.click=function(){if(this.download)downloads.push(this.download);};
 w.fetch=async function(url,opt={}){
   exportRequests.push({url,method:opt.method,body:JSON.parse(opt.body)});
   if(exportError)return {ok:false,status:400,json:async()=>({error:"Testserver meldet Fehler"})};
   return {
     ok:true,status:200,headers:{get:key=>key==="content-disposition"
       ? 'attachment; filename="KRISTINE_Farbvergleich_2026-11-03_6_Farben.xlsx"'
       :"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
     blob:async()=>new w.Blob(["fake-xlsx-binary-for-UI-test"],{type:"application/octet-stream"}),
   };
 };
 const tick=()=>new Promise(resolve=>setTimeout(resolve,65));
 try {
   w.eval(fs.readFileSync(path.join(__dirname,"../public/paint-compare-ui.js"),"utf8"));
   const detail=w.document.getElementById("detail");
   for(let i=1;i<=6;i++){
     w.selected={id:i};
     detail.innerHTML='<div class="product"><div class="prodhead"></div></div>';
     await tick();
     const add=detail.querySelector(".compareAddBtn");
     assert(add,"Add to comparison button missing for colour "+i);
     add.click();
     await tick();
     assert.equal(w.document.getElementById("paintCompareCount").textContent,"("+i+")");
   }
   w.document.getElementById("paintCompareOpen").click();
   assert.equal(w.document.querySelectorAll(".paintCompareCard").length,6);
   const exportBtn=w.document.getElementById("paintCompareExcelExport");
   assert(exportBtn && !exportBtn.disabled);
   exportBtn.click();
   await tick();
   assert.equal(exportRequests.length,1);
   assert.equal(exportRequests[0].method,"POST");
   assert.match(exportRequests[0].url,/export-xlsx\?token=ui-compare-test$/);
   assert.equal(exportRequests[0].body.items.length,6);
   assert.deepEqual(exportRequests[0].body.items.map(i=>i.color.name),names);
   assert(exportRequests[0].body.items.every(i=>i.recipe.recipe.length===1));
   assert.equal(downloads.length,1);
   assert.equal(downloads[0],"KRISTINE_Farbvergleich_2026-11-03_6_Farben.xlsx");
   assert.match(w.document.getElementById("paintCompareExportStatus").textContent,/6 Farben/);

   exportError=true;
   exportBtn.click();
   await tick();
   assert.equal(downloads.length,1,"Failure must not cause another file download");
   assert.match(w.document.getElementById("paintCompareExportStatus").textContent,/Testserver meldet Fehler/);
   assert.equal(w.document.getElementById("paintCompareCount").textContent,"(6)","Export must not lose colour comparison");
   console.log("Compare UI: six off-screen colours, full recipe payload and XLSX download button OK");
 }finally{w.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
