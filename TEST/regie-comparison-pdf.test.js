"use strict";
const assert=require("assert"),fs=require("fs"),path=require("path"),root=path.resolve(__dirname,"..");
const ui=fs.readFileSync(path.join(root,"public","ui","baustellen-knowledge-hub.js"),"utf8"),server=fs.readFileSync(path.join(root,"server.js"),"utf8"),pdf=fs.readFileSync(path.join(root,"regie-comparison-pdf.js"),"utf8");
assert.match(ui,/Stundenabgleich als PDF/);assert.doesNotMatch(ui,/<h3>Stundenabgleich pro Mitarbeiter und Tag<\/h3>/);assert.match(server,/regie-comparison\.pdf/);for(const text of ["Gestempelte Stunden","Regiestunden laut PDF","Gesamtdifferenz","Stundenwert","Material"])assert.ok(pdf.includes(text));console.log("regie comparison pdf test: ok");
