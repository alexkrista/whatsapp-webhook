'use strict';
const {createHash}=require('node:crypto');
const hash=text=>createHash('sha256').update(text,'utf8').digest('hex');
const required=(value,label)=>{if(typeof value!=='string'||!value.trim())throw new Error(`${label} must be a nonempty string`);return value;};
const statuses=new Map([['Angebot',1],['Auftrag',2],['Laufend',3],['Fertig nicht abgerechnet',4],['Fertig – nicht abgerechnet',4],['Geschlossen',5]]);

// Explicit source identity. No name matching, live startup hook or overwrite mode.
function prepareMasterData(records){
 if(!Array.isArray(records))throw new Error('records must be an array');
 const seen=new Set();
 return records.map(entry=>{
  if(!['employee','project'].includes(entry?.entityType))throw new Error('Unsupported master-data entity');
  const externalId=required(entry.externalId,'externalId');
  const originalText=required(entry.originalText,'originalText');
  const raw=JSON.parse(originalText);
  if(!raw||Array.isArray(raw)||typeof raw!=='object')throw new Error('Source row must be an object');
  const key=JSON.stringify([entry.entityType,externalId]);if(seen.has(key))throw new Error('Duplicate source identity in input');seen.add(key);
  let fields;
  if(entry.entityType==='employee'){
   if(String(raw.id??'')!==externalId)throw new Error('Employee source ID mismatch');
   if(raw.active!==undefined&&typeof raw.active!=='boolean')throw new Error('Employee active must be boolean');
   if(raw.finkzeitPersonalNumber!==undefined && typeof raw.finkzeitPersonalNumber!=='string')throw new Error('Finkzeit personnel number must remain text');
   fields={name:required(raw.name,'employee.name'),active:raw.active!==false,finkzeitNumber:raw.finkzeitPersonalNumber||null};
  }else{
   if(String(raw.jobId??'')!==externalId)throw new Error('Project source ID mismatch');
   const status=typeof raw.status==='number'?raw.status:statuses.get(raw.status);
   if(!Number.isInteger(status)||status<1||status>5)throw new Error('Unknown project status; requires explicit mapping');
   fields={number:externalId,name:required(raw.name,'project.name'),status};
  }
  return {entityType:entry.entityType,externalId,originalText,raw,sha256:hash(originalText),fields};
 });
}

async function importMasterData(pool,{companyId,sourceInstanceId,records}){
 const prepared=prepareMasterData(records);
 const client=await pool.connect();let begun=false;
 try{
  await client.query('BEGIN');begun=true;
  // Serializes imports for this source; other sources never merge by name.
  const source=await client.query('SELECT id FROM kristine.source_instances WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,sourceInstanceId]);
  if(source.rows.length!==1)throw new Error('Source instance does not belong to company');
  const manifest=hash(JSON.stringify(prepared.map(x=>[x.entityType,x.externalId,x.sha256])));
  const run=(await client.query("INSERT INTO kristine.import_runs(company_id,source_instance_id,manifest_sha256) VALUES($1,$2,$3) RETURNING id",[companyId,sourceInstanceId,manifest])).rows[0].id;
  const result={importRunId:run,created:0,unchanged:0,mappings:[]};
  for(const row of prepared){
   const record=(await client.query('INSERT INTO kristine.source_records(company_id,source_instance_id,entity_type,external_id) VALUES($1,$2,$3,$4) ON CONFLICT(company_id,source_instance_id,entity_type,external_id) DO UPDATE SET external_id=EXCLUDED.external_id RETURNING id',[companyId,sourceInstanceId,row.entityType,row.externalId])).rows[0].id;
   const column=row.entityType==='employee'?'employee_id':'project_id';
   const existing=await client.query(`SELECT ${column} AS target FROM kristine.external_references WHERE company_id=$1 AND source_record_id=$2`,[companyId,record]);
   if(existing.rows.length){
    const previous=await client.query('SELECT source_sha256 FROM kristine.source_record_versions WHERE source_record_id=$1 ORDER BY import_run_id LIMIT 1',[record]);
    if(!existing.rows[0].target||!previous.rows.length||previous.rows[0].source_sha256!==row.sha256)throw new Error(`Source changed or mapping conflict: ${row.entityType}/${row.externalId}; review required`);
    result.unchanged++;result.mappings.push({entityType:row.entityType,externalId:row.externalId,id:existing.rows[0].target});continue;
   }
   let target;
   if(row.entityType==='employee'){
    target=(await client.query('INSERT INTO kristine.employees(company_id,display_name,active) VALUES($1,$2,$3) RETURNING id',[companyId,row.fields.name,row.fields.active])).rows[0].id;
   if(row.fields.finkzeitNumber)await client.query("INSERT INTO kristine.employee_external_ids(company_id,employee_id,namespace,external_id) VALUES($1,$2,'finkzeit',$3)",[companyId,target,row.fields.finkzeitNumber]);
   }else{
    // Existing project-number conflicts fail; they require a reviewed source mapping.
    target=(await client.query('INSERT INTO kristine.projects(company_id,project_number,name,status) VALUES($1,$2,$3,$4) RETURNING id',[companyId,row.fields.number,row.fields.name,row.fields.status])).rows[0].id;
   }
   await client.query(`INSERT INTO kristine.external_references(company_id,source_record_id,${column}) VALUES($1,$2,$3)`,[companyId,record,target]);
   await client.query('INSERT INTO kristine.source_record_versions(company_id,source_instance_id,source_record_id,import_run_id,raw_payload,original_text,source_sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',[companyId,sourceInstanceId,record,run,JSON.stringify(row.raw),row.originalText,row.sha256]);
   result.created++;result.mappings.push({entityType:row.entityType,externalId:row.externalId,id:target});
  }
  await client.query("UPDATE kristine.import_runs SET status='validated',finished_at=clock_timestamp() WHERE id=$1",[run]);
  await client.query('COMMIT');begun=false;return result;
 }catch(error){if(begun)await client.query('ROLLBACK');throw error;}finally{client.release();}
}
module.exports={prepareMasterData,importMasterData};
