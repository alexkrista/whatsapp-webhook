'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {PGlite}=require(process.env.PGLITE_MODULE_PATH||'@electric-sql/pglite');const {importProjects}=require('../storage/import-project-metadata');const {prepareContacts,importContactGroups}=require('../storage/import-contact-groups');
test('contact groups preserve households, typed people, company contacts, exact file and replay',async()=>{
 const db=new PGlite();const pool={connect:async()=>({query:(s,a)=>db.query(s,a),release(){}})};
 try{
  for(const f of ['002-domain-core.sql','003-business-domain.sql','004-people-communications.sql','005-project-import-review.sql','006-address-source-mapping.sql','007-contact-groups.sql'])await db.exec(fs.readFileSync(path.join(__dirname,'../migrations',f),'utf8'));
  const companyId=(await db.query("INSERT INTO kristine.companies(name) VALUES('A') RETURNING id")).rows[0].id;const other=(await db.query("INSERT INTO kristine.companies(name) VALUES('B') RETURNING id")).rows[0].id;
  const sourceInstanceId=(await db.query("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'kristine','test') RETURNING id",[companyId])).rows[0].id;
  const contacts=[{id:'001',displayName:'Family',phone:'shared',email:'shared@example.test',roles:['owner'],roleData:{owner:{womanFirstName:'Anna',womanLastName:'A',womanEmail:'anna@example.test',manFirstName:'Ben',manLastName:'B',phoneOwnerMan:'individual'}}},{id:'002',displayName:'Company',company:'Company',roles:['owner'],roleData:{owner:{ownerRole:'Firma',customer:'Company',womanFirstName:'Clara',womanLastName:'C'}}},{id:'003',displayName:'Not split',roles:['owner'],roleData:{owner:{sharedLastName:'Surname',womanLastName:'Surname',manLastName:'Surname'}}},{id:'004',displayName:'Architect',roles:['architect'],firstName:'Anna',lastName:'A'}];
  const originalText='[\n'+contacts.map(c=>JSON.stringify(c)).join(',\n')+'\n]';
  const projects=[{externalId:'001',originalText:JSON.stringify({name:'Site',status:2,projectContacts:{owner:{masterContactId:'001'},architect:{masterContactId:'004'}}})}];await importProjects(pool,{companyId,sourceInstanceId,records:projects});
  const run=t=>importContactGroups(pool,{companyId,sourceInstanceId,originalText:t});const first=await run(originalText);assert.equal(first.groupsCreated,4);assert.equal(first.peopleCreated,4);assert.equal(first.organizationsCreated,1);assert.equal(first.linksVerified,2);assert.equal(first.review,1);
  const replay=await run(originalText);assert.equal(replay.groupsCreated,0);assert.equal(replay.peopleCreated,0);assert.equal(replay.groupsUnchanged,4);assert.equal(replay.linksCreated,0);assert.equal(replay.linksVerified,2);
  const unrelated=(await db.query("INSERT INTO kristine.projects(company_id,project_number,name,status) VALUES($1,'unrelated','Other',1) RETURNING id",[companyId])).rows[0].id;
  await assert.rejects(db.query('UPDATE kristine.project_contact_group_links SET project_id=$1',[unrelated]),/source mismatch/);
  await assert.rejects(db.query("UPDATE kristine.project_contact_group_links SET role='siteManager' WHERE role='owner'"),/source mismatch/);
  await assert.rejects(db.query('UPDATE kristine.project_contact_group_links SET company_id=$1',[other]),/source mismatch/);
  const anna=(await db.query("SELECT email,phone FROM kristine.parties WHERE display_name='Anna A' ORDER BY email NULLS FIRST")).rows;assert.equal(anna.length,2);assert.deepEqual(anna[0],{email:null,phone:null});assert.deepEqual(anna[1],{email:'anna@example.test',phone:null});
  const archived=(await db.query("SELECT v.original_text FROM kristine.source_records s JOIN kristine.source_record_versions v ON v.source_record_id=s.id WHERE s.entity_type='contact_master_file'")).rows[0].original_text;assert.equal(archived,originalText);
  const before=(await db.query('SELECT count(*)::int n FROM kristine.import_runs')).rows[0].n;await assert.rejects(run(originalText.replace('Family','Changed')),/changed/);assert.equal((await db.query('SELECT count(*)::int n FROM kristine.import_runs')).rows[0].n,before);
  await assert.rejects(importContactGroups(pool,{companyId:other,sourceInstanceId,originalText}),/mismatch/);
  assert.throws(()=>prepareContacts(JSON.stringify([contacts[0],contacts[0]])),/duplicate/);
  await db.query("UPDATE kristine.contact_groups SET phone='altered' WHERE display_name='Family'");await assert.rejects(run(originalText),/verification/);assert.equal((await db.query('SELECT count(*)::int n FROM kristine.import_runs')).rows[0].n,before);
 }finally{await db.close();}
});
test('unknown project contact reference rolls back file archive and all new groups',async()=>{
 const db=new PGlite();const pool={connect:async()=>({query:(s,a)=>db.query(s,a),release(){}})};
 try{
  for(const f of ['002-domain-core.sql','003-business-domain.sql','004-people-communications.sql','005-project-import-review.sql','006-address-source-mapping.sql','007-contact-groups.sql'])await db.exec(fs.readFileSync(path.join(__dirname,'../migrations',f),'utf8'));
  const companyId=(await db.query("INSERT INTO kristine.companies(name) VALUES('A') RETURNING id")).rows[0].id;const sourceInstanceId=(await db.query("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'kristine','test') RETURNING id",[companyId])).rows[0].id;
  await importProjects(pool,{companyId,sourceInstanceId,records:[{externalId:'P',originalText:'{"name":"P","status":1,"projectContacts":{"owner":{"masterContactId":"missing"}}}'}]});
  await assert.rejects(importContactGroups(pool,{companyId,sourceInstanceId,originalText:'[{"id":"C","displayName":"C","roles":["owner"]}]'}),/Unknown/);
  assert.equal((await db.query('SELECT count(*)::int n FROM kristine.contact_groups')).rows[0].n,0);
  assert.equal((await db.query("SELECT count(*)::int n FROM kristine.source_records WHERE entity_type='contact_master_file'")).rows[0].n,0);
 }finally{await db.close();}
});
