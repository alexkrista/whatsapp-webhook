"use strict";
const assert=require("assert"),fs=require("fs"),path=require("path"),root=path.join(__dirname,"..");
const ui=fs.readFileSync(path.join(root,"public/ui/baustellen-offer-builder.js"),"utf8"),server=fs.readFileSync(path.join(root,"server.js"),"utf8"),top=fs.readFileSync(path.join(root,"public/ui/topbar.js"),"utf8");
assert.match(top,/baustellen-offer-builder/);
for(const text of ["Kalkulation / Angebot","Regie + Material","Innenmalerei","Abdeckarbeiten – einmalig auswählen","Boden und Laufwege","Fassade","Fassadenfarbe 2x","Bad komplett","Fugenloses Bad","Terra Icon Unikatbelag","Kalkputz","Sumpfkalk-Wohlfühlputz","WDVS kurz","Isolierung kleben","Aufmaß genau","Überschlag: Boden × 3,5","Leistungsumfang / Räume","Mengen und Einheiten","Kalkulation dieser Position","Stundensatz","Materialaufschlag","Ab-/Zuschlag auf beides"])assert.ok(ui.includes(text),`UI enthält ${text}`);
for(const text of ["offer-draft","coverSteps","bathroomSteps","bathroomCompactSteps","limeSteps","wdvsSteps","bathroomCalc","measurement","scopeDescription","showQuantities","laborHoursPerUnit","materialMarkupPct","adjustmentPct"])assert.ok(server.includes(text),`Server enthält ${text}`);
console.log("OK: Angebotsbaukasten enthält Regie, Innenmalerei, Fassade, Bad, Kalkputz und WDVS.");
