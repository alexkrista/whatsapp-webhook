'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require(process.env.PGLITE_MODULE_PATH||'@electric-sql/pglite');
test('people, tasks and communication SQL integrity',async t=>{
 const db=new PGlite();const q=(s,a=[])=>db.query(s,a);
 const id=async(s,a=[]) => (await q(s+' RETURNING id',a)).rows[0].id;
 async function reject(s,a=[]){await q('SAVEPOINT expected_failure');let e;try{await q(s,a);}catch(x){e=x;}await q('ROLLBACK TO expected_failure');await q('RELEASE expected_failure');assert.ok(e,'Expected database rejection');}
 const isolated=(name,fn)=>t.test(name,async()=>{await q('BEGIN');try{await fn();}finally{await q('ROLLBACK');}});
 try{
  for(const file of ['002-domain-core.sql','003-business-domain.sql','004-people-communications.sql'])await db.exec(fs.readFileSync(path.join(__dirname,'../migrations',file),'utf8'));
  const a=await id("INSERT INTO kristine.companies(name) VALUES('A')"),b=await id("INSERT INTO kristine.companies(name) VALUES('B')");
  const person=await id("INSERT INTO kristine.parties(company_id,kind,display_name) VALUES($1,'person','Person')",[a]);
  const org=await id("INSERT INTO kristine.parties(company_id,kind,display_name) VALUES($1,'organization','Company')",[a]);
  const employee=await id("INSERT INTO kristine.employees(company_id,display_name) VALUES($1,'Employee')",[a]);
  const project=await id("INSERT INTO kristine.projects(company_id,project_number,name,status) VALUES($1,'26001','Project',2)",[a]);
  const task=await id("INSERT INTO kristine.tasks(company_id,project_id,title) VALUES($1,$2,'Task')",[a,project]);
  const account=await id("INSERT INTO kristine.communication_accounts(company_id,channel,account_key) VALUES($1,'email','office')",[a]);
  const conversation=await id("INSERT INTO kristine.conversations(company_id,account_id) VALUES($1,$2)",[a,account]);
  const message=await id("INSERT INTO kristine.messages(company_id,conversation_id,direction,occurred_at,idempotency_key) VALUES($1,$2,'inbound',now(),'mail-1')",[a,conversation]);
  await isolated('contact persons retain company and kind constraints',async()=>{
   await q('INSERT INTO kristine.contact_people(company_id,person_party_id) VALUES($1,$2)',[a,person]);
   await reject('INSERT INTO kristine.contact_people(company_id,person_party_id) VALUES($1,$2)',[a,org]);
   await reject('INSERT INTO kristine.contact_people(company_id,person_party_id) VALUES($1,$2)',[b,person]);
   await reject("UPDATE kristine.parties SET kind='organization' WHERE id=$1",[person]);
  });
  await isolated('optional profiles and dated employment history',async()=>{
   await q('INSERT INTO kristine.employee_profiles(company_id,employee_id) VALUES($1,$2)',[a,employee]);
   await reject("INSERT INTO kristine.employee_employment_periods(company_id,employee_id,starts_on,ends_on) VALUES($1,$2,'2026-10-06','2026-09-01')",[a,employee]);
   await reject("INSERT INTO kristine.employee_employment_periods(company_id,employee_id,starts_on,employment_percent) VALUES($1,$2,'2026-09-01',101)",[a,employee]);
  });
  await isolated('one active assignee; revisions and audit remain complete',async()=>{
   await q('INSERT INTO kristine.task_assignments(company_id,task_id,employee_id) VALUES($1,$2,$3)',[a,task,employee]);
   await reject('INSERT INTO kristine.task_assignments(company_id,task_id,employee_id) VALUES($1,$2,$3)',[a,task,employee]);
   await q("UPDATE kristine.tasks SET status='done',revision=99 WHERE id=$1",[task]);
   assert.equal((await q('SELECT revision FROM kristine.tasks WHERE id=$1',[task])).rows[0].revision,2);
   assert.equal((await q('SELECT count(*)::int n FROM kristine.task_events WHERE task_id=$1',[task])).rows[0].n,2);
   await reject('DELETE FROM kristine.task_events WHERE task_id=$1',[task]);
  });
  await isolated('messages deduplicate; original bodies and history are immutable',async()=>{
   await reject("INSERT INTO kristine.messages(company_id,conversation_id,direction,occurred_at,idempotency_key) VALUES($1,$2,'inbound',now(),'mail-1')",[a,conversation]);
   await reject("UPDATE kristine.messages SET body_text='changed' WHERE id=$1",[message]);
   await reject('TRUNCATE kristine.message_delivery_events');
   await reject("INSERT INTO kristine.message_recipients(company_id,message_id,role,address) VALUES($1,$2,'to','test@example.invalid')",[b,message]);
   await q('INSERT INTO kristine.message_provider_references(company_id,message_id,account_id,provider_message_id) VALUES($1,$2,$3,$4)',[a,message,account,'provider-1']);
   await reject('INSERT INTO kristine.message_provider_references(company_id,message_id,account_id,provider_message_id) VALUES($1,$2,$3,$4)',[a,message,account,'provider-1']);
  });
  await isolated('attachments preserve exact versions and company boundaries',async()=>{
   const doc=await id("INSERT INTO kristine.documents(company_id,document_type,title) VALUES($1,'mail','Original')",[a]);
   const ver=await id("INSERT INTO kristine.document_versions(company_id,document_id,version,storage_key,media_type,byte_count,sha256) VALUES($1,$2,1,'original.eml','message/rfc822',10,$3)",[a,doc,'a'.repeat(64)]);
   await q("INSERT INTO kristine.message_attachments(company_id,message_id,document_version_id,ordinal,filename) VALUES($1,$2,$3,1,'original.eml')",[a,message,ver]);
   await reject("INSERT INTO kristine.message_attachments(company_id,message_id,document_version_id,ordinal,filename) VALUES($1,$2,$3,2,'original.eml')",[b,message,ver]);
   await reject("UPDATE kristine.message_attachments SET filename='new' WHERE message_id=$1",[message]);
  });
  await isolated('office completion does not confirm a customer request',async()=>{
   const point=await id("INSERT INTO kristine.customer_portal_points(company_id,project_id,task_id,title) VALUES($1,$2,$3,'Request')",[a,project,task]);
   await q("INSERT INTO kristine.customer_portal_point_events(company_id,point_id,event_type,idempotency_key) VALUES($1,$2,'internal_done','event-1')",[a,point]);
   await q("UPDATE kristine.tasks SET status='done' WHERE id=$1",[task]);
   assert.equal((await q("SELECT count(*)::int n FROM kristine.customer_portal_point_events WHERE point_id=$1 AND event_type='customer_confirmed'",[point])).rows[0].n,0);
   await reject('UPDATE kristine.tasks SET project_id=NULL WHERE id=$1',[task]);
   await reject('DELETE FROM kristine.customer_portal_point_events WHERE point_id=$1',[point]);
  });
  assert.equal((await q("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='kristine' AND table_type='BASE TABLE'")).rows[0].n,92);
 }finally{await db.close();}
});
