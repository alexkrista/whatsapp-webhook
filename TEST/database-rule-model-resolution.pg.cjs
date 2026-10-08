'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.PGLITE_MODULE_PATH||'@electric-sql/pglite');
const {importCompanyRules}=require('../storage/import-company-rules');
const {importPersonnelTracking}=require('../storage/import-personnel-tracking');
test('employee rule IDs resolve retained schedules exactly and keep missing/ambiguous references explicit',async()=>{
 const db=new PGlite(),pool={connect:async()=>({query:(s,a)=>db.query(s,a),release(){}})};
 try{
  for(const f of fs.readdirSync(__dirname+'/../migrations').filter(f=>f.endsWith('.sql')).sort())await db.exec(fs.readFileSync(__dirname+'/../migrations/'+f,'utf8'));
  const companyId=(await db.query("INSERT INTO kristine.companies(name) VALUES('A') RETURNING id")).rows[0].id;
  const sourceInstanceId=(await db.query("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'kristine','A') RETURNING id",[companyId])).rows[0].id,scope={companyId,sourceInstanceId};
  const rules=[{path:'_system/worktime-models.json',originalText:'[{"id":"work","name":"Same name"}]'},{path:'_system/schedule-models.json',originalText:'[{"id":"legacy","name":"Same name","days":[]}]'},{path:'_kristine/schedule-models.json',originalText:'[]'}];
  await importCompanyRules(pool,{...scope,files:rules});
  await importPersonnelTracking(pool,{...scope,files:[{path:'_system/employees.json',originalText:JSON.stringify([{id:'A',worktimeModelId:'legacy'},{id:'B',worktimeModelId:'missing'},{id:'C',worktimeModelId:''}])},{path:'_kristine/vehicle-tracking/rides.json',originalText:'[]'},{path:'_kristine/vehicle-tracking/sessions.json',originalText:'{}'}]});
  const rows=(await db.query('SELECT legacy_employee_id,resolution_status,resolved_model_source_path,candidate_count FROM kristine.latest_employee_rule_model_links ORDER BY legacy_employee_id')).rows;
  assert.deepEqual(rows,[{legacy_employee_id:'A',resolution_status:'resolved',resolved_model_source_path:'_system/schedule-models.json',candidate_count:1},{legacy_employee_id:'B',resolution_status:'unresolved',resolved_model_source_path:null,candidate_count:0},{legacy_employee_id:'C',resolution_status:'unassigned',resolved_model_source_path:null,candidate_count:0}]);
  await importCompanyRules(pool,{...scope,files:rules.map(f=>f.path.startsWith('_kristine')?{...f,originalText:'[{"id":"legacy","days":[]}]'}:f)});
  const ambiguous=(await db.query("SELECT resolution_status,resolved_model_source_version_id,candidate_count FROM kristine.latest_employee_rule_model_links WHERE legacy_employee_id='A'")).rows[0];assert.deepEqual(ambiguous,{resolution_status:'ambiguous',resolved_model_source_version_id:null,candidate_count:2});
  await importCompanyRules(pool,{...scope,files:rules});assert.equal((await db.query("SELECT resolution_status FROM kristine.latest_employee_rule_model_links WHERE legacy_employee_id='A'")).rows[0].resolution_status,'resolved');
  assert.equal((await db.query("SELECT worktime_model_id_original FROM kristine.latest_imported_employee_profiles WHERE legacy_id='A'")).rows[0].worktime_model_id_original,'legacy');
 }finally{await db.close();}
});
