'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.PGLITE_MODULE_PATH||'@electric-sql/pglite');
const {reconcileDayHistory}=require('../storage/reconcile-day-history');
const {reconcileTimeSources}=require('../storage/reconcile-time-sources');
test('late exact project mapping resolves current views without rewriting source history or crossing sources',async()=>{
 const db=new PGlite(),pool={connect:async()=>({query:(s,a)=>db.query(s,a),release(){}})};
 try{
  for(const f of fs.readdirSync(__dirname+'/../migrations').filter(f=>f.endsWith('.sql')).sort())await db.exec(fs.readFileSync(__dirname+'/../migrations/'+f,'utf8'));
  const companyId=(await db.query("INSERT INTO kristine.companies(name) VALUES('A') RETURNING id")).rows[0].id;
  const sourceInstanceId=(await db.query("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'kristine','A') RETURNING id",[companyId])).rows[0].id,scope={companyId,sourceInstanceId};
  const employee=(await db.query("INSERT INTO kristine.employees(company_id,display_name) VALUES($1,'E') RETURNING id",[companyId])).rows[0].id;
  const employeeSource=(await db.query("INSERT INTO kristine.source_records(company_id,source_instance_id,entity_type,external_id) VALUES($1,$2,'employee','E') RETURNING id",[companyId,sourceInstanceId])).rows[0].id;
  await db.query('INSERT INTO kristine.external_references(company_id,source_record_id,employee_id) VALUES($1,$2,$3)',[companyId,employeeSource,employee]);
  await reconcileDayHistory(pool,{...scope,files:['day-closes.json','day-releases.json','day-corrections.json','day-review-entries.json'].map((name,i)=>({name,originalText:JSON.stringify(i?[]:[{id:'D',employeeId:'E',jobId:'001',date:'2026-07-29',history:[]}])}))});
  await reconcileTimeSources(pool,{...scope,eventsText:JSON.stringify([{employeeId:'E',jobId:'001',date:'2026-07-29',type:'start',at:'07:00'}]),archiveText:JSON.stringify([{id:'A',employeeId:'E',date:'2026-07-29',segments:[{jobId:'001',type:'work',from:'07:00',to:'17:00'}]}])});
  const views=['resolved_imported_day_records','resolved_imported_time_events','resolved_imported_archive_segments'];
  const check=async expected=>{for(const v of views){const r=(await db.query('SELECT project_id,resolved_project_id,project_reference_unresolved FROM kristine.'+v)).rows;assert.equal(r.length,1);assert.deepEqual(r[0],{project_id:null,resolved_project_id:expected,project_reference_unresolved:!expected});}};
  await check(null);
  const project=(await db.query("INSERT INTO kristine.projects(company_id,project_number,name,status) VALUES($1,'001','P',2) RETURNING id",[companyId])).rows[0].id;
  const other=(await db.query("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'kristine','other') RETURNING id",[companyId])).rows[0].id;
  const map=async source=>{const id=(await db.query("INSERT INTO kristine.source_records(company_id,source_instance_id,entity_type,external_id) VALUES($1,$2,'project','001') RETURNING id",[companyId,source])).rows[0].id;await db.query('INSERT INTO kristine.external_references(company_id,source_record_id,project_id) VALUES($1,$2,$3)',[companyId,id,project]);};
  await map(other);await check(null);await map(sourceInstanceId);await check(project);
 }finally{await db.close();}
});
