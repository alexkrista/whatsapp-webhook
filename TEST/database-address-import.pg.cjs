'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {PGlite}=require(process.env.PGLITE_MODULE_PATH||'@electric-sql/pglite');const {importProjects}=require('../storage/import-project-metadata');const {prepareAddress,importProjectAddresses}=require('../storage/import-project-addresses');
test('site addresses retain house numbers, postal zeros, extras, source bytes and rollback',async()=>{
 const db=new PGlite();const pool={connect:async()=>({query:(s,a)=>db.query(s,a),release(){}})};
 try{
  for(const f of ['002-domain-core.sql','003-business-domain.sql','004-people-communications.sql','005-project-import-review.sql','006-address-source-mapping.sql'])await db.exec(fs.readFileSync(path.join(__dirname,'../migrations',f),'utf8'));
  const companyId=(await db.query("INSERT INTO kristine.companies(name) VALUES('A') RETURNING id")).rows[0].id;const other=(await db.query("INSERT INTO kristine.companies(name) VALUES('B') RETURNING id")).rows[0].id;
  const sourceInstanceId=(await db.query("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'kristine','test') RETURNING id",[companyId])).rows[0].id;
  const records=[{externalId:'001',originalText:'{ "name":"X","status":2,"street":"Street","houseNumber":"01a","postalCode":"0012","city":"City","addressExtra":"rear" }'},{externalId:'002',originalText:'{"name":"Y","status":3}'}];await importProjects(pool,{companyId,sourceInstanceId,records});
  const run=()=>importProjectAddresses(pool,{companyId,sourceInstanceId});assert.deepEqual(await run(),{projects:2,created:1,unchanged:0,verified:1,withoutAddress:1});assert.deepEqual(await run(),{projects:2,created:0,unchanged:1,verified:1,withoutAddress:1});
  const row=(await db.query('SELECT house_number,postal_code,address_extra,country_code FROM kristine.addresses')).rows[0];assert.deepEqual(row,{house_number:'01a',postal_code:'0012',address_extra:'rear',country_code:null});
  assert.equal((await db.query("SELECT v.original_text FROM kristine.source_records s JOIN kristine.source_record_versions v ON v.source_record_id=s.id WHERE s.entity_type='project_address'")).rows[0].original_text,records[0].originalText);
  await assert.rejects(importProjectAddresses(pool,{companyId:other,sourceInstanceId}),/mismatch/);assert.throws(()=>prepareAddress({postalCode:123}),/text/);assert.equal(prepareAddress({street:'',city:''}),null);
  await db.query("UPDATE kristine.addresses SET city='Changed'");const before=(await db.query('SELECT count(*)::int n FROM kristine.import_runs')).rows[0].n;await assert.rejects(run(),/verification/);assert.equal((await db.query('SELECT count(*)::int n FROM kristine.import_runs')).rows[0].n,before);
 }finally{await db.close();}
});
