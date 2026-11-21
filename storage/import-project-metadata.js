'use strict';
const {createHash}=require('node:crypto');
const hash=text=>createHash('sha256').update(text,'utf8').digest('hex');
const statuses=new Map([['Angebot',1],['Auftrag',2],['Laufend',3],['Fertig nicht abgerechnet',4],['Fertig – nicht abgerechnet',4],['Geschlossen',5]]);
function prepareProjects(records){
 if(!Array.isArray(records))throw new Error('Expected project array');
 const seen=new Set();
 return records.map(r=>{
  if(typeof r.externalId!=='string'||!r.externalId.trim()||seen.has(r.externalId))throw new Error('Invalid or duplicate project ID');
  seen.add(r.externalId);
  if(typeof r.originalText!=='string')throw new Error('Missing source text');
  const raw=JSON.parse(r.originalText);
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Invalid project metadata');
  if(raw.jobId!=null&&String(raw.jobId)!==r.externalId)throw new Error('Project source ID mismatch');
  if(raw.name!=null&&typeof raw.name!=='string')throw new Error('Invalid project name');
  const reasons=[];const name=raw.name??'';
  if(!name.trim())reasons.push('name_missing');
  let status=null,offerOutcome=null;
  if(raw.status==null||raw.status==='')reasons.push('status_missing');
  else if(raw.status==='Angebot – abgelehnt'||raw.status==='Angebot - abgelehnt'){status=1;offerOutcome='rejected';}
  else{status=typeof raw.status==='number'?raw.status:statuses.get(raw.status);if(!Number.isInteger(status)||status<1||status>5)throw new Error('Unknown project status: '+r.externalId);}
  return {...r,raw,sha256:hash(r.originalText),name,status,offerOutcome,reasons};
 });
}
async function importProjects(pool,{companyId,sourceInstanceId,records}){
 const prepared=prepareProjects(records);const client=await pool.connect();let begun=false;
 try{
  await client.query('BEGIN');begun=true;
  const source=await client.query('SELECT id FROM kristine.source_instances WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,sourceInstanceId]);
  if(source.rows.length!==1)throw new Error('Source/company mismatch');
  const run=(await client.query('INSERT INTO kristine.import_runs(company_id,source_instance_id,manifest_sha256) VALUES($1,$2,$3) RETURNING id',[companyId,sourceInstanceId,hash(JSON.stringify(prepared.map(r=>[r.externalId,r.sha256])))])).rows[0].id;
  const result={created:0,unchanged:0,review:prepared.filter(r=>r.reasons.length).length,rejected:prepared.filter(r=>r.offerOutcome).length};
  for(const r of prepared){
   const sourceId=(await client.query("INSERT INTO kristine.source_records(company_id,source_instance_id,entity_type,external_id) VALUES($1,$2,'project',$3) ON CONFLICT(company_id,source_instance_id,entity_type,external_id) DO UPDATE SET external_id=EXCLUDED.external_id RETURNING id",[companyId,sourceInstanceId,r.externalId])).rows[0].id;
   const existing=await client.query('SELECT project_id FROM kristine.external_references WHERE company_id=$1 AND source_record_id=$2',[companyId,sourceId]);
   if(existing.rows.length){
    const version=await client.query('SELECT source_sha256 FROM kristine.source_record_versions WHERE source_record_id=$1',[sourceId]);
    if(!existing.rows[0].project_id||version.rows.length!==1||version.rows[0].source_sha256!==r.sha256)throw new Error('Source changed; review required: '+r.externalId);
    result.unchanged++;continue;
   }
   const id=(await client.query('INSERT INTO kristine.projects(company_id,project_number,name,status,offer_outcome,import_review_reasons) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[companyId,r.externalId,r.name,r.status,r.offerOutcome,r.reasons])).rows[0].id;
   await client.query('INSERT INTO kristine.external_references(company_id,source_record_id,project_id) VALUES($1,$2,$3)',[companyId,sourceId,id]);
   await client.query('INSERT INTO kristine.source_record_versions(company_id,source_instance_id,source_record_id,import_run_id,raw_payload,original_text,source_sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',[companyId,sourceInstanceId,sourceId,run,JSON.stringify(r.raw),r.originalText,r.sha256]);
   result.created++;
  }
  await client.query("UPDATE kristine.import_runs SET status='validated',finished_at=clock_timestamp() WHERE id=$1",[run]);
  await client.query('COMMIT');begun=false;return result;
 }catch(e){if(begun)await client.query('ROLLBACK');throw e;}finally{client.release();}
}
module.exports={prepareProjects,importProjects};
