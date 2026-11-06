'use strict';
const {createHash}=require('node:crypto');const {isDeepStrictEqual}=require('node:util');
const hash=t=>createHash('sha256').update(t).digest('hex');
const fields=['street','houseNumber','postalCode','city','addressExtra'];
function prepareAddress(raw){
 const a=fields.map(k=>{if(raw[k]!=null&&typeof raw[k]!=='string')throw new Error('Address fields must retain source text');return raw[k]??null;});
 return a.some(v=>v&&v.trim())?a:null;
}
async function importProjectAddresses(pool,{companyId,sourceInstanceId}){
 const c=await pool.connect();let begun=false;
 try{
  await c.query('BEGIN');begun=true;
  if((await c.query('SELECT id FROM kristine.source_instances WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,sourceInstanceId])).rows.length!==1)throw new Error('Source/company mismatch');
  const rows=(await c.query("SELECT s.external_id,x.project_id,v.raw_payload,v.original_text,v.source_sha256 FROM kristine.source_records s JOIN kristine.external_references x ON x.source_record_id=s.id AND x.company_id=s.company_id JOIN kristine.source_record_versions v ON v.source_record_id=s.id AND v.company_id=s.company_id WHERE s.company_id=$1 AND s.source_instance_id=$2 AND s.entity_type='project' ORDER BY s.external_id",[companyId,sourceInstanceId])).rows;
  const seen=new Set();const prepared=[];
  for(const r of rows){
   if(seen.has(r.external_id)||!r.project_id||typeof r.original_text!=='string'||hash(r.original_text)!==r.source_sha256||!isDeepStrictEqual(JSON.parse(r.original_text),r.raw_payload))throw new Error('Project source history requires review');seen.add(r.external_id);
   const address=prepareAddress(r.raw_payload);if(address)prepared.push({...r,address});
  }
  const run=(await c.query('INSERT INTO kristine.import_runs(company_id,source_instance_id,manifest_sha256) VALUES($1,$2,$3) RETURNING id',[companyId,sourceInstanceId,hash(JSON.stringify(prepared.map(r=>[r.external_id,r.source_sha256])))] )).rows[0].id;
  const result={projects:rows.length,created:0,unchanged:0,verified:0,withoutAddress:rows.length-prepared.length};
  for(const r of prepared){
   const sid=(await c.query("INSERT INTO kristine.source_records(company_id,source_instance_id,entity_type,external_id) VALUES($1,$2,'project_address',$3) ON CONFLICT(company_id,source_instance_id,entity_type,external_id) DO UPDATE SET external_id=EXCLUDED.external_id RETURNING id",[companyId,sourceInstanceId,r.external_id])).rows[0].id;
   const existing=(await c.query('SELECT address_id FROM kristine.external_references WHERE company_id=$1 AND source_record_id=$2',[companyId,sid])).rows;
   let addressId;
   if(existing.length){
    const old=(await c.query('SELECT source_sha256 FROM kristine.source_record_versions WHERE source_record_id=$1',[sid])).rows;
    if(!existing[0].address_id||old.length!==1||old[0].source_sha256!==r.source_sha256)throw new Error('Address source changed; review required');addressId=existing[0].address_id;result.unchanged++;
   }else{
    if((await c.query("SELECT 1 FROM kristine.project_addresses WHERE company_id=$1 AND project_id=$2 AND role='site'",[companyId,r.project_id])).rows.length)throw new Error('Existing site address requires mapping review');
    addressId=(await c.query('INSERT INTO kristine.addresses(company_id,street,house_number,postal_code,city,address_extra) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[companyId,...r.address])).rows[0].id;
    await c.query("INSERT INTO kristine.project_addresses(company_id,project_id,address_id,role) VALUES($1,$2,$3,'site')",[companyId,r.project_id,addressId]);
    await c.query('INSERT INTO kristine.external_references(company_id,source_record_id,address_id) VALUES($1,$2,$3)',[companyId,sid,addressId]);
    await c.query('INSERT INTO kristine.source_record_versions(company_id,source_instance_id,source_record_id,import_run_id,raw_payload,original_text,source_sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',[companyId,sourceInstanceId,sid,run,JSON.stringify(r.raw_payload),r.original_text,r.source_sha256]);result.created++;
   }
   const actual=(await c.query("SELECT a.street,a.house_number,a.postal_code,a.city,a.address_extra FROM kristine.addresses a JOIN kristine.project_addresses l ON l.address_id=a.id AND l.company_id=a.company_id WHERE a.company_id=$1 AND a.id=$2 AND l.project_id=$3 AND l.role='site'",[companyId,addressId,r.project_id])).rows;
   if(actual.length!==1||!isDeepStrictEqual(Object.values(actual[0]),r.address))throw new Error('Address verification failed');result.verified++;
  }
  await c.query("UPDATE kristine.import_runs SET status='validated',finished_at=clock_timestamp() WHERE id=$1",[run]);
  await c.query('COMMIT');begun=false;return result;
 }catch(e){if(begun)await c.query('ROLLBACK');throw e;}finally{c.release();}
}
module.exports={prepareAddress,importProjectAddresses};
