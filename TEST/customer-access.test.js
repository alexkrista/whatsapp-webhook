"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),express=require("express");
const {registerCustomerAccess,mergePortalTasks}=require("../customer-portal-access");
const {PDFDocument,StandardFonts}=require("pdf-lib");
async function fixture(t,withOffice=false){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"customer-access-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const write=(file,value)=>{fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});fs.writeFileSync(path.join(dir,file),typeof value==="string"?value:JSON.stringify(value))};
 const metas={};for(const id of ["24177",...Array.from({length:38},(_,i)=>String(26001+i)),"25018"]){metas[id]={name:"Project "+id,notes:"DO_NOT_EXPOSE",billingRate:99999,customerPortal:{status:"prepared",mode:"collection",customerName:"Testkunde",customerPhone:"+430000001",customerEmail:"",modules:{projectFile:true,regie:true,communication:true,projectPoints:true},includedJobIds:Array.from({length:38},(_,i)=>String(26001+i))}};write(id+"/.meta.json",metas[id])}
 write("24177/.order-calculation.json",{netTotal:1100,sourceDocument:{name:"Auftrag.pdf",storedName:"order.pdf"},internal:"DO_NOT_EXPOSE"});write("24177/_auftrag/order.pdf","%PDF-original-project");
 write("26001/_documentation/report.pdf","%PDF-authorized-report");write("25018/_documentation/report.pdf","%PDF-other-customer");
 let members=["24177",...Array.from({length:38},(_,i)=>String(26001+i))],time=Date.now(),beforePdf=null,documentation={};
 const app=express();app.use(express.json());const access=registerCustomerAccess(app,{dataDir:dir,publicDir:path.join(__dirname,"../public"),publicBaseUrl:"https://protokoll.krista.at",now:()=>time,
 requireAdmin:(req,res)=>{if(req.headers["x-test-admin"]==="yes")return true;res.sendStatus(401);return false},readJobMeta:async id=>metas[id]||{},writeJobMeta:async(id,patch)=>{Object.assign(metas[id],patch);write(id+"/.meta.json",metas[id]);},collectionMembers:async id=>id==="24177"?members:null,
 listDaysForJob:async()=>["2026-09-01"],regiePathForDay:(id,day)=>path.join(dir,id,day,"regie.json"),readInvoicePdf:async entry=>{await beforePdf?.();return Buffer.from("%PDF-invoice-"+entry.projectNumber);},
 readDocumentation:async id=>documentation[id]||(["26001","25018"].includes(id)?[{id:"report-1",type:"regie_report",reportNumber:"M01",totalHours:12,totalNet:1000,storedName:"report.pdf",materials:[{name:"Farbe",quantity:5,unit:"l",purchaseCost:123456}],internal:"DO_NOT_EXPOSE"}]:[{id:"internal-mail",type:"mail",name:"DO_NOT_EXPOSE"}]),writeDocumentation:async(id,rows)=>{documentation[id]=rows;write(id+"/_documentation/index.json",rows)},listJobMedia:async()=>[],readEmployees:async()=>[{id:"alex",name:"Alexander Krista"}]});
 if(withOffice)require("../kristine").registerKristine(app,{dataDir:dir,requireAdmin:(req,res)=>{if(req.headers["x-test-admin"]==="yes")return true;res.sendStatus(401);return false;},readEmployees:async()=>[],readJobMeta:async id=>metas[id]||{}});
 const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s))});t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));
 const request=(route,opts={})=>fetch(`http://127.0.0.1:${server.address().port}`+route,{...opts,headers:{"Content-Type":"application/json",Origin:"https://protokoll.krista.at",...opts.headers}});
 const invite=async(preview=false)=>{const res=await request("/admin/api/job/24177/customer-portal/invitation",{method:"POST",headers:{"x-test-admin":"yes"},body:JSON.stringify({preview})});assert.equal(res.status,200);return res.json()};
 const login=async(url)=>{const ticket=new URL(url).hash.slice("#zugang=".length),res=await request("/kundenportal/api/session",{method:"POST",body:JSON.stringify({ticket})});assert.equal(res.status,200);const cookie=res.headers.get("set-cookie");assert.match(cookie,/HttpOnly/i);assert.match(cookie,/Secure/i);assert.match(cookie,/SameSite=Lax/i);return cookie.split(";")[0]};
 return {dir,write,metas,request,invite,login,access,advance:ms=>time+=ms,setMembers:ids=>members=ids,setBeforePdf:fn=>beforePdf=fn,setDocumentation:(id,rows)=>{documentation[id]=rows}};
}
test("WhatsApp link authenticates only the issued project, protects files and omits internal fields",async t=>{
 const f=await fixture(t);
 assert.equal((await f.request("/admin/api/job/24177/customer-portal/invitation",{method:"POST",body:"{}"})).status,401);
 assert.equal((await f.request("/kundenportal/api/project")).status,401);
 const invitation=await f.invite(),url=new URL(invitation.portalUrl);assert.equal(url.origin,"https://protokoll.krista.at");assert.equal(url.pathname,"/kundenportal");assert.equal(url.search,"");assert(!url.href.includes("chatgpt"));
 const secret=url.hash.split(".")[1];const grantFiles=fs.readdirSync(path.join(f.dir,"_system/customer-access/invitations"));assert.equal(grantFiles.length,1);assert(!fs.readFileSync(path.join(f.dir,"_system/customer-access/invitations",grantFiles[0]),"utf8").includes(secret));
 const cookie=await f.login(invitation.portalUrl),response=await f.request("/kundenportal/api/project?jobId=25018",{headers:{Cookie:cookie}}),data=await response.json();assert.equal(response.status,200);assert.equal(data.mainJobId,"24177");assert.equal(data.number,"S24177");assert.equal(data.projects.length,39);assert(!data.projects.some(row=>row.jobId==="25018"));assert.equal(data.reports.length,1);assert.equal(data.regieSummary.open.hours,12);assert.equal(data.regieSummary.open.total,1000);assert.equal(data.regieSummary.billed.total,0);assert(!JSON.stringify(data).includes("DO_NOT_EXPOSE"));assert(!JSON.stringify(data).includes("123456"));assert(!JSON.stringify(data).includes("physical"));assert(!JSON.stringify(data).includes("secretHash"));
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
test("office meeting notes keep responsibility and private photos in the customer portal",async t=>{
 const f=await fixture(t),image=Buffer.from("private-photo").toString("base64"),route="/admin/api/job/24177/customer-portal/points";
 assert.equal((await f.request(route)).status,401);
 const created=await f.request(route,{method:"POST",headers:{"x-test-admin":"yes"},body:JSON.stringify({title:"Fenster prüfen",area:"Wohnzimmer",text:"Bauherr kontrolliert die Farbe.",responsibility:"bauherr",photos:[{name:"fenster.jpg",data:"data:image/jpeg;base64,"+image}]})}),createdBody=await created.json();
 assert.equal(created.status,201,JSON.stringify(createdBody));const point=createdBody.point;assert.equal(point.responsibility,"bauherr");assert.equal(point.photos.length,1);
 const adminRows=await(await f.request(route,{headers:{"x-test-admin":"yes"}})).json();assert.equal(adminRows.points[0].title,"Fenster prüfen");
 const cookie=await f.login((await f.invite()).portalUrl),project=await(await f.request("/kundenportal/api/project",{headers:{Cookie:cookie}})).json(),visible=project.points.find(row=>row.id===point.id);
 assert.equal(visible.responsibility,"bauherr");assert.equal(visible.photos.length,1);assert.equal((await f.request(visible.photos[0].url)).status,401);
 const photo=await f.request(visible.photos[0].url,{headers:{Cookie:cookie}});assert.equal(photo.headers.get("content-type"),"image/jpeg");assert.equal(await photo.text(),"private-photo");
 const task=mergePortalTasks(f.dir,[]).find(row=>row.id==="customer_"+point.id);assert.equal(task.customerResponsibility,"bauherr");assert.equal(task.creatorId,"krista-office");
});
test("a finalized offer is visible and commissionable through an existing normal portal link",async t=>{
 const f=await fixture(t),draft={offerNumber:"2609002",offerRevision:1,positions:[{text:"Regiearbeiten",quantity:2,unit:"Std",unitPrice:75}],financials:{vatRate:20}};
 f.write("24177/.offer-draft.json",draft);f.write("24177/_offers/offer-2609002-v1.json",draft);f.write("24177/_documentation/angebot-2609002-v1.pdf","%PDF-approved-original"+"x".repeat(600));f.setDocumentation("24177",[{id:"offer-current",type:"offer",name:"Angebot 2609002.pdf",offerNumber:"2609002",offerRevision:1,customerVisible:true,storedName:"angebot-2609002-v1.pdf",source:"offer-approved-original"}]);
 const cookie=await f.login((await f.invite()).portalUrl),headers={Cookie:cookie},project=await(await f.request("/kundenportal/api/project",{headers})).json();
 assert.equal(project.offer.number,"2609002");assert.equal(project.offer.acceptance,null);assert(project.offer.pdfUrl);assert(project.files.some(row=>row.name==="Angebot 2609002.pdf"));
 const pdf=await f.request(project.offer.pdfUrl,{headers});assert.equal(pdf.status,200);assert.equal(pdf.headers.get("content-security-policy"),"default-src 'none'; frame-ancestors 'self'");assert.equal(pdf.headers.get("x-frame-options"),"SAMEORIGIN");assert.equal((await pdf.arrayBuffer()).byteLength>500,true);
 const question=await f.request("/kundenportal/api/point",{method:"POST",headers:{...headers,"x-csrf-token":project.csrf},body:JSON.stringify({module:"communication",offerQuestion:true,title:"Frage zu Angebot 2609002",text:"Ist der Termin noch frei?"})});assert.equal(question.status,201);assert.match(mergePortalTasks(f.dir,[]).find(row=>row.creatorId==="customer-portal").title,/Frage zu Angebot 2609002/);
 const rejected=await f.request("/kundenportal/api/offer/accept",{method:"POST",headers:{...headers,"x-csrf-token":project.csrf},body:JSON.stringify({confirmed:true})});assert.equal(rejected.status,400);
 const accepted=await f.request("/kundenportal/api/offer/accept",{method:"POST",headers:{...headers,"x-csrf-token":project.csrf},body:JSON.stringify({confirmed:true,termsAccepted:true,termsVersion:project.offer.terms.version,paymentTerm:"skonto5_2",preferredDate:"2026-10-10"})});assert.equal(accepted.status,200,await accepted.text());
 const refreshed=await(await f.request("/kundenportal/api/project",{headers})).json();assert.equal(refreshed.offer.acceptance.status,"accepted");assert.equal(refreshed.offer.acceptance.paymentLabel,"2 % Skonto bei Zahlung binnen 5 Tagen");assert.equal(refreshed.offer.acceptance.preferredDate,"2026-10-10");assert.equal(f.metas["24177"].status,"Auftrag");
 f.setDocumentation("24177",[]);const afterIndexLoss=await(await f.request("/kundenportal/api/project",{headers})).json();assert(afterIndexLoss.offer.pdfUrl,"Angenommene Angebots-PDF bleibt auch ohne Dokumentenindex sichtbar");const preserved=await f.request(afterIndexLoss.offer.pdfUrl,{headers});assert.equal(preserved.status,200);assert.equal((await preserved.arrayBuffer()).byteLength>500,true);
});
test("the stored browser-rendered dispatch PDF is shown once and replaces the wide fallback",async t=>{
 const f=await fixture(t),draft={offerNumber:"2609003",offerRevision:2,positions:[{text:"Regiearbeiten",quantity:18,unit:"Std",unitPrice:75}],financials:{vatRate:20}};
 f.write("24177/.offer-draft.json",draft);f.write("24177/_offers/offer-2609003-v2.json",draft);f.write("24177/_documentation/angebot-2609003-v2.pdf","%PDF-browser-render"+"x".repeat(600));f.write("24177/_documentation/angebot-2609003-v2-copy.pdf","%PDF-duplicate"+"x".repeat(600));
 f.setDocumentation("24177",[{id:"offer-current",type:"offer",name:"Angebot 2609003.pdf",offerNumber:"2609003",offerRevision:2,customerVisible:true,storedName:"angebot-2609003-v2.pdf",source:"offer-browser-render"},{id:"offer-duplicate",type:"pdf",name:"Angebot 2609003.pdf",customerVisible:true,storedName:"angebot-2609003-v2-copy.pdf"}]);
 const cookie=await f.login((await f.invite()).portalUrl),headers={Cookie:cookie},project=await(await f.request("/kundenportal/api/project",{headers})).json();
 assert(project.offer.pdfUrl,"Die gespeicherte Versand-PDF wird statt der breiten Ersatzliste angeboten");assert.equal(project.files.filter(row=>row.name==="Angebot 2609003.pdf").length,1,"Das Angebot erscheint in Dokumente nur einmal");
 const pdf=await f.request(project.offer.pdfUrl,{headers});assert.equal(pdf.status,200);assert.equal((await pdf.arrayBuffer()).byteLength>500,true);
});
test("legacy AGB pages are separated from an unaccepted browser-rendered offer PDF",async t=>{
 const f=await fixture(t),draft={offerNumber:"2609003",offerRevision:2,positions:[{text:"Malerarbeiten",quantity:1,unit:"PA",unitPrice:1000}],financials:{vatRate:20}},pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
 for(const text of ["Angebot 2609003 Seite 1","Angebot 2609003 Seite 2","ALLGEMEINE GESCHAEFTSBEDINGUNGEN","Muster-Widerrufsformular"]){const page=pdf.addPage();page.drawText(text,{x:40,y:760,size:12,font})}
 const bytes=Buffer.from(await pdf.save()),stored="angebot-2609003-v2.pdf";f.write("24177/.offer-draft.json",draft);f.write("24177/_offers/offer-2609003-v2.json",draft);fs.mkdirSync(path.join(f.dir,"24177/_documentation"),{recursive:true});fs.writeFileSync(path.join(f.dir,"24177/_documentation",stored),bytes);
 f.setDocumentation("24177",[{id:"offer-current",type:"offer",name:"Angebot 2609003.pdf",offerNumber:"2609003",offerRevision:2,customerVisible:true,storedName:stored,source:"offer-browser-render"}]);
 const cookie=await f.login((await f.invite()).portalUrl),headers={Cookie:cookie},project=await(await f.request("/kundenportal/api/project",{headers})).json(),response=await f.request(project.offer.pdfUrl,{headers}),offerOnly=await PDFDocument.load(await response.arrayBuffer());
 assert.equal(offerOnly.getPageCount(),2,"Im Portal bleiben nur die beiden Angebotsseiten");assert.equal((await PDFDocument.load(fs.readFileSync(path.join(f.dir,"24177/_documentation",stored)))).getPageCount(),2,"Auch die Dokumentkarte öffnet dieselbe Angebotsfassung");assert.equal(fs.readdirSync(path.join(f.dir,"24177/_offers/history")).length,1,"Die alte PDF mit AGB bleibt intern gesichert");
});
test("an unfinished offer draft stays hidden in a normal portal link",async t=>{
 const f=await fixture(t);f.write("24177/.offer-draft.json",{offerNumber:"DRAFT",offerRevision:1,positions:[]});
 const cookie=await f.login((await f.invite()).portalUrl),project=await(await f.request("/kundenportal/api/project",{headers:{Cookie:cookie}})).json();assert.equal(project.offer,null);
});
test("office meeting photos marked internal stay out of the customer file, portal and photo endpoint",async t=>{
 const f=await fixture(t),image=Buffer.from("internal-photo").toString("base64"),route="/admin/api/job/24177/customer-portal/points";
 const response=await f.request(route,{method:"POST",headers:{"x-test-admin":"yes"},body:JSON.stringify({title:"Interner Befund",area:"Gang",text:"Nur intern dokumentieren.",responsibility:"krista",photosInternal:true,photos:[{name:"intern.jpg",data:"data:image/jpeg;base64,"+image}]})}),body=await response.json();
 assert.equal(response.status,201,JSON.stringify(body));assert.equal(body.point.internalPhotoCount,1);assert.equal(body.point.photos[0].internal,true);
 const adminRows=await(await f.request(route,{headers:{"x-test-admin":"yes"}})).json(),adminPoint=adminRows.points.find(row=>row.id===body.point.id);assert.equal(adminPoint.internalPhotoCount,1);assert.equal(adminPoint.photos[0].internal,true);
 const cookie=await f.login((await f.invite()).portalUrl),project=await(await f.request("/kundenportal/api/project",{headers:{Cookie:cookie}})).json(),customerPoint=project.points.find(row=>row.id===body.point.id);assert(customerPoint);assert.equal(customerPoint.photos.length,0);
 const hiddenUrl=`/kundenportal/api/point-photo/${body.point.id}/${body.point.photos[0].id}`;assert.equal((await f.request(hiddenUrl,{headers:{Cookie:cookie}})).status,404);
 const stored=JSON.parse(fs.readFileSync(path.join(f.dir,"24177/_customer-portal",body.point.id+".json"),"utf8"));assert.equal(stored.photos[0].internal,true);
});
test("single-project access ignores unrelated project-number parameters and ungranted files",async t=>{
 const f=await fixture(t);f.metas["24177"].customerPortal.mode="single";f.metas["24177"].customerPortal.modules.projectFile=false;f.metas["24177"].customerPortal.modules.regie=false;
 const cookie=await f.login((await f.invite()).portalUrl),data=await(await f.request("/kundenportal/api/project?project=25018",{headers:{Cookie:cookie}})).json();assert.equal(data.projects.length,1);assert.equal(data.files.length,0);assert.equal(data.materials.length,0);
});

test("points keep titles and every office task transition while the customer is offline, including after restart and stale omission",async t=>{
 const f=await fixture(t,true),cookie=await f.login((await f.invite()).portalUrl),headers={Cookie:cookie},data=await(await f.request("/kundenportal/api/project",{headers})).json();
 const response=await f.request("/kundenportal/api/point",{method:"POST",headers:{...headers,"x-csrf-token":data.csrf},body:JSON.stringify({module:"projectPoints",title:"Fensterbank nachbessern",text:"Bitte die ganze Fensterbank ansehen.",area:"Küche",history:[{kind:"status",status:"done",date:"2020-01-01T00:00:00Z"}]})});assert.equal(response.status,201);
 let tasks=mergePortalTasks(f.dir,[]);const initial=structuredClone(tasks[0]);
 const save=async tasks=>{const response=await f.request("/kristine/api/tasks",{method:"PUT",headers:{"x-test-admin":"yes"},body:JSON.stringify({tasks})});assert.equal(response.status,200,await response.text());};
 await save(tasks.map(task=>({...task,status:"done",completedAt:new Date().toISOString(),reminder:"DO_NOT_EXPOSE_INTERNAL_COMMENT"})));
 await save(tasks.map(task=>({...task,status:"open",completedAt:null})));
 await save(tasks.map(task=>({...task,status:"done",completedAt:new Date().toISOString()})));
 await save([]); // Old browser omitted the point: durable task remains done.
 assert.equal(mergePortalTasks(f.dir,[])[0].status,"done");
 let result=await(await f.request("/kundenportal/api/project",{headers})).json(),point=result.points[0];
 assert.equal(point.title,"Fensterbank nachbessern");assert.equal(point.status,"done");assert.deepEqual(point.history.map(event=>event.status),["open","done","open","done"]);assert(point.history.every(event=>event.date));assert(!JSON.stringify(point).includes("INTERNAL"));
 const {customerPointView}=require("../customer-portal-points"),stored=JSON.parse(fs.readFileSync(path.join(f.dir,"24177/_customer-portal",point.id+".json"),"utf8"));assert.deepEqual(customerPointView(stored,mergePortalTasks(f.dir,[])[0]).history,point.history);
 const legacy=customerPointView({id:"old",text:"Alte Überschrift\nBeschreibung",date:initial.createdAt},{status:"done"});assert.equal(legacy.title,"Alte Überschrift");assert.equal(legacy.history[1].date,null);
 f.metas["24177"].customerPortal.modules.projectPoints=false;result=await(await f.request("/kundenportal/api/project",{headers})).json();assert.equal(result.points.length,0);
});

test("customer project contains material evidence and issued invoices; removing a module immediately removes access to both",async t=>{
 const f=await fixture(t);
 f.write("_kristine/paint/job-materials.jsonl",JSON.stringify({id:"b1",jobId:"26001",product:"Little Greene",colourTone:"Grey",liters:5})+"\n"+JSON.stringify({id:"b2",jobId:"25018",product:"PRIVATE OTHER MATERIAL"}));
 f.write("26001/2026-09-01/regie.json",{materials:[{name:"Spachtel",quantity:"1,5",unit:"kg"}]});
 const invoice={id:1,status:"issued",kind:"RE",invoiceNumber:"RE100",issueDate:"2026-09-01",net:100,gross:120};
 f.write("_system/ww-cache/billing/26001.json",{projectNumber:"26001",data:{projectNumber:"26001",projectIndex:100,found:true,invoices:[invoice]}});
 const cookie=await f.login((await f.invite()).portalUrl),headers={Cookie:cookie};let data=await(await f.request("/kundenportal/api/project",{headers})).json();
 assert(data.materials.some(row=>row.name==="Little Greene · Grey"));assert(data.materials.some(row=>row.name==="Spachtel"));assert(!JSON.stringify(data.materials).includes("PRIVATE"));assert.equal(data.invoices.length,1);
 const url=data.invoices[0].url;assert.equal((await f.request(url)).status,401);assert.equal((await f.request(url.replace("/26001/","/25018/"),{headers})).status,404);assert.equal(await(await f.request(url,{headers})).text(),"%PDF-invoice-26001");
 f.setBeforePdf(()=>{f.metas["24177"].customerPortal.modules.projectFile=false;});assert.equal((await f.request(url,{headers})).status,404);
 data=await(await f.request("/kundenportal/api/project",{headers})).json();assert.equal(data.materials.length,0);assert.equal(data.invoices.length,0);
});

async function preparedExport(f,headers){
 const start=await f.request("/kundenportal/api/exports",{method:"POST",headers,body:"{}"});assert.equal(start.status,202);const {id}=await start.json();
 for(let i=0;i<100;i++){const response=await f.request("/kundenportal/api/exports/"+id,{headers});assert.equal(response.status,200);const job=await response.json();if(job.status!=="preparing")return job;await new Promise(resolve=>setTimeout(resolve,20));}
 throw Error("Export did not finish");
}
test("offline ZIP contains scoped files and materials; combined close requires a delivered complete ZIP and preserves originals",async t=>{
 const f=await fixture(t);for(const id of ["24177",...Array.from({length:38},(_,i)=>String(26001+i))])f.write("_system/ww-cache/billing/"+id+".json",{projectNumber:id,data:{projectNumber:id,found:true,invoices:[]}});
 const cookie=await f.login((await f.invite()).portalUrl),data=await(await f.request("/kundenportal/api/project",{headers:{Cookie:cookie}})).json(),headers={Cookie:cookie,"x-csrf-token":data.csrf};
 assert.equal((await f.request("/kundenportal/api/exports",{method:"POST",headers:{Cookie:cookie},body:"{}"})).status,403);
 const job=await preparedExport(f,headers);assert.equal(job.status,"ready");assert.equal(job.complete,true);assert.equal((await f.request(job.downloadUrl)).status,401);
 assert.equal((await f.request("/kundenportal/api/close",{method:"POST",headers,body:JSON.stringify({afterExport:job.id})})).status,409);
 const zip=Buffer.from(await(await f.request(job.downloadUrl,{headers})).arrayBuffer()),filename=path.join(f.dir,"test-export.zip");fs.writeFileSync(filename,zip);
 const inspect=require("node:child_process").spawnSync("python3",["-c","import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({'names':z.namelist(),'html':z.read('START.html').decode(),'data':json.loads(z.read('projekt.json'))}))",filename],{encoding:"utf8"});assert.equal(inspect.status,0,inspect.stderr);
 const packed=JSON.parse(inspect.stdout);assert(packed.names.includes("START.html"));assert.equal(packed.data.projects.length,39);assert.equal(packed.data.materials[0].name,"Farbe");assert(packed.names.some(name=>name.endsWith("report.pdf")));assert(!JSON.stringify(packed).includes("DO_NOT_EXPOSE"));assert(!packed.html.includes("/kundenportal/api"));assert(!Object.hasOwn(packed.data,"csrf"));
 assert.equal((await f.request("/kundenportal/api/close",{method:"POST",headers,body:JSON.stringify({afterExport:job.id})})).status,200);assert.equal(f.metas["24177"].customerPortal.status,"off");assert.equal(fs.readFileSync(path.join(f.dir,"24177/_auftrag/order.pdf"),"utf8"),"%PDF-original-project");assert.equal((await f.request("/kundenportal/api/project",{headers})).status,401);
});
test("incomplete exports cannot close the portal, preview cannot close it, and another invitation cannot download an export",async t=>{
 const f=await fixture(t),invite=await f.invite(),cookie=await f.login(invite.portalUrl),data=await(await f.request("/kundenportal/api/project",{headers:{Cookie:cookie}})).json(),headers={Cookie:cookie,"x-csrf-token":data.csrf};
 const job=await preparedExport(f,headers);assert.equal(job.complete,false);assert(job.missing.length);await(await f.request(job.downloadUrl,{headers})).arrayBuffer();
 assert.equal((await f.request("/kundenportal/api/close",{method:"POST",headers,body:JSON.stringify({afterExport:job.id})})).status,409);assert.equal(f.metas["24177"].customerPortal.status,"prepared");
 const otherCookie=await f.login((await f.invite()).portalUrl);assert.equal((await f.request(job.downloadUrl,{headers:{Cookie:otherCookie}})).status,404);
 const previewCookie=await f.login((await f.invite(true)).portalUrl),preview=await(await f.request("/kundenportal/api/project",{headers:{Cookie:previewCookie}})).json();assert.equal((await f.request("/kundenportal/api/close",{method:"POST",headers:{Cookie:previewCookie,"x-csrf-token":preview.csrf},body:"{}"})).status,403);
 assert.equal((await f.request("/kundenportal/api/close",{method:"POST",headers,body:"{}"})).status,200);assert.equal(fs.readFileSync(path.join(f.dir,"26001/_documentation/report.pdf"),"utf8"),"%PDF-authorized-report");
});
