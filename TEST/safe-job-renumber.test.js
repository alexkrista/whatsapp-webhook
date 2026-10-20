"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {safeRenumber}=require("../safe-job-renumber");
const write=(p,data)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(data))};
test("safe renumber preserves project, reports, planning and alias",t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"safe-renumber-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 write(path.join(dir,"26094",".meta.json"),{name:"Latzer Oskar",status:"Auftrag"});
 write(path.join(dir,"26094","2026","10","19","info.json"),{jobId:"26094",text:"26094 remains literal in notes"});
 write(path.join(dir,"_kristine","assignments.json"),[{id:"x",jobId:"26094",hours:5}]);
 write(path.join(dir,"_system","regie.json"),{rows:[{jobId:"26094",reportNumber:"2"}]});
 const r=safeRenumber({dataDir:dir,oldJobId:"26094",newJobId:"26110"});
 assert.equal(r.status,"renumbered");
 assert.equal(fs.readFileSync(path.join(dir,"26110","2026","10","19","info.json"),"utf8").includes("26110"),true);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,"_kristine","assignments.json")))[0].jobId,"26110");
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,"_system","regie.json"))).rows[0].jobId,"26110");
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,"26110",".meta.json"))).wwProjectNumber,"");
 assert.equal(fs.realpathSync(path.join(dir,"26094")),path.join(dir,"26110"));
 assert.equal(safeRenumber({dataDir:dir,oldJobId:"26094",newJobId:"26110"}).status,"already_renumbered");
});
test("existing destination cannot be overwritten",t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"safe-renumber-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 write(path.join(dir,"26094",".meta.json"),{name:"Latzer"});write(path.join(dir,"26110",".meta.json"),{name:"Existing"});
 const r=safeRenumber({dataDir:dir,oldJobId:"26094",newJobId:"26110"});
 assert.equal(r.status,"blocked");
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,"26110",".meta.json"))).name,"Existing");
});
