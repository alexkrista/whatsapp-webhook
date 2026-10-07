'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.PGLITE_MODULE_PATH||'@electric-sql/pglite');
const {importDayHistory}=require('../storage/import-day-history');
const {reconcileDayHistory}=require('../storage/reconcile-day-history');
test('day reconciliation preserves baseline and revisions; latest full snapshot handles replay, removal and rollback',async()=>{
 const db=new PGlite(),pool={connect:async()=>({query:(s,a)=>db.query(s,a),release(){}})};
 try{
  for(const f of ['002-domain-core.sql','011-day-history-import.sql','017-day-reconciliation.sql'])await db.exec(fs.readFileSync(__dirname+'/../migrations/'+f,'utf8'));
  const companyId=(await db.query("INSERT INTO kristine.companies(name) VALUES('A') RETURNING id")).rows[0].id;
  const sourceInstanceId=(await db.query("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'kristine','A') RETURNING id",[companyId])).rows[0].id;
  const base={id:'close-1',employeeId:'former',date:'2026-07-29',status:'pending',confirmed:false,history:[{at:'first',action:'edit',before:[{to:'17:00'}],after:[{to:'17:06'}]}]};
  const files=raw=>['day-closes.json','day-releases.json','day-corrections.json','day-review-entries.json'].map((name,i)=>({name,originalText:JSON.stringify(i===0?raw:[])}));
  const first=files([base]),scope={companyId,sourceInstanceId};await importDayHistory(pool,{...scope,files:first});
  const run=f=>reconcileDayHistory(pool,{...scope,files:f});
  assert.equal((await run(first)).created,1);assert.equal((await run(first)).unchanged,1);
  const changed={...base,status:'confirmed',confirmed:true,history:[...base.history,{at:'later',action:'confirm'}]};
  const second=await run(files([changed]));assert.equal(second.created,1);assert.equal(second.historyVerified,2);
  assert.equal((await db.query('SELECT status_original FROM kristine.latest_imported_day_records')).rows[0].status_original,'confirmed');
  assert.equal((await db.query('SELECT status_original FROM kristine.imported_day_records')).rows[0].status_original,'pending');
  assert.equal((await db.query('SELECT count(*)::int n FROM kristine.imported_day_record_versions')).rows[0].n,2);
  const aAgain=await run(first);assert.equal(aAgain.created,0);assert.equal((await db.query('SELECT status_original FROM kristine.latest_imported_day_records')).rows[0].status_original,'pending');
  await run(files([]));assert.equal((await db.query('SELECT count(*)::int n FROM kristine.latest_imported_day_records')).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int n FROM kristine.imported_day_record_versions')).rows[0].n,2);
  const counts=async()=> (await db.query('SELECT (SELECT count(*) FROM kristine.import_runs)::int runs,(SELECT count(*) FROM kristine.source_record_versions)::int versions')).rows[0];
  const before=await counts();await assert.rejects(run(files([{...changed,history:[{at:123}]}])),/text/);assert.deepEqual(await counts(),before);
  await assert.rejects(run(first.slice(0,1)),/four-file/);
  for(const t of ['imported_day_record_versions','imported_day_record_version_history','day_reconciliation_members','day_reconciliation_runs']){
   await assert.rejects(db.query('DELETE FROM kristine.'+t),/append-only/);
   await assert.rejects(db.query('TRUNCATE kristine.'+t+' CASCADE'),/append-only/);
  }
  const other=(await db.query("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'kristine','other') RETURNING id",[companyId])).rows[0].id;
  const otherRun=await reconcileDayHistory(pool,{companyId,sourceInstanceId:other,files:files([])});
  const record=(await db.query('SELECT id FROM kristine.imported_day_record_versions LIMIT 1')).rows[0].id;
  await assert.rejects(db.query('INSERT INTO kristine.day_reconciliation_members(company_id,source_instance_id,import_run_id,day_record_id) VALUES($1,$2,$3,$4)',[companyId,other,otherRun.runId,record]),/source mismatch/);
  await assert.rejects(reconcileDayHistory(pool,{companyId:'00000000-0000-0000-0000-000000000001',sourceInstanceId,files:first}),/mismatch/);
  for(const t of ['day_closes','time_month_locks','payroll_month_closes','time_events','time_segments'])assert.equal((await db.query('SELECT count(*)::int n FROM kristine.'+t)).rows[0].n,0);
 }finally{await db.close();}
});
