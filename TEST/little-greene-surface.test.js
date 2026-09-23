const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const script=fs.readFileSync(path.join(__dirname,'../public/ui/baustellen-chronik.js'),'utf8');
const functions=script.slice(script.indexOf('  function surfaceCategory('),script.indexOf('  function collectSurfacePeople('));
const context={num:v=>Number(v)||0,dayKey:(...values)=>values.find(Boolean)?.slice(0,10)||''};vm.createContext(context);vm.runInContext(functions,context);
const bookings=[{source:'innovatint-history',product:'Intelligent Matt Emulsion',colourTone:'NCS S 3060-Y20R',liters:2.5,component:'gang und schlafzimmer',baseName:'Yellow',size:'2,5 L'}, {source:'innovatint-history',product:'Intelligent Satin',colourTone:'NCS S 2020-Y20R',liters:1}, {source:'manual',product:'Abdeckband',quantity:1}, {source:'manual',brand:'Little Greene',product:'Absolute Matt',liters:5}];
let rows=context.collectSurface([],[],[],bookings);
assert.equal(rows.filter(x=>x.relevant).length,3);
const matt=rows.find(x=>x.name.startsWith('Intelligent Matt'));
assert.equal(matt.category,'Beschichtung');assert.equal(matt.quantity,2.5);assert.equal(matt.use,'gang und schlafzimmer');
assert.equal(rows.find(x=>x.name==='Abdeckband').relevant,false);
rows=context.collectSurface([],[],[{key:matt.key,relevant:false,note:'Bestehende Notiz',use:'Wohnzimmer'}],bookings);
assert.equal(rows.find(x=>x.key===matt.key).relevant,true);assert.equal(rows.find(x=>x.key===matt.key).note,'Bestehende Notiz');
assert.equal(context.collectSurface([],[],[],[{source:'innovatint-history',product:'Intelligent Primer',quantity:1}])[0].category,'Grundierung');
const machine=[
  {id:'mix-1',source:'innovatint-history',product:'Absolute Matt',colourTone:'Book Room Green 322',quantity:1,liters:2.5,size:'2,5 L'},
  {id:'mix-2',source:'innovatint-history',product:'Absolute Matt',colourTone:'Linen Wash 33',quantity:1,liters:10,size:'10 L'},
];
const regies=[{day:'2026-09-22',regie:{employees:[{name:'Cathrin'}],materials:[
  {reportId:'r1',name:'Absolute Matt Emulsion · 2,5 L',quantity:2,unit:'L',containerSize:2.5},
  {reportId:'r1',name:'Absolute Matt Emulsion · 5 L',quantity:4,unit:'L',containerSize:5},
]}}];
const docs=[{id:'regie-office-r1',type:'regie_report',reportDate:'2026-09-22',materials:[
  {name:'Absolute Matt Emulsion · 2,5 L',quantity:2,unit:'L',containerSize:2.5},
  {name:'Absolute Matt Emulsion · 5 L',quantity:4,unit:'L',containerSize:5},
]}];
rows=context.collectSurface(regies,docs,[],machine);
assert.equal(rows.filter(x=>x.source==='Mischmaschine').length,2,'Maschinenfarben bleiben einzeln sichtbar');
const extra=rows.find(x=>x.source==='Regie · Zusatzmenge');
assert.equal(extra.quantity,2.5,'Von 25 l manuell bleiben nach 12,5 l Maschinenmenge nur 12,5 l bzw. 2,5 Fünfliter-Gebinde übrig');
assert.equal(rows.filter(x=>x.source==='Regie · Zusatzmenge').length,1,'Tagesregie und Dokumentation werden nicht doppelt gezählt');
const covered=[{day:'2026-09-22',regie:{materials:[{reportId:'r2',name:'Absolute Matt Emulsion · 2,5 L',quantity:1,unit:'L',containerSize:2.5},{reportId:'r2',name:'Absolute Matt Emulsion · 10 L',quantity:1,unit:'L',containerSize:10}]}}];
assert.equal(context.collectSurface(covered,[],[],machine).filter(x=>x.source?.startsWith('Regie')).length,0,'Eine vollständig von der Maschine gedeckte LG-Menge erscheint nicht doppelt');
console.log('OK: Little Greene machine quantities remain authoritative; manual Regie rows show only real excess and duplicates are removed.');
