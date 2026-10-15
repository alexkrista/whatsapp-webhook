"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const ROOT=path.resolve(__dirname,"..");
const app=fs.readFileSync(path.join(ROOT,"public/ui/offer-v2-app.js"),"utf8");
const quickUi=fs.readFileSync(path.join(ROOT,"public/ui/offer-v2-quickstart-ui.js"),"utf8");
const quickHtml=fs.readFileSync(path.join(ROOT,"public/angebot-v2-schnell.html"),"utf8");
const C=require("../public/ui/offer-v2-core.js");
const Quick=require("../public/ui/offer-v2-quickstart-core.js");
const groups=[];
for(const p of C.catalog){
  let g=groups.find(x=>x.name===p.category);
  if(!g){g={name:p.category,items:[]};groups.push(g);}
  g.items.push(p);
}
const begin=app.indexOf("  function catalogSearchKey(value){"),end=app.indexOf("  function offerHeader(){",begin);
assert.ok(begin>0&&end>begin,"Grouped browser logic must exist");
const helpers=new Function("groups","C","e",app.slice(begin,end)+";return {catalogSearchKey,catalogBrowser,filterCatalogBrowser};")(groups,C,C.esc);
function fakePanel(){
  const sections=groups.map(g=>{
    const rows=g.items.map(p=>({dataset:{catalogText:p.text+" "+p.unit},hidden:false}));
    return{dataset:{catalogGroupName:g.name},open:false,hidden:false,querySelectorAll(selector){return selector==="[data-catalog-item]"?rows:[]},rows};
  });
  const status={textContent:""},empty={hidden:true};
  return{sections,status,empty,
    querySelectorAll(selector){return selector==="[data-catalog-group]"?this.sections:[]},
    querySelector(selector){return selector==="[data-catalog-status]"?status:selector==="[data-catalog-empty]"?empty:null}};
}
test("Catalog groups are expandable, searchable and include every source template",()=>{
  const single=helpers.catalogBrowser(),bulk=helpers.catalogBrowser("bulk");
  assert.equal((single.match(/data-catalog-group-name/g)||[]).length,groups.length);
  assert.equal((single.match(/data-catalog-item/g)||[]).length,C.catalog.length);
  assert.equal((bulk.match(/data-bulk-check/g)||[]).length,C.catalog.length);
  assert.match(single,/type="search"/);
  assert.match(single,/data-action="add-pos"/);
  assert.match(single,/data-template-id="prepare-wall"/);
  assert.match(app,/nicht der WinWorker-Firmenstamm/);
});
test("Search by text and group, German accents, and empty-state filtering",()=>{
  const box=fakePanel();
  assert.equal(helpers.catalogSearchKey("Wände"),"wande");
  assert.equal(helpers.catalogSearchKey("Außenfassade"),"aussenfassade");
  assert.equal(helpers.filterCatalogBrowser(box,"spachteln"),1);
  assert.equal(box.sections.filter(g=>!g.hidden).length,1);
  assert.equal(helpers.filterCatalogBrowser(box,"Malerarbeiten"),groups.find(g=>g.name==="Malerarbeiten").items.length);
  assert.equal(helpers.filterCatalogBrowser(box,"acryl"),1);
  assert.equal(helpers.filterCatalogBrowser(box,"wildeswortohnetreffer"),0);
  assert.equal(box.empty.hidden,false);
  assert.equal(helpers.filterCatalogBrowser(box,""),C.catalog.length);
  assert.equal(box.empty.hidden,true);
});
test("Grouped catalog preserves expanded groups, search terms and checked items through rerender",()=>{
  assert.match(app,/function captureCatalogUi/);
  assert.match(app,/function restoreCatalogUi/);
  assert.match(app,/restoreCatalogUi\(beforeCatalog\)/);
  assert.match(app,/filterCatalogBrowser\(panel,previous\.search\)/);
  assert.match(app,/checked\.checked=previous\.checked\.includes/);
});
function quickHarness(){
  const nodes={};
  for(const id of ["quickResult","quickMeasurements","quickPositions","quickCount","quickCheck","quickNet","quickPrint","quickMessage"])
    nodes[id]={hidden:false,innerHTML:"",textContent:"",classList:{toggle(){}},querySelector(){return null},querySelectorAll(){return []}};
  const window={KristaOfferV2:C,KristaOfferV2Quick:Quick};
  const document={readyState:"loading",activeElement:null,addEventListener(){},getElementById(id){return nodes[id]||null}};
  const marker='  if(document.readyState==="loading")';
  assert.ok(quickUi.includes(marker));
  const injected=quickUi.replace(marker,'  window.__quickHarness={render,changeQuickField,setOffer(value){offer=value}};\n'+marker);
  new Function("window","document",injected)(window,document);
  return{ui:window.__quickHarness,nodes};
}
const wallner="Eingang und Stiegenhaus: Wände 48,20 m², Decke 16,40 m², Boden 16,40 m², Acrylfugen 22 m. Abdecken, spachteln, grundieren, streichen und Acrylfugen herstellen.";
test("Quick offer shows editable formulas and direct input for rates and amounts",()=>{
  assert.match(quickHtml,/id="quickMeasurements"/);
  assert.match(quickHtml,/Die Werte stammen aus deiner Kurzbeschreibung/);
  assert.match(quickHtml,/Musterpreise aus dem Testkatalog/);
  const draft=Quick.build({customer:"Test Wallner",title:"Eingang",brief:wallner,preset:"innen"}).offer;
  const h=quickHarness();h.ui.setOffer(draft);h.ui.render();
  assert.match(h.nodes.quickMeasurements.innerHTML,/data-quick-measure/);
  assert.match(h.nodes.quickPositions.innerHTML,/data-quick-rate/);
  assert.match(h.nodes.quickPositions.innerHTML,/data-quick-qty/);
  assert.match(h.nodes.quickPositions.innerHTML,/Musterpreis/);
  assert.match(h.nodes.quickPrint.innerHTML,/Wallner/);
});
test("Changing a shared wall measurement updates linked lines; manual quantity/price remain independent",()=>{
  const d=Quick.build({customer:"Wallner",title:"Eingang",brief:wallner,preset:"innen"}).offer,s=d.sections[0];
  const h=quickHarness();h.ui.setOffer(d);h.ui.render();
  const m=s.measurements.find(x=>x.label==="Wände"),p=s.rooms[0].positions.find(x=>x.text.includes("streichen"));
  const other=s.rooms[0].positions.find(x=>x.text.includes("spachteln"));
  const input=(dataset,value,type)=>({dataset,value,matches:q=>q===type});
  const before=C.totals(d).net;
  h.ui.changeQuickField(input({quickMeasure:m.id},"50","[data-quick-measure]"));
  assert.ok(C.totals(d).net>before);
  assert.equal(C.positionQuantity(s,other).value,50);
  h.ui.changeQuickField(input({quickQty:p.id},"15,5","[data-quick-qty]"));
  assert.equal(p.quantityMode,"manual");
  assert.equal(C.positionQuantity(s,p).value,15.5);
  assert.equal(C.positionQuantity(s,other).value,50);
  h.ui.changeQuickField(input({quickRate:p.id},"18,25","[data-quick-rate]"));
  assert.equal(p.unitPrice,18.25);
  assert.equal(p.priceOrigin,"manual");
  assert.ok(h.nodes.quickPrint.innerHTML.includes(C.currency(C.totals(d).gross)));
});
test("Quick offer never accesses LIVE services",()=>{
  assert.doesNotMatch(quickUi,/\bfetch\s*\(|XMLHttpRequest|\.sendBeacon\(/);
  assert.match(quickUi,/location\.href="\/angebot-v2"/);
  assert.doesNotMatch(quickHtml,/protokoll\.krista\.at/);
});
