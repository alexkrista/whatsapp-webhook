"use strict";
const assert=require("assert"),fs=require("fs"),path=require("path"),root=path.join(__dirname,"..");
const server=fs.readFileSync(path.join(root,"kristine.js"),"utf8"),beulen=fs.readFileSync(path.join(root,"public","ui","kristine-beulen.js"),"utf8"),access=fs.readFileSync(path.join(root,"public","ui","access-status-ui.js"),"utf8"),services=fs.readFileSync(path.join(root,"public","ui","krisadmin-services-core.js"),"utf8");
assert.match(server,/unknown-assignment/);assert.match(server,/row\?\.type==="assignment_deviation"/);assert.match(beulen,/data-unknown-delete/);assert.match(beulen,/method:"DELETE"/);assert.match(access,/servicesHealthy=overall\(d\)!=="red"/);assert.doesNotMatch(services,/createElement\("button"\)[\s\S]{0,300}kristaServicesTopLamp/);assert.match(services,/#kristaAccessSlot \[data-services\]/);
console.log("OK: Leere unbekannte Zuordnungen sind einzeln löschbar; Dienste-Lampe bleibt eindeutig.");
