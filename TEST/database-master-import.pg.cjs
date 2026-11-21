'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {PGlite}=require(process.env.PGLITE_MODULE_PATH||'@electric-sql/pglite');
const {importMasterData,prepareMasterData}=require('../storage/import-master-data');
test('master-data import: replay, original bytes, IDs and rollback',async()=>{
 const db=new PGlite();
 // Serial single-connection test adapter. Production requires a pg Pool.
 const pool={connect:async()=>({query:(s,a)=>db.query(s,a),release(){}})};
 try{
  for(const f of ['002-domain-core.sql','003-business-domain.sql','004-people-communications.sql'])await db.exec(fs.readFileSync(path.join(__dirname,'../migrations',f),'utf8'));
  const a=(await db.query("INSERT INTO kristine.companies(name) VALUES('A') RETURNING id")).rows[0].id;
  const b=(await db.query("INSERT INTO kristine.companies(name) VALUES('B') RETURNING id")).rows[0].id;
  const source=(await db.query("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'kristine','test') RETURNING id",[a])).rows[0].id;
  const originalText='{ "id": "001", "name": "Employee", "finkzeitPersonalNumber": "0026", "extra": {"preserved": true} }';
  const records=[{entityType:'employee',externalId:'001',originalText},{entityType:'project',externalId:'24138',originalText:JSON.stringify({jobId:'24138',name:'Project',status:'Laufend'})}];
  const run=()=>importMasterData(pool,{companyId:a,sourceInstanceId:source,records});
  const first=await run();assert.equal(first.created,2);
  const again=await run();assert.equal(again.created,0);assert.equal(again.unchanged,2);assert.deepEqual(again.mappings,first.mappings);
  assert.equal((await db.query('SELECT original_text FROM kristine.source_record_versions WHERE original_text=$1',[originalText])).rows[0].original_text,originalText);
  assert.equal((await db.query('SELECT external_id FROM kristine.employee_external_ids')).rows[0].external_id,'0026');
  const counts=async()=> (await db.query('SELECT (SELECT count(*)::int FROM kristine.employees) employees,(SELECT count(*)::int FROM kristine.import_runs) runs,(SELECT count(*)::int FROM kristine.source_records) records')).rows[0];
  const before=await counts();
  await assert.rejects(importMasterData(pool,{companyId:b,sourceInstanceId:source,records}),/belong/);
  await assert.rejects(importMasterData(pool,{companyId:a,sourceInstanceId:source,records:[{entityType:'employee',externalId:'002',originalText:'{"id":"002","name":"New"}'},{...records[0],originalText:originalText.replace('Employee','Changed')}]}),/review required/);
  assert.deepEqual(await counts(),before);
  assert.throws(()=>prepareMasterData([records[0],records[0]]),/Duplicate/);
  assert.throws(()=>prepareMasterData([{...records[1],originalText:'{"jobId":"24138","name":"Project","status":"Unknown"}'}]),/mapping/);
  // Another source with the same project number must not silently adopt this project.
  const legacy=(await db.query("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'winworker','old') RETURNING id",[a])).rows[0].id;
  await assert.rejects(importMasterData(pool,{companyId:a,sourceInstanceId:legacy,records:[records[1]]}));
  assert.deepEqual(await counts(),before);
 }finally{await db.close();}
});
