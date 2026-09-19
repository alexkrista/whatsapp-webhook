"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path"),express=require("express");
const {emlText,registerDocumentationMail}=require("../documentation-mail");
test("EML zeigt lesbaren Nachrichtentext mit Umlauten statt MIME und Word-Daten",()=>{
  const eml='Content-Type: multipart/mixed; boundary="outer"\r\n\r\n--outer\r\nContent-Type: multipart/alternative; boundary="inner"\r\n\r\n--inner\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nGr=C3=BC=C3=9Fe!\r\nBitte die Arbeiten laut Anlage.\r\n--inner\r\nContent-Type: text/html\r\n\r\n<p>Nicht doppelt zeigen</p>\r\n--inner--\r\n--outer\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document; name="Arbeiten.docx"\r\nContent-Disposition: attachment; filename="Arbeiten.docx"\r\nContent-Transfer-Encoding: base64\r\n\r\nUEsDBAAA\r\n--outer--';
  assert.equal(emlText(Buffer.from(eml)),"Grüße!\nBitte die Arbeiten laut Anlage.");
  assert.match(emlText(Buffer.from('Content-Type: text/html; charset=utf-8\n\n<p>Bitte prüfen</p><script>alert(1)</script>')),/Bitte prüfen/);
});
test("Archivierte Mail lesbar; Adresse nur bestätigt, konfliktgeschützt und ohne Doppelanlage übernehmen",async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"krista-mail-test-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dir,"mail.eml"),'From: Beispiel <neu@example.at>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nArbeiten wie besprochen.');
  let meta={contactEmail:"alt@example.at",customerMaster:{email:"alt@example.at",wwAddressId:"4711"},projectContacts:{owner:{customer:"Beispiel GmbH",email:"alt@example.at",womanEmail:"alt@example.at",manEmail:"kontakt@example.at"},architect:{email:"plan@example.at"}}},writes=0,history=0;
  const app=express();app.use(express.json());registerDocumentationMail(app,{requireAdmin:(req,res)=>req.headers["x-test-admin"]==="yes"||(res.status(401).end(),false),isSafeJobId:id=>id==="26101",readDocumentation:async()=>[{type:"mail",id:"m1",fromEmail:"Beispiel <neu@example.at>",storedName:"mail.eml"}],documentationDir:()=>dir,readJobMeta:async()=>meta,writeJobMeta:async(id,patch)=>{writes++;meta={...meta,...patch}},appendJobHistory:async()=>history++});
  const server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const endpoint=`http://127.0.0.1:${server.address().port}/admin/api/job/26101/documentation/mail/m1`,call=body=>fetch(endpoint+"/contact",{method:"POST",headers:{"Content-Type":"application/json","x-test-admin":"yes"},body:JSON.stringify(body)});
  assert.equal((await fetch(endpoint)).status,401);
  const mail=await (await fetch(endpoint,{headers:{"x-test-admin":"yes"}})).json();assert.equal(mail.body,"Arbeiten wie besprochen.");assert.equal(writes,0);
  assert.equal((await call({role:"owner",expectedEmail:"alt@example.at"})).status,400);
  assert.equal((await call({role:"owner",confirmed:true,expectedEmail:"wrong@example.at"})).status,409);assert.equal(writes,0);
  assert.equal((await call({role:"owner",confirmed:true,expectedEmail:"alt@example.at"})).status,200);
  assert.equal(meta.contactEmail,"neu@example.at");assert.equal(meta.customerMaster.email,"neu@example.at");assert.equal(meta.customerMaster.wwAddressId,"4711");assert.equal(meta.projectContacts.owner.manEmail,"kontakt@example.at");assert.equal(meta.projectContacts.architect.email,"plan@example.at");
  assert.equal((await (await call({role:"owner",confirmed:true,expectedEmail:"alt@example.at"})).json()).alreadyStored,true);assert.equal(writes,1);assert.equal(history,1);
});

test("Outlook-Absender nutzt die SMTP-Adresse statt einer internen Exchange-Kennung",()=>{
  const {senderAddress}=require("../kristine-msg-reader");
  assert.equal(senderAddress({senderEmail:"/O=EXCHANGE/CN=Users/CN=person",senderSmtpAddress:"person@example.at"}),"person@example.at");
  assert.equal(senderAddress({senderEmail:"/O=EXCHANGE/CN=Users/CN=person",headers:'From: "Beispiel" <office@example.at>\r\nTo: team@elsewhere.at'}),"office@example.at");
});
