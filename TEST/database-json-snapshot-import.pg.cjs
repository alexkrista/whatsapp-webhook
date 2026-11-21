'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.PGLITE_MODULE_PATH||'@electric-sql/pglite');
const {prepareSnapshots,importJsonSnapshots}=require('../storage/import-json-snapshots');
test('business snapshots preserve exact original files, duplicate JSONL rows, malformed sources and append-only changes',async()=>{
 const db=new PGlite(),pool={connect:async()=>({query:(s,a)=>db.query(s,a),release(){}})};
 try{
  await db.exec(fs.readFileSync(__dirname+'/../migrations/002-domain-core.sql','utf8'));
  const companyId=(await db.query("INSERT INTO kristine.companies(name) VALUES('A') RETURNING id")).rows[0].id;
  const sourceInstanceId=(await db.query("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'kristine','test') RETURNING id",[companyId])).rows[0].id;
  const files=[{path:'_kristine/events.jsonl',originalText:'{"id":1}\n{"id":1}\n'},{path:'26001/.meta.json',originalText:'{ "amount": 9007199254740993 }\n'},{path:'_system/old.json',originalText:'broken json'}];
  const run=files=>importJsonSnapshots(pool,{companyId,sourceInstanceId,files});
  const a=await run(files);assert.equal(a.filesVerified,3);assert.equal(a.versionsCreated,3);assert.equal(a.parseReview,1);
  const b=await run(files);assert.equal(b.versionsCreated,0);assert.equal(b.versionsUnchanged,3);
  const c=await run([{...files[0],originalText:'{"id":2}\n'}]);assert.equal(c.versionsCreated,1);
  const versions=(await db.query("SELECT v.original_text FROM kristine.source_records s JOIN kristine.source_record_versions v ON v.source_record_id=s.id WHERE s.external_id='_kristine/events.jsonl' ORDER BY v.original_text")).rows;assert.deepEqual(versions.map(x=>x.original_text),[files[0].originalText,'{"id":2}\n']);
  await assert.rejects(db.query('DELETE FROM kristine.source_record_versions'),/append-only/i);
  const before=(await db.query('SELECT count(*)::int n FROM kristine.import_runs')).rows[0].n;
  await assert.rejects(importJsonSnapshots(pool,{companyId:'00000000-0000-0000-0000-000000000001',sourceInstanceId,files}),/mismatch/);
  assert.equal((await db.query('SELECT count(*)::int n FROM kristine.import_runs')).rows[0].n,before);
  for(const path of ['../a.json','/a.json','_kristine/outlook-token.enc.json','_system/customer-access/a.json','_kristine/browser-sessions/a.json'])assert.throws(()=>prepareSnapshots([{path,originalText:'{}'}]),/excluded/);
  assert.throws(()=>prepareSnapshots([files[0],files[0]]),/duplicate/);
  const rows=prepareSnapshots(files);assert.equal(rows[0].metadata.entryCount,2);assert.equal(rows[2].metadata.parseValid,false);
 }finally{await db.close();}
});
