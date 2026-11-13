'use strict';
const {createHash}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const sha=s=>createHash('sha256').update(s).digest('hex');
const blocked=/(^|\/)(?:_sql-import-originals|node_modules|browser-sessions|login-challenges|customer-access)(\/|$)|(?:token|credential|secret|password)|(?:^|\/)(?:access-admin|enable-banking-personal)\.json$/i;
function prepareSnapshots(files){
 const seen=new Set();
 return files.map(f=>{
  if(typeof f.path!=='string'||f.path.startsWith('/')||f.path.split('/').some(p=>p==='..'||p===''||p==='.')||! /\.jsonl?$/.test(f.path)||blocked.test(f.path)||seen.has(f.path))throw Error('Invalid, duplicate or excluded snapshot path');
  seen.add(f.path);
  if(typeof f.originalText!=='string'||f.originalText.includes('\u0000'))throw Error('Invalid snapshot text');
  const format=f.path.endsWith('.jsonl')?'jsonl':'json';let entryCount=null,parseValid=true;
  try {const v=format==='jsonl'?f.originalText.split(/\r?\n/).filter(s=>s.trim()).map(s=>JSON.parse(s)):JSON.parse(f.originalText);entryCount=Array.isArray(v)?v.length:v&&typeof v==='object'?Object.keys(v).length:1;}catch{parseValid=false;}
  return {...f,sha256:sha(f.originalText),metadata:{path:f.path,format,entryCount,parseValid,bytes:Buffer.byteLength(f.originalText)}};
 });
}
async function importJsonSnapshots(pool,{companyId,sourceInstanceId,files}){
 const prepared=prepareSnapshots(files).sort((a,b)=>a.path.localeCompare(b.path)),c=await pool.connect();let begun=false;
 try{
  await c.query('BEGIN');begun=true;
  if((await c.query('SELECT id FROM kristine.source_instances WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,sourceInstanceId])).rows.length!==1)throw Error('Source/company mismatch');
  const manifest=sha(JSON.stringify(prepared.map(f=>[f.path,f.sha256])));
  const runId=(await c.query('INSERT INTO kristine.import_runs(company_id,source_instance_id,manifest_sha256) VALUES($1,$2,$3) RETURNING id',[companyId,sourceInstanceId,manifest])).rows[0].id;
  const result={runId,manifestSha256:manifest,filesVerified:0,versionsCreated:0,versionsUnchanged:0,parseReview:0,bytes:0};
  for(const f of prepared){
   const sid=(await c.query("INSERT INTO kristine.source_records(company_id,source_instance_id,entity_type,external_id) VALUES($1,$2,'json_file_snapshot',$3) ON CONFLICT(company_id,source_instance_id,entity_type,external_id) DO UPDATE SET external_id=EXCLUDED.external_id RETURNING id",[companyId,sourceInstanceId,f.path])).rows[0].id;
   const prior=(await c.query('SELECT id,original_text,raw_payload FROM kristine.source_record_versions WHERE source_record_id=$1 AND source_sha256=$2',[sid,f.sha256])).rows;
   let vid;
   if(prior.length){if(prior.some(v=>v.original_text!==f.originalText||!isDeepStrictEqual(v.raw_payload,f.metadata)))throw Error('Snapshot integrity conflict');vid=prior[0].id;result.versionsUnchanged++;}
   else{vid=(await c.query('INSERT INTO kristine.source_record_versions(company_id,source_instance_id,source_record_id,import_run_id,raw_payload,original_text,source_sha256) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING id',[companyId,sourceInstanceId,sid,runId,JSON.stringify(f.metadata),f.originalText,f.sha256])).rows[0].id;result.versionsCreated++;}
   const saved=(await c.query('SELECT original_text,source_sha256,raw_payload FROM kristine.source_record_versions WHERE company_id=$1 AND id=$2',[companyId,vid])).rows[0];
   if(saved.original_text!==f.originalText||saved.source_sha256!==f.sha256||sha(saved.original_text)!==f.sha256||!isDeepStrictEqual(saved.raw_payload,f.metadata))throw Error('Snapshot readback failed');
   result.filesVerified++;result.bytes+=f.metadata.bytes;if(!f.metadata.parseValid)result.parseReview++;
  }
  // Membership is a source snapshot too, so reused versions remain traceable per run.
  const manifestText=JSON.stringify(prepared.map(f=>({path:f.path,sha256:f.sha256,metadata:f.metadata})));
  const manifestSid=(await c.query("INSERT INTO kristine.source_records(company_id,source_instance_id,entity_type,external_id) VALUES($1,$2,'json_snapshot_manifest',$3) RETURNING id",[companyId,sourceInstanceId,runId])).rows[0].id;
  await c.query('INSERT INTO kristine.source_record_versions(company_id,source_instance_id,source_record_id,import_run_id,raw_payload,original_text,source_sha256) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)',[companyId,sourceInstanceId,manifestSid,runId,JSON.stringify({files:prepared.length,manifestSha256:manifest}),manifestText,sha(manifestText)]);
  await c.query("UPDATE kristine.import_runs SET status='validated',finished_at=clock_timestamp() WHERE id=$1",[runId]);
  await c.query('COMMIT');begun=false;return result;
 }catch(e){if(begun)await c.query('ROLLBACK');throw e;}finally{c.release();}
}
module.exports={prepareSnapshots,importJsonSnapshots};
