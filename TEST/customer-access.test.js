"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),express=require("express");
const {registerCustomerAccess,mergePortalTasks}=require("../customer-portal-access");
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"customer-access-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const write=(file,value)=>{fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});fs.writeFileSync(path.join(dir,file),typeof value==="string"?value:JSON.stringify(value))};
 const metas={};for(const id of ["24177",...Array.from({length:38},(_,i)=>String(26001+i)),"25018"]){metas[id]={name:"Project "+id,notes:"DO_NOT_EXPOSE",billingRate:99999,customerPortal:{status:"prepared",mode:"collection",customerName:"Testkunde",customerPhone:"+430000001",customerEmail:"",modules:{projectFile:true,regie:true,communication:true,projectPoints:true},includedJobIds:Array.from({length:38},(_,i)=>String(26001+i))}};write(id+"/.meta.json",metas[id])}
 write("24177/.order-calculation.json",{netTotal:1100,sourceDocument:{name:"Auftrag.pdf",storedName:"order.pdf"},internal:"DO_NOT_EXPOSE"});write("24177/_auftrag/order.pdf","%PDF-original-project");
 write("26001/_documentation/report.pdf","%PDF-authorized-report");write("25018/_documentation/report.pdf","%PDF-other-customer");
 let members=["24177",...Array.from({length:38},(_,i)=>String(26001+i))],time=Date.now();
 const app=express();app.use(express.json());const access=registerCustomerAccess(app,{dataDir:dir,publicDir:path.join(__dirname,"../public"),publicBaseUrl:"https://protokoll.krista.at",now:()=>time,
 requireAdmin:(req,res)=>{if(req.headers["x-test-admin"]==="yes")return true;res.sendStatus(401);return false},readJobMeta:async id=>metas[id]||{},collectionMembers:async id=>id==="24177"?members:null,
 readDocumentation:async id=>["26001","25018"].includes(id)?[{id:"report-1",type:"regie_report",reportNumber:"M01",totalHours:12,totalNet:1000,storedName:"report.pdf",materials:[{name:"Farbe",quantity:5,unit:"l",purchaseCost:123456}],internal:"DO_NOT_EXPOSE"}]:[{id:"internal-mail",type:"mail",name:"DO_NOT_EXPOSE"}],listJobMedia:async()=>[],readEmployees:async()=>[{id:"alex",name:"Alexander Krista"}]});
 const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s))});t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));
 const request=(route,opts={})=>fetch(`http://127.0.0.1:${server.address().port}`+route,{...opts,headers:{"Content-Type":"application/json",Origin:"https://protokoll.krista.at",...opts.headers}});
 const invite=async(preview=false)=>{const res=await request("/admin/api/job/24177/customer-portal/invitation",{method:"POST",headers:{"x-test-admin":"yes"},body:JSON.stringify({preview})});assert.equal(res.status,200);return res.json()};
 const login=async(url)=>{const ticket=new URL(url).hash.slice("#zugang=".length),res=await request("/kundenportal/api/session",{method:"POST",body:JSON.stringify({ticket})});assert.equal(res.status,200);const cookie=res.headers.get("set-cookie");assert.match(cookie,/HttpOnly/i);assert.match(cookie,/Secure/i);assert.match(cookie,/SameSite=Lax/i);return cookie.split(";")[0]};
 return {dir,write,metas,request,invite,login,access,advance:ms=>time+=ms,setMembers:ids=>members=ids};
}
test("WhatsApp link authenticates only the issued project, protects files and omits internal fields",async t=>{
 const f=await fixture(t);
 assert.equal((await f.request("/admin/api/job/24177/customer-portal/invitation",{method:"POST",body:"{}"})).status,401);
 assert.equal((await f.request("/kundenportal/api/project")).status,401);
 const invitation=await f.invite(),url=new URL(invitation.portalUrl);assert.equal(url.origin,"https://protokoll.krista.at");assert.equal(url.pathname,"/kundenportal");assert.equal(url.search,"");assert(!url.href.includes("chatgpt"));
 const secret=url.hash.split(".")[1];const grantFiles=fs.readdirSync(path.join(f.dir,"_system/customer-access/invitations"));assert.equal(grantFiles.length,1);assert(!fs.readFileSync(path.join(f.dir,"_system/customer-access/invitations",grantFiles[0]),"utf8").includes(secret));
 const cookie=await f.login(invitation.portalUrl),response=await f.request("/kundenportal/api/project?jobId=25018",{headers:{Cookie:cookie}}),data=await response.json();assert.equal(response.status,200);assert.equal(data.mainJobId,"24177");assert.equal(data.number,"S24177");assert.equal(data.projects.length,39);assert(!data.projects.some(row=>row.jobId==="25018"));assert.equal(data.reports.length,1);assert(!JSON.stringify(data).includes("DO_NOT_EXPOSE"));assert(!JSON.stringify(data).includes("123456"));assert(!JSON.stringify(data).includes("physical"));assert(!JSON.stringify(data).includes("secretHash"));
 const doc=data.files.find(row=>row.jobId==="26001");assert(doc);assert.equal((await f.request(doc.url)).status,401);const pdf=await f.request(doc.url,{headers:{Cookie:cookie}});assert.equal(await pdf.text(),"%PDF-authorized-report");assert.equal((await f.request("/kundenportal/api/file/guess-other-customer",{headers:{Cookie:cookie}})).status,404);
 assert.equal((await f.request(doc.url.replace("/26001/","/25018/"),{headers:{Cookie:cookie}})).status,404);
 assert.equal((await f.request("/kundenportal")).status,200);
});
test("revocation, module changes, removed collection members, changed contact and expiry take effect on existing sessions",async t=>{
 const f=await fixture(t),invite=await f.invite(),cookie=await f.login(invite.portalUrl),headers={Cookie:cookie};
 f.metas["24177"].customerPortal.modules.regie=false;let data=await (await f.request("/kundenportal/api/project",{headers})).json();assert.equal(data.reports.length,0);assert(!data.files.some(row=>row.group==="regie"));
 f.setMembers(["24177"]);data=await(await f.request("/kundenportal/api/project",{headers})).json();assert.equal(data.projects.length,1);
 f.metas["24177"].customerPortal.status="off";assert.equal((await f.request("/kundenportal/api/project",{headers})).status,403);f.access.revoke("24177");f.metas["24177"].customerPortal.status="active";assert.equal((await f.request("/kundenportal/api/project",{headers})).status,401);
 const second=await f.invite(),newCookie=await f.login(second.portalUrl);f.metas["24177"].customerPortal.customerPhone="+430000002";assert.equal((await f.request("/kundenportal/api/project",{headers:{Cookie:newCookie}})).status,401);
 const third=await f.invite();f.advance(8*86400000);assert.equal((await f.request("/kundenportal/api/session",{method:"POST",body:JSON.stringify({ticket:new URL(third.portalUrl).hash.slice(8)})})).status,401);
});
test("invalid secrets, cross-origin posts and preview writes are rejected; customer points become durable KRISTINE tasks",async t=>{
 const f=await fixture(t),invite=await f.invite(),ticket=new URL(invite.portalUrl).hash.slice(8);
 assert.equal((await f.request("/kundenportal/api/session",{method:"POST",headers:{Origin:"https://attacker.test"},body:JSON.stringify({ticket})})).status,403);
 assert.equal((await f.request("/kundenportal/api/session",{method:"POST",body:JSON.stringify({ticket:ticket.slice(0,33)+"A".repeat(43)})})).status,401);
 const cookie=await f.login(invite.portalUrl),data=await(await f.request("/kundenportal/api/project",{headers:{Cookie:cookie}})).json();
 const payload={module:"projectPoints",text:"Bitte Fensterbank prüfen",area:"Küche",jobId:"25018"};
 assert.equal((await f.request("/kundenportal/api/point",{method:"POST",headers:{Cookie:cookie},body:JSON.stringify(payload)})).status,403);
 const headers={Cookie:cookie,"x-csrf-token":data.csrf};assert.equal((await f.request("/kundenportal/api/point",{method:"POST",headers,body:JSON.stringify(payload)})).status,201);
 const tasks=mergePortalTasks(f.dir,[{id:"existing",title:"Keep me"}]);assert.equal(tasks.length,2);assert.equal(tasks[1].jobId,"24177");assert.equal(tasks[1].assigneeId,"alex");assert.equal(tasks[1].reminder,payload.text);assert.equal(mergePortalTasks(f.dir,tasks).length,2);
 f.write("_kristine/tasks.json",tasks.map(row=>({...row,status:"done"})));assert.equal((await(await f.request("/kundenportal/api/project",{headers})).json()).points[0].status,"done");
 f.metas["24177"].customerPortal.modules.projectPoints=false;assert.equal((await f.request("/kundenportal/api/point",{method:"POST",headers,body:JSON.stringify(payload)})).status,403);
 const preview=await f.invite(true),previewCookie=await f.login(preview.portalUrl),previewData=await(await f.request("/kundenportal/api/project",{headers:{Cookie:previewCookie}})).json();assert.equal(previewData.preview,true);
 assert.equal((await f.request("/kundenportal/api/point",{method:"POST",headers:{Cookie:previewCookie,"x-csrf-token":previewData.csrf},body:JSON.stringify({module:"communication",text:"Preview"})})).status,403);
});
test("single-project access ignores unrelated project-number parameters and ungranted files",async t=>{
 const f=await fixture(t);f.metas["24177"].customerPortal.mode="single";f.metas["24177"].customerPortal.modules.projectFile=false;f.metas["24177"].customerPortal.modules.regie=false;
 const cookie=await f.login((await f.invite()).portalUrl),data=await(await f.request("/kundenportal/api/project?project=25018",{headers:{Cookie:cookie}})).json();assert.equal(data.projects.length,1);assert.equal(data.files.length,0);assert.equal(data.materials.length,0);
});
