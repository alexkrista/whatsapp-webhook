'use strict';
const {createHash}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {prepareContacts}=require('./import-contact-groups');
const {prepareProjects}=require('./import-project-metadata');
const {prepareAddress}=require('./import-project-addresses');
const hash=t=>createHash('sha256').update(t).digest('hex');
const text=v=>v==null||v===''?null:typeof v==='string'?v:(()=>{throw Error('Master field must remain text');})();
async function reconcileMasterData(pool,{companyId,sourceInstanceId,contactsText,projects}){
 const contacts=prepareContacts(contactsText),prepared=prepareProjects(projects);
 for(const p of prepared){prepareAddress(p.raw);text(p.raw.country);if(p.raw.projectContacts!=null&&(!p.raw.projectContacts||typeof p.raw.projectContacts!=='object'||Array.isArray(p.raw.projectContacts)))throw Error('Invalid project contacts');}
 const c=await pool.connect();let begun=false;
 try{
  await c.query('BEGIN');begun=true;
  if((await c.query('SELECT id FROM kristine.source_instances WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,sourceInstanceId])).rows.length!==1)throw Error('Source/company mismatch');
  const refs=(await c.query('SELECT s.entity_type,s.external_id,x.project_id,x.contact_group_id FROM kristine.source_records s JOIN kristine.external_references x ON x.source_record_id=s.id AND x.company_id=s.company_id WHERE s.company_id=$1 AND s.source_instance_id=$2',[companyId,sourceInstanceId])).rows;
  const projectIds=new Map(refs.filter(r=>r.entity_type==='project'&&r.project_id).map(r=>[r.external_id,r.project_id]));
  const contactIds=new Map(refs.filter(r=>r.entity_type==='contact_group'&&r.contact_group_id).map(r=>[r.external_id,r.contact_group_id]));
  const manifest=hash(JSON.stringify([hash(contactsText),...prepared.map(p=>[p.externalId,p.sha256])]));
  const runId=(await c.query('INSERT INTO kristine.import_runs(company_id,source_instance_id,manifest_sha256) VALUES($1,$2,$3) RETURNING id',[companyId,sourceInstanceId,manifest])).rows[0].id;
  await c.query('INSERT INTO kristine.master_reconciliation_runs(company_id,source_instance_id,import_run_id) VALUES($1,$2,$3)',[companyId,sourceInstanceId,runId]);
  async function source(kind,externalId,original){
   const sid=(await c.query('INSERT INTO kristine.source_records(company_id,source_instance_id,entity_type,external_id) VALUES($1,$2,$3,$4) ON CONFLICT(company_id,source_instance_id,entity_type,external_id) DO UPDATE SET external_id=EXCLUDED.external_id RETURNING id',[companyId,sourceInstanceId,kind,externalId])).rows[0].id;
   const sha=hash(original);const old=(await c.query('SELECT id,original_text,raw_payload FROM kristine.source_record_versions WHERE source_record_id=$1 AND source_sha256=$2',[sid,sha])).rows;
   const payload=JSON.parse(original);let vid;
   if(old.length){if(old.some(v=>v.original_text!==original||!isDeepStrictEqual(v.raw_payload,payload)))throw Error('Master source integrity conflict');vid=old[0].id;}
   else vid=(await c.query('INSERT INTO kristine.source_record_versions(company_id,source_instance_id,source_record_id,import_run_id,raw_payload,original_text,source_sha256) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING id',[companyId,sourceInstanceId,sid,runId,original,original,sha])).rows[0].id;
   return {sid,vid};
  }
  async function projection(table,row){
   const keys=Object.keys(row),prior=(await c.query('SELECT id FROM kristine.'+table+' WHERE company_id=$1 AND source_record_id=$2 AND source_version_id=$3 AND projection_sha256=$4',[companyId,row.source_record_id,row.source_version_id,row.projection_sha256])).rows;
   let id;if(prior.length)id=prior[0].id;
   else id=(await c.query('INSERT INTO kristine.'+table+'(company_id,'+keys.join(',')+') VALUES('+[companyId,...keys.map(k=>row[k])].map((_,i)=>'$'+(i+1)).join(',')+') RETURNING id',[companyId,...keys.map(k=>row[k])])).rows[0].id;
   const actual=(await c.query('SELECT '+keys.join(',')+' FROM kristine.'+table+' WHERE company_id=$1 AND id=$2',[companyId,id])).rows[0];
   if(!isDeepStrictEqual(actual,row))throw Error('Master projection readback failed');
   return {id,created:!prior.length};
  }
  const result={runId,contactsVerified:0,contactVersionsCreated:0,canonicalContactsCreated:0,projectsVerified:0,projectVersionsCreated:0,canonicalProjectsCreated:0,membersVerified:0,linksVerified:0,withReview:0,unresolvedContactLinks:0,withoutAddress:0};
  await source('master_reconciliation_file','_kristine/contact-master.json',contactsText);
  const versions=new Map();
  for(const r of contacts){
   const {sid,vid}=await source('contact_group',r.id,r.originalText);let mapped=contactIds.get(r.id)||null;
   if(!mapped){
    mapped=(await c.query('INSERT INTO kristine.contact_groups(company_id,display_name,phone,email,import_review_reasons) VALUES($1,$2,$3,$4,$5) RETURNING id',[companyId,r.name,r.phone,r.email,r.reasons])).rows[0].id;
    await c.query('INSERT INTO kristine.external_references(company_id,source_record_id,contact_group_id) VALUES($1,$2,$3)',[companyId,sid,mapped]);
    for(const m of r.members){
     const party=(await c.query('INSERT INTO kristine.parties(company_id,kind,display_name,email,phone) VALUES($1,$2,$3,$4,$5) RETURNING id',[companyId,m.kind,m.name,m.email,m.phone])).rows[0].id;
     await c.query('INSERT INTO kristine.contact_group_members(company_id,group_id,member_key,party_id) VALUES($1,$2,$3,$4)',[companyId,mapped,m.key,party]);
     if(m.kind==='person')await c.query('INSERT INTO kristine.contact_people(company_id,person_party_id) VALUES($1,$2)',[companyId,party]);
    }
    contactIds.set(r.id,mapped);result.canonicalContactsCreated++;
   }
   const reasons=[...r.reasons,...(mapped?[]:['contact_mapping_unresolved'])];
   const row={source_record_id:sid,source_version_id:vid,legacy_id:r.id,contact_group_id:mapped,display_name:r.name,phone:r.phone,email:r.email,import_review_reasons:reasons};row.projection_sha256=hash(JSON.stringify([row,r.members]));
   const saved=await projection('imported_contact_versions',row);
   const members=r.members.map(m=>({member_key:m.key,kind:m.kind,display_name:m.name,email:m.email,phone:m.phone})).sort((a,b)=>a.member_key.localeCompare(b.member_key));
   if(saved.created)for(const m of members)await c.query('INSERT INTO kristine.imported_contact_member_versions(company_id,contact_version_id,member_key,kind,display_name,email,phone) VALUES($1,$2,$3,$4,$5,$6,$7)',[companyId,saved.id,m.member_key,m.kind,m.display_name,m.email,m.phone]);
   const actual=(await c.query('SELECT member_key,kind,display_name,email,phone FROM kristine.imported_contact_member_versions WHERE company_id=$1 AND contact_version_id=$2 ORDER BY member_key',[companyId,saved.id])).rows;
   if(!isDeepStrictEqual(actual,members))throw Error('Contact member readback failed');
   await c.query('INSERT INTO kristine.master_reconciliation_contacts(company_id,source_instance_id,import_run_id,contact_version_id) VALUES($1,$2,$3,$4)',[companyId,sourceInstanceId,runId,saved.id]);versions.set(r.id,saved.id);
   result.contactsVerified++;result.membersVerified+=members.length;if(saved.created)result.contactVersionsCreated++;if(reasons.length)result.withReview++;
  }
  for(const r of prepared){
   const {sid,vid}=await source('project',r.externalId,r.originalText),address=prepareAddress(r.raw);let mapped=projectIds.get(r.externalId)||null;
   if(!mapped){
    mapped=(await c.query('INSERT INTO kristine.projects(company_id,project_number,name,status,offer_outcome,import_review_reasons) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[companyId,r.externalId,r.name,r.status,r.offerOutcome,r.reasons])).rows[0].id;
    await c.query('INSERT INTO kristine.external_references(company_id,source_record_id,project_id) VALUES($1,$2,$3)',[companyId,sid,mapped]);
    projectIds.set(r.externalId,mapped);result.canonicalProjectsCreated++;
   }
   const reasons=[...r.reasons,...(mapped?[]:['project_mapping_unresolved']),...(address?[]:['address_missing'])];if(!address)result.withoutAddress++;
   const [street,house_number,postal_code,city,address_extra]=address||[null,null,null,null,null];
   const row={source_record_id:sid,source_version_id:vid,legacy_id:r.externalId,project_id:mapped,name:r.name,status:r.status,offer_outcome:r.offerOutcome,street,house_number,postal_code,city,address_extra,country_original:text(r.raw.country),import_review_reasons:reasons};row.projection_sha256=hash(JSON.stringify(row));
   const saved=await projection('imported_project_versions',row);
   await c.query('INSERT INTO kristine.master_reconciliation_projects(company_id,source_instance_id,import_run_id,project_version_id) VALUES($1,$2,$3,$4)',[companyId,sourceInstanceId,runId,saved.id]);
   for(const role of ['owner','siteManager','architect']){
    const raw=r.raw.projectContacts?.[role];if(raw==null)continue;
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid project role reference');
    const legacy=text(raw.masterContactId),contact=legacy?versions.get(legacy)||null:null;
    const linkReasons=legacy&&!contact?['contact_reference_unresolved']:[];
    await c.query('INSERT INTO kristine.master_reconciliation_project_contacts(company_id,source_instance_id,import_run_id,project_version_id,role,legacy_contact_id,contact_version_id,raw_reference,import_review_reasons) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',[companyId,sourceInstanceId,runId,saved.id,role,legacy,contact,JSON.stringify(raw),linkReasons]);
    const actual=(await c.query('SELECT legacy_contact_id,contact_version_id,raw_reference,import_review_reasons FROM kristine.master_reconciliation_project_contacts WHERE import_run_id=$1 AND project_version_id=$2 AND role=$3',[runId,saved.id,role])).rows[0];
    if(!isDeepStrictEqual(actual,{legacy_contact_id:legacy,contact_version_id:contact,raw_reference:raw,import_review_reasons:linkReasons}))throw Error('Project contact readback failed');
    result.linksVerified++;if(linkReasons.length)result.unresolvedContactLinks++;
   }
   result.projectsVerified++;if(saved.created)result.projectVersionsCreated++;if(reasons.length)result.withReview++;
  }
  await c.query("UPDATE kristine.import_runs SET status='validated',finished_at=clock_timestamp() WHERE id=$1",[runId]);
  await c.query('COMMIT');begun=false;return result;
 }catch(e){if(begun)await c.query('ROLLBACK');throw e;}finally{c.release();}
}
module.exports={reconcileMasterData};
