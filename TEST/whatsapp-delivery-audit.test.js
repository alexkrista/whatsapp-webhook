'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createWhatsAppDeliveryAudit,keyOf}=require('../whatsapp-delivery-audit');

test('Meta 200 acceptance is NOT counted as WhatsApp delivery',async t=>{
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'wa-delivery-'));
  t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
  const warnings=[];
  const logger={error:(...args)=>warnings.push(args)};
  let instant=new Date('2026-10-09T04:00:00Z');
  const audit=createWhatsAppDeliveryAudit(dir,{clock:()=>instant,logger});
  const id='wamid.HBgMNDM2NjQzMjAzNTc3FQIAERgSMDc0AA==';
  await audit.recordAccepted({id,to:'436643203577',payloadType:'interactive',purpose:'chefReport'});
  let report=await audit.latest();
  assert.equal(report.totals.accepted,1);
  assert.equal(report.totals.delivered,0);
  assert.equal(report.rows[0].purpose,'chefReport');
  assert.equal(report.rows[0].recipientTail,'203577');
  assert.equal(report.rows[0].id,keyOf(id));
  assert.notEqual(report.rows[0].id,id);

  instant=new Date('2026-10-09T04:01:00Z');
  await audit.recordStatuses([{id,recipient_id:'436643203577',status:'failed',errors:[{code:131047,message:'SECRET raw recipient and chat body'}]}]);
  report=await audit.latest();
  assert.equal(report.totals.failed,1);
  assert.equal(report.rows[0].metaCode,131047);
  assert.equal(report.rows[0].status,'failed');
  assert.equal(warnings[0][0],'WHATSAPP_DELIVERY_FAILED');
  assert.equal(warnings[0][1].code,131047);
  const files=await fsp.readdir(path.join(dir,'_kristine','whatsapp-delivery-audit'));
  const disk=(await Promise.all(files.map(f=>fsp.readFile(path.join(dir,'_kristine','whatsapp-delivery-audit',f),'utf8')))).join('\n');
  assert.doesNotMatch(disk,/SECRET|436643203577|wamid\./);
  assert.match(disk,/131047/);
});

test('out of order accepted and duplicate callback remain auditable without counting duplicate deliveries',async t=>{
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'wa-delivery-order-'));
  t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
  const audit=createWhatsAppDeliveryAudit(dir,{clock:()=>new Date('2026-10-09T04:00:00Z')});
  const id='wamid.HBgMTESTCASE002==';
  assert.equal(await audit.recordStatuses([{id,recipient_id:'11111111',status:'delivered'}]),1);
  const unverified=await audit.latest();
  assert.equal(unverified.rows.length,0);
  assert.equal(unverified.totals.delivered,0);
  await audit.recordAccepted({id,to:'11111111',payloadType:'text',purpose:'planningReminder'});
  assert.equal(await audit.recordStatuses([{id,recipient_id:'11111111',status:'sent'},{id,recipient_id:'11111111',status:'delivered'}]),2);
  let status=await audit.latest();
  assert.equal(status.totals.delivered,1);
  assert.equal(status.rows[0].purpose,'planningReminder');
  assert.equal(status.rows[0].status,'delivered');
  assert.equal(await audit.recordStatuses([{id:'bad',status:'failed'},{id,status:'???'}]),0);
  status=await audit.latest();
  assert.equal(status.rows.length,1);
});
