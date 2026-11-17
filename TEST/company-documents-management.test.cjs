const express=require('express'),fs=require('fs/promises'),os=require('os'),path=require('path'),assert=require('assert');
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'company-doc-management-'));let mails=0;
 const app=express();app.use(express.json());require('../company-documents').registerCompanyDocuments(app,{dataDir:dir,requireAdmin:(q,s)=>q.headers['x-test']==='yes'||(s.sendStatus(403),false),sendMail:async()=>{mails++}});
 const server=app.listen(0);await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port+'/admin/api/company-documents';
 const req=(p='',method='GET',body,auth=true)=>fetch(base+p,{method,headers:{'Content-Type':'application/json',...(auth?{'x-test':'yes'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 try{
  const payload={company:'Test GmbH',kind:'Gewerbenachweis',date:'2026-11-17',filename:'maler.pdf',base64:Buffer.from('%PDF-1.4\nTEST').toString('base64')};
  assert.equal((await req('','POST',payload)).status,400);
  const response=await req('','POST',{...payload,designation:'Maler und Anstreicher'});assert.equal(response.status,201);const d=(await response.json()).document;
  assert.equal(d.designation,'Maler und Anstreicher');
  assert.equal((await req('/'+d.id,'PATCH',{designation:'Tischler'},false)).status,403);
  assert.equal((await req('/'+d.id,'DELETE',null,false)).status,403);
  assert.equal((await req('/'+d.id,'PATCH',{designation:''})).status,400);
  assert.equal((await req('/'+d.id,'PATCH',{designation:'Baumeister'})).status,200);
  assert.equal((await (await req()).json()).documents[0].designation,'Baumeister');
  assert.equal((await req('/'+d.id,'DELETE')).status,200);
  assert.equal((await (await req()).json()).documents.length,0);
  assert.equal((await (await req('?deleted=1')).json()).documents.length,1);
  assert.equal((await req('/'+d.id+'/pdf')).status,404);
  assert.equal((await req('/send','POST',{to:'test@example.com',ids:[d.id]})).status,400);assert.equal(mails,0);
  assert.equal((await req('/'+d.id+'/restore','POST',{},false)).status,403);
  assert.equal((await req('/'+d.id+'/restore','POST',{})).status,200);
  assert.equal((await (await req()).json()).documents[0].designation,'Baumeister');
  assert.equal((await req('/'+d.id+'/pdf')).status,200);
  assert.equal((await (await req('?deleted=1')).json()).documents.length,0);
  console.log('PASS: required trade designation, editing, protected routes, trash listing, deleted PDF/mail inaccessible, restoration with metadata and original PDF.');
 }finally{server.close();await fs.rm(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
