"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),fsp=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),vm=require("node:vm"),{createRequire}=require("node:module");
const root=path.resolve(__dirname,".."),fixture=fs.readFileSync(path.join(__dirname,"fixtures/offer-flat-positions.txt"),"utf8");
process.env.ADMIN_TOKEN="test-only";
function frontend(extra={}){
  const elements={kcv2Save:{disabled:false},kcv2SaveMsg:{textContent:"",style:{}},kcv2ParseStatus:{textContent:"",className:""}},events=[];
  const document={readyState:"loading",getElementById:id=>elements[id]||null,addEventListener(){},dispatchEvent:e=>events.push(e)};
  const window={...extra.window},location={search:"",hash:"#99001",origin:"https://example.test"};
  const source=fs.readFileSync(path.join(root,"public/ui/baustellen-calculation-v2.js"),"utf8").replace("  window.KristaOrderCalculation=",`  window.test={parseText,derive,handlePdf,save,teamHtml,set(c){calculation=c;currentJobId="99001"},state(){return {calculation,pendingFile}},stubRender(){render=()=>{}},pdfText(text){extractPdf=async()=>text}};\n  window.KristaOrderCalculation=`);
  vm.runInNewContext(source,{window,document,location,URL,URLSearchParams,console,setTimeout(){},CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail}},...extra,window,document});
  return {api:window.test,window,document,elements,events};
}
function parsed(){return frontend().api.parseText(fixture,{name:"offer.pdf"})}
function backend(name,dir,exports){
  const file=path.join(root,name),req=createRequire(file),module={exports:{}};
  vm.runInNewContext(fs.readFileSync(file,"utf8")+`\nmodule.exports={${exports}};`,{module,exports:module.exports,require:id=>id==="express"?{application:{get(){},use(){}}}:req(id),process:{env:{DATA_DIR:dir}},console,Buffer});
  return module.exports;
}
const plain=value=>JSON.parse(JSON.stringify(value));
test("flat offer positions retain quantity, prices, alternatives and full VAT without interpreting prose as a new row",()=>{
  const calc=parsed();assert.equal(calc.positions.length,10);assert.equal(calc.netTotal,11097.2);assert.equal(calc.vatAmount,2219.44);assert.equal(calc.grossTotal,13316.64);
  assert.deepEqual(plain(calc.positions.map(p=>[p.number,p.quantity,p.unit,p.unitPrice,p.amount])),[
    ["01",110,"m²",14,1540],["02",1,"Monate",300,300],["03",1,"PA",250,250],["04",270,"m²",3.75,1012.5],["05",270,"m²",3.51,947.7],["06",270,"m²",3.6,972],["07",270,"m²",22.5,6075],["08",20,"m",150,3000],["09",5,"Std",75,375],["10",100,"VE",1,100],
  ]);
  assert.deepEqual(plain(calc.positions.filter(p=>p.calcIncluded===false).map(p=>p.number)),["08","09","10"]);
  assert.equal(calc.positions[8].plannedHours,5);assert.equal(calc.positions[9].plannedHours,0);assert.equal(calc.positions[0].needsReview,true);
  assert.equal(calc.positions[7].shortText,"Sockeldetail nach Skizze ausführen.");assert(!calc.positions[6].description.includes("Angebot Nr."));
  const d=frontend().api.derive(calc);assert.equal(d.contract,11097.2);assert.equal(d.regie,0);assert.equal(d.plannedRegie,0);
});
test("nested position numbers and title-summary offers keep working",()=>{
  const api=frontend().api;
  const nested=api.parseText("Titel 1 Innenarbeiten\n1.01 2,00 Std Regiearbeiten 75,00 150,00\n1.02 10,00 VE Regiematerial 1,00 10,00\nNettosumme = EUR 160,00",{});
  assert.equal(nested.positions.length,2);assert.equal(nested.positions[0].amount,150);assert.equal(nested.positions[0].plannedHours,2);
  const titles=api.parseText("Titelzusammenstellung\n1 Innenarbeiten 1.000,00\n2 Fassade 2.000,00\nNettosumme = EUR 3.000,00",{});
  assert.equal(titles.positions.length,2);assert.equal(titles.netTotal,3000);
});
test("empty parsing preserves the existing calculation; successful parsing passes all positions to the grid",async()=>{
  const {api,elements,events}=frontend(),existing=parsed();api.set(existing);api.stubRender();api.pdfText("Nicht lesbares Dokument");
  await api.handlePdf({name:"empty.pdf"});assert.equal(api.state().calculation,existing);assert.equal(api.state().pendingFile,null);assert.match(elements.kcv2ParseStatus.textContent,/keine Positionen|Keine Positionen/);assert.equal(events.length,0);
  api.pdfText(fixture);await api.handlePdf({name:"offer.pdf"});assert.equal(api.state().calculation.positions.length,10);assert.equal(events[0].type,"krista:order-pdf-parsed");assert.equal(events[0].detail.positions[9].calcIncluded,false);
});
test("save and reload retain all positions; employee handover excludes unselected alternatives; stale grid metadata cannot reinclude them",async t=>{
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),"offer-roundtrip-"));t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
  const v1=backend("order-calculation-preload.js",dir,"writeCalculation,readCalculation,deriveCalculation,employeeScope"),v2=backend("order-calculation-v2-preload.js",dir,"writeMeta,readMeta,derive,employeeScope,registerRoutes");
  await v1.writeCalculation("99001",parsed());const calc=await v1.readCalculation("99001");
  assert.equal(calc.positions.length,10);assert.equal(calc.positions[0].unit,"m²");assert.equal(calc.positions[7].alternative,true);assert.equal(calc.positions[7].calcIncluded,false);
  const stale={rows:calc.positions.map((p,i)=>({positionId:"old-"+i,calcIncluded:true,quantity:999,unitPrice:999}))};
  let d=v2.derive(calc,stale);assert.equal(d.contractAmount,11097.2);assert.equal(d.lines[9].amount,100);assert.equal(d.lines[0].quantity,110);
  assert.equal(v1.deriveCalculation(calc).contractAmount,11097.2);assert.equal(v1.employeeScope(calc).regie.length,0);
  await v2.writeMeta("99001",d.lines.map(p=>({...p,positionId:p.id})));
  const meta=await v2.readMeta("99001");assert.equal(meta.rows[7].calcIncluded,false);
  const scope=v2.employeeScope(calc,meta);assert.deepEqual(plain(scope.order.map(p=>p.number)),["02","03","04","05","06","07"]);assert.equal(scope.regie.length,0);assert.equal(scope.order[0].unit,"Monate");
  const routes={};v2.registerRoutes({get(route,fn){routes[route]=fn},put(){}});let response;
  await routes["/kristine/api/job/:jobId/work-scope-v2"]({params:{jobId:"99001"},headers:{"x-admin-token":"test-only"}},{json(value){response=value},status(code){throw new Error(String(code))}});
  assert.equal(response.scope.order.length,6);assert.equal(response.scope.regie.length,0);
  meta.rows.forEach(p=>p.calcIncluded=true);d=v2.derive(calc,meta);assert.equal(d.contractAmount,14572.2);assert.equal(d.regieAmount,475);assert.equal(d.plannedRegieHours,5);
  assert.equal(v2.employeeScope(calc,meta).regie.length,2);
  calc.positions.forEach(p=>p.calcIncluded=true);assert.equal(v1.deriveCalculation(calc).contractAmount,14572.2);assert.equal(frontend().api.derive(calc).contract,14572.2);
});
test("save waits for position metadata and does not announce success after a partial failure",async()=>{
  const calls=[],calc=parsed();let release;
  const grid={snapshotForSave:()=>calc.positions.map(p=>({...p,positionId:p.id})),persistForJob:async(id,positions)=>{calls.push("metadata");assert.equal(id,"99001");assert.equal(positions.length,10);await new Promise(resolve=>release=resolve)}};
  const ui=frontend({window:{KristaCalculationGridV2:grid},fetch:async(url,init)=>{calls.push("calculation");const body=JSON.parse(init.body);return {ok:true,text:async()=>JSON.stringify({calculation:body.calculation})}}});
  ui.api.set(calc);ui.api.stubRender();const saving=ui.api.save();while(!release)await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,["calculation","metadata"]);assert.equal(ui.elements.kcv2Save.disabled,true);assert(!ui.elements.kcv2SaveMsg.textContent.includes("✓"));release();await saving;assert.match(ui.elements.kcv2SaveMsg.textContent,/✓ Gespeichert/);
  grid.persistForJob=async()=>{throw new Error("metadata unavailable")};await ui.api.save();assert.match(ui.elements.kcv2SaveMsg.textContent,/Speichern nicht vollständig/);assert(!ui.elements.kcv2SaveMsg.textContent.includes("✓"));
});
function gridPage(responder=async()=>({})){ 
  const listeners={},elements={kgridv2Css:{},kcv2Rows:{}},window={addEventListener(){}},location={search:"",hash:"#99001",origin:"https://example.test"};
  const document={readyState:"loading",documentElement:{},getElementById:id=>elements[id]||null,querySelector:()=>null,querySelectorAll:()=>[],addEventListener(type,fn){listeners[type]=fn}};
  const source=fs.readFileSync(path.join(root,"public/ui/baustellen-calculation-grid-v2.js"),"utf8").replace("  window.KristaCalculationGridV2 =",`  window.test={load,install,metaForRow,set(rows,meta=[]){currentJobId="99001";calcRows=rows;metaRows=meta},rows(){return calcRows}};\n  window.KristaCalculationGridV2 =`);
  vm.runInNewContext(source,{window,document,location,URL,URLSearchParams,console,setTimeout(){},MutationObserver:class{observe(){}},fetch:async url=>({ok:true,text:async()=>JSON.stringify(await responder(url))})});
  return {api:window.test,listeners};
}
test("grid uses imported units and alternatives immediately, and ignores a late response from before the import",async()=>{
  let release;const wait=new Promise(resolve=>release=resolve),grid=gridPage(async()=>{await wait;return {calculation:{positions:[{id:"old"}]},rows:[]}}),calc=parsed();
  grid.api.install();const pending=grid.api.load(true);grid.listeners["krista:order-pdf-parsed"]({detail:{jobId:"99001",positions:calc.positions}});release();await pending;
  assert.equal(grid.api.rows().length,10);
  const tr={querySelector:()=>null};assert.equal(grid.api.metaForRow(tr,0).unit,"m²");assert.equal(grid.api.metaForRow(tr,9).unitPrice,1);assert.equal(grid.api.metaForRow(tr,9).calcIncluded,false);
  grid.api.set(calc.positions,[{positionId:"previous-import",quantity:999,unit:"m",unitPrice:5}]);assert.equal(grid.api.metaForRow(tr,0).quantity,110);
});
