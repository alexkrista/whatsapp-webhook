'use strict';
const {createHash}=require('node:crypto');
const {arraySourceTexts}=require('./json-source-slices');
const {importJsonSnapshots}=require('./import-json-snapshots');
const fields=require('./personnel-tracking-fields.json');
const hash=x=>createHash('sha256').update(x).digest('hex');
function preparePersonnelTracking(files){
 const seen=new Set(),prepared=[];
 for(const f of files){if(seen.has(f.path))throw Error('Duplicate personnel/tracking file');seen.add(f.path);let kind,slices;
  const v=JSON.parse(f.path.endsWith('.jsonl')?'['+f.originalText.split(/\r?\n/).filter(x=>x.trim()).join(',')+']':f.originalText);
  if(f.path==='_system/employees.json'){kind='employee_profiles';slices=arraySourceTexts(f.originalText);const ids=new Set();for(const r of v){if(typeof r.id!=='string'||!r.id||ids.has(r.id))throw Error('Missing or duplicate employee ID');ids.add(r.id);}}
  else if(f.path==='_kristine/vehicle-tracking/rides.json'){kind='vehicle_rides';slices=arraySourceTexts(f.originalText);}
  else if(f.path==='_kristine/vehicle-tracking/sessions.json'){kind='vehicle_rides';if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Invalid ride sessions');slices=null;}
  else if(/^_kristine\/vehicle-tracking\/positions\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(f.path)){kind='vehicle_positions';slices=f.originalText.split(/\r?\n/).filter(x=>x.trim());}
  else if(/^_kristine\/gps-imports\/(gps_\d+|latest)\.json$/.test(f.path)){kind='gps_rows';slices=arraySourceTexts(f.originalText,['rows']);}
  else throw Error('Unsupported personnel/tracking path');
  const rows=kind==='gps_rows'?v.rows:slices===null?Object.values(v):v;
  if(!Array.isArray(rows))throw Error('Invalid personnel/tracking collection');
  for(const r of rows){if(!r||typeof r!=='object'||Array.isArray(r))throw Error('Personnel/tracking row must be object');for(const k of Object.values(fields[kind].bools))if(r[k]!=null&&typeof r[k]!=='boolean')throw Error('Invalid boolean in '+f.path+' field '+k);}
  prepared.push({...f,kind,slices,count:rows.length,sha256:hash(f.originalText)});
 }
 for(const required of ['_system/employees.json','_kristine/vehicle-tracking/rides.json','_kristine/vehicle-tracking/sessions.json'])if(!seen.has(required))throw Error('Full personnel/tracking snapshot requires '+required);
 return prepared.sort((a,b)=>a.path.localeCompare(b.path));
}
async function importPersonnelTracking(pool,{companyId,sourceInstanceId,files}){
 const prepared=preparePersonnelTracking(files),snapshots=await importJsonSnapshots(pool,{companyId,sourceInstanceId,files});
 const c=await pool.connect();let begun=false;
 try{
  await c.query('BEGIN');begun=true;
  if((await c.query('SELECT id FROM kristine.source_instances WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,sourceInstanceId])).rows.length!==1)throw Error('Source/company mismatch');
  const runId=(await c.query('INSERT INTO kristine.import_runs(company_id,source_instance_id,manifest_sha256) VALUES($1,$2,$3) RETURNING id',[companyId,sourceInstanceId,hash(JSON.stringify(prepared.map(f=>[f.path,f.sha256])))] )).rows[0].id;
  await c.query('INSERT INTO kristine.personnel_tracking_runs(company_id,source_instance_id,import_run_id) VALUES($1,$2,$3)',[companyId,sourceInstanceId,runId]);
  const result={runId,snapshots,filesVerified:0,entriesCreated:0,entriesVerified:0,byKind:{}};
  for(const f of prepared){const vid=(await c.query("SELECT v.id FROM kristine.source_records s JOIN kristine.source_record_versions v ON v.company_id=s.company_id AND v.source_record_id=s.id WHERE s.company_id=$1 AND s.source_instance_id=$2 AND s.entity_type='json_file_snapshot' AND s.external_id=$3 AND v.source_sha256=$4",[companyId,sourceInstanceId,f.path,f.sha256])).rows[0]?.id;if(!vid)throw Error('Personnel/tracking snapshot missing');
   let slices=f.slices;if(slices===null)slices=(await c.query('SELECT value::text AS original FROM jsonb_each($1::jsonb) ORDER BY key',[f.originalText])).rows.map(r=>r.original);
   const spec=fields[f.kind],keys=[...Object.keys(spec.texts),...Object.keys(spec.bools),...Object.keys(spec.jsons)],expressions=[...Object.values(spec.texts).map(k=>"raw->>'"+k+"'"),...Object.values(spec.bools).map(k=>"kristine.strict_source_boolean(raw->'"+k+"')"),...Object.values(spec.jsons).map(k=>"raw->'"+k+"'")];
   const table='kristine.imported_'+f.kind+'_entries';
   const priorCount=(await c.query(`SELECT count(*)::int n FROM ${table} WHERE company_id=$1 AND source_version_id=$2`,[companyId,vid])).rows[0].n;
   if(priorCount!==0&&priorCount!==f.count)throw Error('Incomplete personnel/tracking projection');
   for(let offset=0;offset<slices.length;offset+=200){const batch=slices.slice(offset,offset+200),original='['+batch.join(',')+']',src='SELECT value AS raw,((ordinality-1)+$3::int)::int AS pos FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY';
    const args=[companyId,vid,offset,original],sql=`WITH src AS (${src}) INSERT INTO ${table}(company_id,source_version_id,position,raw_payload,${keys.join(',')}) SELECT $1,$2,pos,raw,${expressions.join(',')} FROM src ON CONFLICT DO NOTHING RETURNING position`;
    if(!priorCount)result.entriesCreated+=(await c.query(sql,args)).rows.length;
    const mismatch=keys.map((k,i)=>'dst.'+k+' IS DISTINCT FROM ('+expressions[i]+')').join(' OR ');
    const check=(await c.query(`WITH src AS (${src}) SELECT count(*)::int n,count(*) FILTER(WHERE dst.position IS NULL OR dst.raw_payload IS DISTINCT FROM raw OR ${mismatch})::int mismatch FROM src LEFT JOIN ${table} dst ON dst.company_id=$1 AND dst.source_version_id=$2 AND dst.position=pos`,args)).rows[0];
    if(check.n!==batch.length||check.mismatch)throw Error('Personnel/tracking typed readback mismatch');
   }
   const saved=(await c.query(`SELECT count(*)::int n FROM ${table} WHERE company_id=$1 AND source_version_id=$2`,[companyId,vid])).rows[0].n;if(saved!==f.count)throw Error('Personnel/tracking count mismatch');
   await c.query('INSERT INTO kristine.personnel_tracking_files(company_id,source_instance_id,import_run_id,source_version_id,source_path) VALUES($1,$2,$3,$4,$5)',[companyId,sourceInstanceId,runId,vid,f.path]);
   result.filesVerified++;result.entriesVerified+=f.count;result.byKind[f.kind]=(result.byKind[f.kind]||0)+f.count;
  }
  await c.query("UPDATE kristine.import_runs SET status='validated',finished_at=clock_timestamp() WHERE id=$1",[runId]);await c.query('COMMIT');begun=false;return result;
 }catch(e){if(begun)await c.query('ROLLBACK');throw e;}finally{c.release();}
}
module.exports={preparePersonnelTracking,importPersonnelTracking};
