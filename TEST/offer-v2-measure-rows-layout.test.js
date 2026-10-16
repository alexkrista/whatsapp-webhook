"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {JSDOM}=require("jsdom");
const C=require("../public/ui/offer-v2-core");
const app=fs.readFileSync(path.join(__dirname,"../public/ui/offer-v2-app.js"),"utf8");
const css=fs.readFileSync(path.join(__dirname,"../public/ui/offer-v2.css"),"utf8");
const extract=(start,end)=>{
  const a=app.indexOf(start),b=app.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,"Could not extract "+start);
  return app.slice(a,b);
};
const esc=s=>String(s??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const sectionFn=new Function("C","e","button","del",extract("function sectionMeasurements(sec){","function measurementChoices(sec,p){")+";return sectionMeasurements;")(
  C,esc,(label,action)=>'<button data-action="'+action+'">'+label+'</button>',(action,label)=>'<button data-action="'+action+'">'+label+'</button>'
);
const sample=()=>{
  const offer=C.sample(),s=offer.sections[0],m=s.measurements[0];
  m.formula="";
  m.calculations=[
    {label:"Nordwand",formula:"4,5×2",deduction:false},
    {label:"Fenster",formula:"1,5×2",deduction:true},
    {label:"Südwand",formula:"4×2,5",deduction:false}
  ];
  return{offer,s,m};
};
const domFor=section=>new JSDOM('<section data-sid="'+esc(section.id)+'">'+sectionFn(section)+'</section>',{url:"https://test.invalid"});

test("Aufmaß-Hauptzeile und Berechnungszeilen sind getrennt und horizontal",()=>{
  const {s,m}=sample(),dom=domFor(s),doc=dom.window.document;
  const entry=doc.querySelector('.measure-entry[data-mid="'+m.id+'"]');
  assert.ok(entry);
  const main=entry.querySelector(".measure-main-row"),calc=entry.querySelector(".measure-calculations");
  assert.ok(main&&calc);
  assert.equal(main.children.length,5);
  assert.equal(main.contains(calc),false,"Berechnungszeilen dürfen nicht in der 84px Mengenspalte stehen");
  assert.equal(calc.parentElement,entry);
  assert.equal(calc.querySelectorAll(".measure-calc-row").length,3);
  for(const row of calc.querySelectorAll(".measure-calc-row")){
    assert.equal(row.children.length,5);
    assert.ok(row.querySelector("[data-calc-formula]"));
    assert.ok(row.querySelector("[data-calc-result]"));
  }
  assert.equal(entry.querySelector('[data-calc-result="0"]').textContent,"9");
  assert.equal(entry.querySelector('[data-calc-result="1"]').textContent,"− 3");
  assert.equal(entry.querySelector('[data-measure-result]').textContent,"16");
  assert.deepEqual([...entry.querySelectorAll(".measure-calc-buttons button")].map(x=>x.textContent),["+ Berechnungszeile","− Abzug"]);
  dom.window.close();
});

test("Knöpfe nebeneinander und Rechenzeilen als Grid dargestellt",()=>{
  assert.match(css,/\.measure-entry \.measure-calc-heading,\s*\.measure-entry \.measure-calc-row\s*\{\s*display:grid/);
  assert.match(css,/\.measure-entry \.measure-calc-buttons\s*\{\s*display:flex;\s*flex-direction:row;\s*flex-wrap:nowrap/);
  assert.match(css,/\.measure-entry \.measure-calculations\s*\{\s*display:block;\s*width:100%/);
  assert.match(css,/@media\(max-width:820px\)\s*\{\s*\.measurement-panel\{overflow-x:auto\}/);
});

test("Berechnung bearbeiten, Abzug umschalten, Zeile hinzufügen und löschen funktioniert weiterhin",()=>{
  const {s,m}=sample(),dom=domFor(s),doc=dom.window.document;
  let rebuilds=0,previews=0,saves=0;
  const findNodes=t=>({measure:s.measurements.find(x=>x.id===t.closest("[data-mid]")?.dataset.mid)});
  const eventFn=new Function("findNodes","renderEditor","updatePreview","autosave","selectedPositions","offer",
    extract("function documentChange(event){","function documentClick(event){")+";return documentChange;")(
    findNodes,()=>rebuilds++,()=>previews++,()=>saves++,new Set(),{sections:[s]}
  );
  const entry=doc.querySelector('.measure-entry[data-mid="'+m.id+'"]');
  assert.equal(C.measured(m).value,16);
  eventFn({target:entry.querySelector('[data-calc-sign="1"]'),type:"click"});
  assert.equal(C.measured(m).value,22);
  const formula=entry.querySelector('[data-calc-formula="0"]');
  formula.value="5×2";
  eventFn({target:formula,type:"input"});
  assert.equal(C.measured(m).value,23);
  eventFn({target:entry.querySelector('[data-calc-add="minus"]'),type:"click"});
  assert.equal(m.calculations.length,4);
  assert.equal(m.calculations[3].deduction,true);
  eventFn({target:entry.querySelector('[data-calc-remove="1"]'),type:"click"});
  assert.equal(m.calculations.length,3);
  assert.equal(rebuilds,3);
  assert.equal(previews,4);
  assert.equal(saves,4);
  dom.window.close();
});
