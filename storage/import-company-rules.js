'use strict';
const {createHash}=require('node:crypto');
const {importJsonSnapshots}=require('./import-json-snapshots');
const specs=require('./company-rule-fields.json');
const paths=['_system/worktime-models.json','_system/schedule-models.json','_kristine/schedule-models.json'];
const hash=x=>createHash('sha256').update(x).digest('hex');
function object(x,label){if(!x||typeof x!=='object'||Array.isArray(x))throw Error('Invalid '+label);}
function fields(x,s){object(x,'company rule');for(const k of Object.values(s.bools))if(x[k]!=null&&typeof x[k]!=='boolean')throw Error('Invalid rule boolean '+k);for(const k of Object.values(s.numbers))if(x[k]!=null&&typeof x[k]!=='number')throw Error('Invalid rule number '+k);}
function array(x,label){if(!Array.isArray(x))throw Error('Invalid '+label);return x;}
function prepareCompanyRules(files){
 const seen=new Set();const prepared=files.map(f=>{
  if(!paths.includes(f.path)||seen.has(f.path))throw Error('Unsupported or duplicate company rule path');seen.add(f.path);
  const rows=array(JSON.parse(f.originalText),'models'),ids=new Set();
  for(const m of rows){fields(m,specs.models);if(typeof m.id!=='string'||!m.id||ids.has(m.id))throw Error('Missing or duplicate rule ID');ids.add(m.id);
   if(f.path===paths[0]){
    for(const s of array(m.seasons??[],'seasons')){fields(s,specs.seasons);if(s.months!=null)array(s.months,'months');object(s.weekdays??{},'weekdays');for(const w of Object.values(s.weekdays??{}))fields(w,specs.weekdays);}
    object(m.blocks??{},'blocks');for(const b of Object.values(m.blocks??{})){fields(b,specs.blocks);for(const r of array(b.rows??[],'block rows')){fields(r,specs.block_rows);if(r.days!=null)array(r.days,'block days');}}
    if(m.days!=null)throw Error('Schedule days in worktime source');
   }else{for(const d of array(m.days??[],'schedule days'))fields(d,specs.schedule_days);if(m.seasons!=null||m.blocks!=null)throw Error('Worktime rules in schedule source');}
  }
  return {...f,sha256:hash(f.originalText)};
 });
 for(const p of paths)if(!seen.has(p))throw Error('Full rule snapshot requires '+p);
 return prepared.sort((a,b)=>a.path.localeCompare(b.path));
}
function expressions(s){return [...Object.values(s.texts).map(k=>"raw->>'"+k+"'"),...Object.values(s.numbers).map(k=>"kristine.strict_source_number(raw->'"+k+"')"),...Object.values(s.bools).map(k=>"kristine.strict_source_boolean(raw->'"+k+"')"),...Object.values(s.jsons).map(k=>"raw->'"+k+"'")];}
async function importCompanyRules(pool,{companyId,sourceInstanceId,files}){
 const prepared=prepareCompanyRules(files),snapshots=await importJsonSnapshots(pool,{companyId,sourceInstanceId,files});const c=await pool.connect();let begun=false;
 try{await c.query('BEGIN');begun=true;
  if((await c.query('SELECT id FROM kristine.source_instances WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,sourceInstanceId])).rows.length!==1)throw Error('Source/company mismatch');
  const runId=(await c.query('INSERT INTO kristine.import_runs(company_id,source_instance_id,manifest_sha256) VALUES($1,$2,$3) RETURNING id',[companyId,sourceInstanceId,hash(JSON.stringify(prepared.map(f=>[f.path,f.sha256])))])).rows[0].id;
  await c.query('INSERT INTO kristine.company_rule_runs(company_id,source_instance_id,import_run_id) VALUES($1,$2,$3)',[companyId,sourceInstanceId,runId]);
  const result={runId,snapshots,filesVerified:0,entriesCreated:0,byKind:{}};
  for(const f of prepared){
   const vid=(await c.query("SELECT v.id FROM kristine.source_records s JOIN kristine.source_record_versions v ON v.company_id=s.company_id AND v.source_record_id=s.id WHERE s.company_id=$1 AND s.source_instance_id=$2 AND s.entity_type='json_file_snapshot' AND s.external_id=$3 AND v.source_sha256=$4",[companyId,sourceInstanceId,f.path,f.sha256])).rows[0]?.id;if(!vid)throw Error('Rule snapshot missing');
   for(const [kind,s] of Object.entries(specs)){
    if(f.path===paths[0]?kind==='schedule_days':!['models','schedule_days'].includes(kind))continue;
    const table='kristine.imported_company_rule_'+kind,keys=Object.keys(s.keys),columns=[...Object.keys(s.texts),...Object.keys(s.numbers),...Object.keys(s.bools),...Object.keys(s.jsons)],ex=expressions(s),args=[companyId,vid,f.originalText];
    const src='WITH src AS ('+s.source+') ';
    const expected=(await c.query(src+'SELECT count(*)::int n FROM src WHERE $1::uuid IS NOT NULL AND $2::uuid IS NOT NULL',args)).rows[0].n;
    const prior=(await c.query('SELECT count(*)::int n FROM '+table+' WHERE company_id=$1 AND source_version_id=$2',[companyId,vid])).rows[0].n;
    if(prior!==0&&prior!==expected)throw Error('Incomplete rule projection');
    if(!prior&&expected)result.entriesCreated+=(await c.query(src+'INSERT INTO '+table+'(company_id,source_version_id,'+keys.join(',')+',raw_payload,'+columns.join(',')+') SELECT $1,$2,'+keys.join(',')+',raw,'+ex.join(',')+' FROM src ON CONFLICT DO NOTHING RETURNING source_version_id',args)).rows.length;
    const join=keys.map(k=>'dst.'+k+'=src.'+k).join(' AND '),mismatch=columns.map((k,i)=>'dst.'+k+' IS DISTINCT FROM ('+ex[i]+')').join(' OR ');
    const check=(await c.query(src+'SELECT count(*)::int n,count(*) FILTER(WHERE dst.source_version_id IS NULL OR dst.raw_payload IS DISTINCT FROM raw OR '+mismatch+')::int mismatch FROM src LEFT JOIN '+table+' dst ON dst.company_id=$1 AND dst.source_version_id=$2 AND '+join,args)).rows[0];
    const count=(await c.query('SELECT count(*)::int n FROM '+table+' WHERE company_id=$1 AND source_version_id=$2',[companyId,vid])).rows[0].n;
    if(check.n!==expected||check.mismatch||count!==expected)throw Error('Rule typed readback mismatch');
    result.byKind[kind]=(result.byKind[kind]||0)+expected;
   }
   await c.query('INSERT INTO kristine.company_rule_files(company_id,source_instance_id,import_run_id,source_version_id,source_path) VALUES($1,$2,$3,$4,$5)',[companyId,sourceInstanceId,runId,vid,f.path]);result.filesVerified++;
  }
  await c.query("UPDATE kristine.import_runs SET status='validated',finished_at=clock_timestamp() WHERE id=$1",[runId]);await c.query('COMMIT');begun=false;return result;
 }catch(e){if(begun)await c.query('ROLLBACK');throw e;}finally{c.release();}
}
module.exports={prepareCompanyRules,importCompanyRules};
