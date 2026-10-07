'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.PGLITE_MODULE_PATH||'@electric-sql/pglite');
const {importSupplementalWorkflows}=require('../storage/import-supplemental-workflows');
test('visits and employee supplements preserve exact sources, typed protocols, assets, flags, revisions and scoped latest membership',async()=>{
 const db=new PGlite(),pool={connect:async()=>({query:(s,a)=>db.query(s,a),release(){}})};
 try{
  for(const f of fs.readdirSync(__dirname+'/../migrations').filter(f=>f.endsWith('.sql')).sort())await db.exec(fs.readFileSync(__dirname+'/../migrations/'+f,'utf8'));
  const companyId=(await db.query("INSERT INTO kristine.companies(name) VALUES('A') RETURNING id")).rows[0].id;
  const sourceInstanceId=(await db.query("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'kristine','A') RETURNING id",[companyId])).rows[0].id,scope={companyId,sourceInstanceId};
  const v={id:'V',status:'prepared',taskId:'T',jobId:'001',contractAmount:1,appointment:{date:'2026-10-07',from:'07:01',to:'',calendarAccount:'A'},protocol:{discussion:'Original',work:'Work',estimate:'Estimate',nextSteps:'Next',files:[{id:'F',size:0,name:'f.pdf',unknownAmount:1}],recordings:[{id:'R',consentAt:'exact',transcript:'words',transcriptionError:'original'}]},timeline:[{type:'prepared',label:'label',at:'local-time'}]};
  const visitsText='[ '+JSON.stringify(v).replace('"contractAmount":1','"contractAmount":9007199254740993.17').replace('"unknownAmount":1','"unknownAmount":9007199254740993.19')+' ]';
  const args={...scope,visitsText,rulesText:JSON.stringify({E:{activityMode:'productive',buak:false}}),emailsText:JSON.stringify({emails:{E:'e@example.test'},updatedAt:'exact'})};
  const first=await importSupplementalWorkflows(pool,args);assert.equal(first.visitsVerified,1);assert.equal(first.timelineVerified,1);assert.equal(first.assetsVerified,2);assert.equal(first.settingsVerified,2);
  assert.equal((await db.query('SELECT contract_amount_original FROM kristine.latest_imported_visits')).rows[0].contract_amount_original,'9007199254740993.17');
  assert.equal((await db.query("SELECT raw_payload->>'unknownAmount' AS n FROM kristine.imported_visit_assets WHERE collection='files'")).rows[0].n,'9007199254740993.19');
  assert.equal((await db.query("SELECT buak_original FROM kristine.latest_imported_employee_settings WHERE setting_kind='work_rules'")).rows[0].buak_original,false);
  const replay=await importSupplementalWorkflows(pool,args);assert.equal(replay.visitVersionsCreated,0);assert.equal(replay.settingVersionsCreated,0);
  const changed={...args,visitsText:visitsText.replace('Original','Changed'),rulesText:args.rulesText.replace('false','true')};
  const revision=await importSupplementalWorkflows(pool,changed);assert.equal(revision.visitVersionsCreated,1);assert.equal(revision.settingVersionsCreated,1);
  assert.equal((await db.query('SELECT discussion FROM kristine.latest_imported_visits')).rows[0].discussion,'Changed');
  await importSupplementalWorkflows(pool,args);assert.equal((await db.query('SELECT discussion FROM kristine.latest_imported_visits')).rows[0].discussion,'Original');
  const before=(await db.query('SELECT count(*)::int n FROM kristine.import_runs')).rows[0].n;
  await assert.rejects(importSupplementalWorkflows(pool,{...changed,rulesText:JSON.stringify({E:{buak:'false'}})}),/boolean/);assert.equal((await db.query('SELECT count(*)::int n FROM kristine.import_runs')).rows[0].n,before);
  await assert.rejects(importSupplementalWorkflows(pool,{...args,visitsText:JSON.stringify([v,v])}),/duplicate/);
  await assert.rejects(importSupplementalWorkflows(pool,{...args,companyId:'00000000-0000-0000-0000-000000000001'}),/mismatch/);
  const other=(await db.query("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'kristine','other') RETURNING id",[companyId])).rows[0].id;
  const empty=await importSupplementalWorkflows(pool,{...args,sourceInstanceId:other,visitsText:'[]',rulesText:'{}',emailsText:'{"emails":{}}'});
  const vid=(await db.query('SELECT id FROM kristine.imported_visit_versions LIMIT 1')).rows[0].id;
  await assert.rejects(db.query('INSERT INTO kristine.supplemental_visit_members(company_id,source_instance_id,import_run_id,version_id) VALUES($1,$2,$3,$4)',[companyId,other,empty.runId,vid]),/source mismatch/);
  await importSupplementalWorkflows(pool,{...args,visitsText:'[]',rulesText:'{}',emailsText:'{"emails":{}}'});assert.equal((await db.query('SELECT count(*)::int n FROM kristine.latest_imported_visits')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int n FROM kristine.latest_imported_employee_settings')).rows[0].n,0);
  for(const t of ['imported_visit_versions','imported_visit_timeline','imported_visit_assets','imported_employee_setting_versions'])await assert.rejects(db.query('DELETE FROM kristine.'+t),/append-only/);
  assert.equal((await db.query('SELECT count(*)::int n FROM kristine.time_events')).rows[0].n,0);
 }finally{await db.close();}
});
