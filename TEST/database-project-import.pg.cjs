'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {PGlite}=require(process.env.PGLITE_MODULE_PATH||'@electric-sql/pglite');
const {prepareProjects,importProjects}=require('../storage/import-project-metadata');
test('project metadata: preserve missing fields, rejected offers, bytes, replay and atomic rollback',async()=>{
 const db=new PGlite();const pool={connect:async()=>({query:(s,a)=>db.query(s,a),release(){}})};
 try{
  for(const f of ['002-domain-core.sql','003-business-domain.sql','004-people-communications.sql','005-project-import-review.sql'])await db.exec(fs.readFileSync(path.join(__dirname,'../migrations',f),'utf8'));
  const companyId=(await db.query("INSERT INTO kristine.companies(name) VALUES('A') RETURNING id")).rows[0].id;
  const sourceInstanceId=(await db.query("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'kristine','test') RETURNING id",[companyId])).rows[0].id;
  const records=[{externalId:'001',originalText:'{ "name": "", "status": "Geschlossen", "extra": 7 }'},{externalId:'002',originalText:'{"name":"Offer","status":"Angebot – abgelehnt"}'},{externalId:'003',originalText:'{"name":"No status"}'}];
  const run=rs=>importProjects(pool,{companyId,sourceInstanceId,records:rs});
  assert.deepEqual(await run(records),{created:3,unchanged:0,review:2,rejected:1});
  assert.deepEqual(await run(records),{created:0,unchanged:3,review:2,rejected:1});
  const rows=(await db.query('SELECT project_number,name,status,offer_outcome,import_review_reasons FROM kristine.projects ORDER BY project_number')).rows;
  assert.equal(rows[0].name,'');assert.deepEqual(rows[0].import_review_reasons,['name_missing']);assert.equal(rows[1].status,1);assert.equal(rows[1].offer_outcome,'rejected');assert.equal(rows[2].status,null);
  assert.equal((await db.query('SELECT original_text FROM kristine.source_record_versions WHERE original_text=$1',[records[0].originalText])).rows[0].original_text,records[0].originalText);
  const before=(await db.query('SELECT count(*)::int n FROM kristine.import_runs')).rows[0].n;
  await assert.rejects(run([{externalId:'004',originalText:'{"name":"New","status":2}'},{...records[0],originalText:'{"name":"Changed","status":5}'}]),/review/);
  assert.equal((await db.query('SELECT count(*)::int n FROM kristine.projects')).rows[0].n,3);assert.equal((await db.query('SELECT count(*)::int n FROM kristine.import_runs')).rows[0].n,before);
  assert.throws(()=>prepareProjects([{externalId:'X',originalText:'{"name":"X","status":"other"}'}]),/Unknown/);
  assert.throws(()=>prepareProjects([{externalId:'X',originalText:'{"jobId":"Y"}'}]),/mismatch/);
  assert.throws(()=>prepareProjects([records[0],records[0]]),/duplicate/);
  await assert.rejects(db.query('UPDATE kristine.projects SET status=NULL WHERE project_number=$1',['001']));
  await assert.rejects(db.query('UPDATE kristine.projects SET status=5 WHERE offer_outcome=$1',['rejected']));
 }finally{await db.close();}
});
