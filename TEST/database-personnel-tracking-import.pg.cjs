'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.PGLITE_MODULE_PATH||'@electric-sql/pglite');
const {importPersonnelTracking}=require('../storage/import-personnel-tracking');
test('personnel and tracking preserve precise numbers, false flags, duplicate points, source snapshots and historical replay',async()=>{
 const db=new PGlite(),pool={connect:async()=>({query:(s,a)=>db.query(s,a),release(){}})};
 try{
  for(const f of fs.readdirSync(__dirname+'/../migrations').filter(f=>f.endsWith('.sql')).sort())await db.exec(fs.readFileSync(__dirname+'/../migrations/'+f,'utf8'));
  const companyId=(await db.query("INSERT INTO kristine.companies(name) VALUES('A') RETURNING id")).rows[0].id;
  const sourceInstanceId=(await db.query("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'kristine','A') RETURNING id",[companyId])).rows[0].id,scope={companyId,sourceInstanceId};
  const files=[{path:'_system/employees.json',originalText:'[{"id":"001","name":"A","active":false,"grossMonthlySalary":9007199254740993.17,"clothingSizes":{"shoes":"042"}}]'},{path:'_kristine/vehicle-tracking/rides.json',originalText:'[{"id":"R","distanceMeters":9007199254740993.19,"unresolvedDriver":true}]'},{path:'_kristine/vehicle-tracking/sessions.json',originalText:'{"car":{"id":"S","buzzerWanted":false,"odometerEnd":9007199254740993.21}}'},{path:'_kristine/vehicle-tracking/positions/2026-10-07.jsonl',originalText:Array(401).fill('{"vehicleId":"V","lat":47.1234567890123456789,"ignition":false}').join('\n')},{path:'_kristine/gps-imports/latest.json',originalText:'{"id":"G","rows":[{"id":"g","isPrivate":false,"distanceKm":0.1234567890123456789,"changeHistory":[{"original":true}]}]}'}];
  const run=f=>importPersonnelTracking(pool,{...scope,files:f});const first=await run(files);assert.equal(first.entriesVerified,405);assert.equal(first.byKind.vehicle_positions,401);
  const e=(await db.query('SELECT active_original,gross_monthly_salary_original,clothing_sizes FROM kristine.latest_imported_employee_profiles')).rows[0];assert.deepEqual(e,{active_original:false,gross_monthly_salary_original:'9007199254740993.17',clothing_sizes:{shoes:'042'}});
  assert.equal((await db.query('SELECT lat_original FROM kristine.latest_imported_vehicle_positions LIMIT 1')).rows[0].lat_original,'47.1234567890123456789');
  assert.equal((await db.query("SELECT odometer_end_original FROM kristine.latest_imported_vehicle_rides WHERE legacy_id='S'")).rows[0].odometer_end_original,'9007199254740993.21');
  assert.equal((await run(files)).entriesCreated,0);
  const changed=files.map(f=>f.path==='_system/employees.json'?{...f,originalText:f.originalText.replace('"active":false','"active":true')}:f);await run(changed);assert.equal((await db.query('SELECT active_original FROM kristine.latest_imported_employee_profiles')).rows[0].active_original,true);await run(files);assert.equal((await db.query('SELECT active_original FROM kristine.latest_imported_employee_profiles')).rows[0].active_original,false);
  await assert.rejects(run(files.slice(1)),/requires/);await assert.rejects(run(files.map(f=>({...f,originalText:f.originalText.replace('"active":false','"active":"false"')}))),/boolean/);
  await assert.rejects(importPersonnelTracking(pool,{companyId:'00000000-0000-0000-0000-000000000001',sourceInstanceId,files}),/mismatch/);
  let interrupted=false;const failing={connect:async()=>({query:async(sql,args)=>{const r=await db.query(sql,args);if(!interrupted&&sql.includes('INSERT INTO kristine.imported_vehicle_positions_entries')){interrupted=true;throw Error('simulated typed interruption');}return r;},release(){}})};
  const beforeTyped=(await db.query('SELECT count(*)::int n FROM kristine.personnel_tracking_runs')).rows[0].n;
  await assert.rejects(importPersonnelTracking(failing,{...scope,files}),/simulated typed interruption/);
  assert.equal((await db.query('SELECT count(*)::int n FROM kristine.personnel_tracking_runs')).rows[0].n,beforeTyped);
  assert.equal((await db.query('SELECT count(*)::int n FROM kristine.latest_imported_vehicle_positions')).rows[0].n,401);
  const empty=files.map(f=>({...f,originalText:f.path.endsWith('sessions.json')?'{}':f.path.endsWith('latest.json')?'{"rows":[]}':f.path.endsWith('jsonl')?'':'[]'}));await run(empty);assert.equal((await db.query('SELECT count(*)::int n FROM kristine.latest_imported_vehicle_positions')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int n FROM kristine.imported_vehicle_positions_entries')).rows[0].n,401);
  for(const t of ['personnel_tracking_runs','personnel_tracking_files','imported_employee_profiles_entries','imported_vehicle_positions_entries'])await assert.rejects(db.query('DELETE FROM kristine.'+t),/append-only/);
  const file=(await db.query('SELECT source_version_id,source_path FROM kristine.personnel_tracking_files WHERE source_path=$1 LIMIT 1',['_system/employees.json'])).rows[0];await assert.rejects(db.query('INSERT INTO kristine.imported_vehicle_positions_entries(company_id,source_version_id,position,raw_payload) VALUES($1,$2,999,$3)',[companyId,file.source_version_id,'{}']),/source mismatch/);
  assert.equal((await db.query('SELECT count(*)::int n FROM kristine.time_events')).rows[0].n,0);
 }finally{await db.close();}
});
