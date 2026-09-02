"use strict";
const assert=require("assert"),fs=require("fs"),path=require("path");
const root=path.join(__dirname,"..");
const manager=fs.readFileSync(path.join(root,"krista_service_manager.py"),"utf8");
const remote=fs.readFileSync(path.join(root,"public","ui","krisadmin-services-remote.js"),"utf8");
assert.match(remote,/credentials:\s*"include"/);
assert.match(manager,/Access-Control-Allow-Credentials", "true"/);
console.log("OK: Browser darf den privaten Dienstemanager mit Zugangsdaten lesen.");
