"use strict";
const assert=require("assert"),fs=require("fs"),path=require("path"),root=path.resolve(__dirname,"..");
const ui=fs.readFileSync(path.join(root,"public","ui","baustellen-knowledge-hub.js"),"utf8"),server=fs.readFileSync(path.join(root,"server.js"),"utf8");
for(const text of ["Dokumentation","Protokolle & Fotos","Pläne","E-Mails","Alte E-Mails hineinziehen","Markierte übernehmen",".msg oder .eml"])assert.ok(ui.includes(text),`UI fehlt: ${text}`);
assert.match(ui,/data-mail-queue/);assert.match(ui,/ondrop/);assert.match(server,/documentation\/mail/);assert.match(server,/parseMsg/);assert.match(server,/emlAttachments/);assert.match(server,/mail_imported/);
assert.match(ui,/mailDate/);assert.match(ui,/mailSender/);assert.match(ui,/<b>Von:<\/b>/);assert.match(ui,/<b>Datum:<\/b>/);assert.match(server,/fromName/);assert.match(server,/fromEmail/);
console.log("baustellen documentation mail import test: ok");
