'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.PGLITE_MODULE_PATH||'@electric-sql/pglite');
const {importCompanyRules}=require('../storage/import-company-rules');
test('company rules preserve exact quantities, source boundaries, season and Fink distinctions, rollback and replay',async()=>{
 const db=new PGlite(),pool={connect:async()=>({query:(s,a)=>db.query(s,a),release(){}})};
 try{
  for(const f of fs.readdirSync(__dirname+'/../migrations').filter(f=>f.endsWith('.sql')).sort())await db.exec(fs.readFileSync(__dirname+'/../migrations/'+f,'utf8'));
  const companyId=(await db.query("INSERT INTO kristine.companies(name) VALUES('A') RETURNING id")).rows[0].id;
  const sourceInstanceId=(await db.query("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'kristine','A') RETURNING id",[companyId])).rows[0].id,scope={companyId,sourceInstanceId};
  const files=[{path:'_system/worktime-models.json',originalText:'[{"id":"001","active":false,"automaticTime":false,"payrollTargetHoursWeekday":7.8000000000000000001,"unknown":{"keep":true},"seasons":[{"id":"winter","months":[12,1,2,3],"weekdays":{"5":{"free":true,"from":"","to":"","targetHours":0,"payrollTargetHours":7.8}}}],"blocks":{"planning":{"rows":[]},"finkTarget":{"rows":[{"id":"F","days":[1,2,3,4,5],"from":"07:00","to":"14:48","activityCode":"022"}]},"finkFixed":{"enabled":false,"rows":[]}}}]'},...['_system/schedule-models.json','_kristine/schedule-models.json'].map((path,i)=>({path,originalText:JSON.stringify([{id:'001',name:'distinct '+i,days:[{dayName:'Freitag',isWorkDay:i===0,from:i===0?'00:00':'',shouldHours:0,pauseMinutes:0}]}])}))];
  const run=f=>importCompanyRules(pool,{...scope,files:f}),first=await run(files);assert.deepEqual(first.byKind,{models:3,schedule_days:2,seasons:1,weekdays:1,blocks:3,block_rows:1});
  const rule=(await db.query("SELECT payroll_target_hours_weekday::text quantity,active_original,automatic_time_original,raw_payload->'unknown' unknown FROM kristine.latest_company_rule_models WHERE source_path='_system/worktime-models.json'")).rows[0];assert.deepEqual(rule,{quantity:'7.8000000000000000001',active_original:false,automatic_time_original:false,unknown:{keep:true}});
  assert.deepEqual((await db.query('SELECT target_hours::text target,payroll_target_hours::text payroll,free_original FROM kristine.latest_company_rule_weekdays')).rows[0],{target:'0',payroll:'7.8',free_original:true});
  assert.equal((await db.query('SELECT activity_code_original FROM kristine.latest_company_rule_block_rows')).rows[0].activity_code_original,'022');
  assert.equal((await run(files)).entriesCreated,0);
  const changed=files.map(f=>({...f,originalText:f.originalText.replace('"active":false','"active":true')}));await run(changed);assert.equal((await db.query("SELECT active_original FROM kristine.latest_company_rule_models WHERE source_path='_system/worktime-models.json'")).rows[0].active_original,true);await run(files);
  await assert.rejects(run(files.slice(1)),/requires/);await assert.rejects(run(files.map(f=>({...f,originalText:f.originalText.replace('"active":false','"active":"false"')}))),/boolean/);
  let failed=false;const broken={connect:async()=>({query:async(s,a)=>{const r=await db.query(s,a);if(!failed&&s.includes('INSERT INTO kristine.imported_company_rule_weekdays')){failed=true;throw Error('typed fault');}return r;},release(){}})};
  const before=(await db.query('SELECT count(*)::int n FROM kristine.company_rule_runs')).rows[0].n;
  await assert.rejects(importCompanyRules(broken,{...scope,files:files.map(f=>({...f,originalText:f.originalText.replace('"targetHours":0','"targetHours":1')}))}),/typed fault/);
  assert.equal((await db.query('SELECT count(*)::int n FROM kristine.company_rule_runs')).rows[0].n,before);assert.equal((await db.query('SELECT target_hours::text target FROM kristine.latest_company_rule_weekdays')).rows[0].target,'0');
  await run(files.map(f=>({...f,originalText:'[]'})));assert.equal((await db.query('SELECT count(*)::int n FROM kristine.latest_company_rule_models')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int n FROM kristine.imported_company_rule_models')).rows[0].n,4);await run(files);
  await assert.rejects(db.query('DELETE FROM kristine.company_rule_files'),/append-only/);await assert.rejects(db.query('TRUNCATE kristine.imported_company_rule_schedule_days'),/append-only/);
  const version=(await db.query("SELECT source_version_id FROM kristine.latest_company_rule_files WHERE source_path='_system/schedule-models.json'")).rows[0].source_version_id;
  await assert.rejects(db.query("INSERT INTO kristine.imported_company_rule_blocks(company_id,source_version_id,model_position,block_key,raw_payload) VALUES($1,$2,0,'invalid','{}')",[companyId,version]),/source mismatch/);
  assert.equal((await db.query('SELECT count(*)::int n FROM kristine.time_events')).rows[0].n,0);
 }finally{await db.close();}
});
