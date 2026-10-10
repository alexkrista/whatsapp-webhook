'use strict';
const {createHash}=require('node:crypto');const {isDeepStrictEqual}=require('node:util');
const hash=t=>createHash('sha256').update(t).digest('hex');
const text=v=>{if(v==null)return '';if(typeof v!=='string')throw new Error('Contact field must remain text');return v;};
function prepareContacts(originalText){
 const rows=JSON.parse(originalText);if(!Array.isArray(rows))throw new Error('Contact master must be array');const ids=new Set();
 return rows.map(raw=>{
  const id=text(raw.id);if(!id.trim()||ids.has(id))throw new Error('Invalid/duplicate contact ID');ids.add(id);
  const name=text(raw.displayName);if(!name.trim())throw new Error('Contact name missing');
  if(!Array.isArray(raw.roles)||raw.roles.some(role=>!['owner','siteManager','architect'].includes(role)))throw new Error('Unknown contact role');
  const members=[];const owner=raw.roleData?.owner||{};
  const person=(key,title,first,last,email,phone)=>{if(!text(first).trim())return;members.push({key,kind:'person',name:[text(title),text(first),text(last)].filter(Boolean).join(' '),email:text(email)||null,phone:text(phone)||null});};
  if(owner.ownerRole==='Firma')members.push({key:'organization',kind:'organization',name:text(owner.customer)||text(raw.company)||name,email:null,phone:null});
  if((raw.roles||[]).includes('owner')){
   person('owner_woman',owner.womanTitle,owner.womanFirstName,owner.womanLastName,owner.womanEmail,owner.phoneOwnerWoman);
   person('owner_man',owner.manTitle,owner.manFirstName,owner.manLastName,owner.manEmail,owner.phoneOwnerMan);
  }else person('primary',raw.title,raw.firstName,raw.lastName,raw.email,raw.phone);
  const reasons=members.length?[]:['person_or_company_details_missing'];
  return {id,name,phone:text(raw.phone)||null,email:text(raw.email)||null,members,reasons,raw,originalText:JSON.stringify(raw)};
 });
}
async function importContactGroups(pool,{companyId,sourceInstanceId,originalText}){
 const prepared=prepareContacts(originalText),byId=new Map(prepared.map(r=>[r.id,r]));const c=await pool.connect();let begun=false;
 try{
  await c.query('BEGIN');begun=true;
  if((await c.query('SELECT id FROM kristine.source_instances WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,sourceInstanceId])).rows.length!==1)throw new Error('Source/company mismatch');
  const projectSources=(await c.query("SELECT s.external_id,x.project_id,v.id version_id,v.raw_payload,v.original_text,v.source_sha256 FROM kristine.source_records s JOIN kristine.external_references x ON x.source_record_id=s.id AND x.company_id=s.company_id JOIN kristine.source_record_versions v ON v.source_record_id=s.id AND v.company_id=s.company_id WHERE s.company_id=$1 AND s.source_instance_id=$2 AND s.entity_type='project'",[companyId,sourceInstanceId])).rows;
  const links=[],seen=new Set();
  for(const p of projectSources){if(seen.has(p.external_id)||!p.project_id||hash(p.original_text)!==p.source_sha256||!isDeepStrictEqual(JSON.parse(p.original_text),p.raw_payload))throw new Error('Project source history requires review');seen.add(p.external_id);for(const role of ['owner','siteManager','architect']){const id=p.raw_payload.projectContacts?.[role]?.masterContactId;if(!id)continue;if(!byId.has(id))throw new Error('Unknown contact master reference');links.push({projectId:p.project_id,versionId:p.version_id,role,contactId:id});}}
  const run=(await c.query('INSERT INTO kristine.import_runs(company_id,source_instance_id,manifest_sha256) VALUES($1,$2,$3) RETURNING id',[companyId,sourceInstanceId,hash(originalText)])).rows[0].id;
  const sourceRecord=async(type,id)=> (await c.query('INSERT INTO kristine.source_records(company_id,source_instance_id,entity_type,external_id) VALUES($1,$2,$3,$4) ON CONFLICT(company_id,source_instance_id,entity_type,external_id) DO UPDATE SET external_id=EXCLUDED.external_id RETURNING id',[companyId,sourceInstanceId,type,id])).rows[0].id;
  const sourceVersion=async(sid,sourceText)=>{const old=(await c.query('SELECT source_sha256 FROM kristine.source_record_versions WHERE source_record_id=$1',[sid])).rows;if(old.length){if(old.length!==1||old[0].source_sha256!==hash(sourceText))throw new Error('Contact source changed; review required');return;}await c.query('INSERT INTO kristine.source_record_versions(company_id,source_instance_id,source_record_id,import_run_id,raw_payload,original_text,source_sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',[companyId,sourceInstanceId,sid,run,sourceText,sourceText,hash(sourceText)]);};
  await sourceVersion(await sourceRecord('contact_master_file','_kristine/contact-master.json'),originalText);
  const result={groupsCreated:0,groupsUnchanged:0,peopleCreated:0,organizationsCreated:0,linksCreated:0,linksVerified:0,review:prepared.filter(r=>r.reasons.length).length};const groups=new Map();
  for(const r of prepared){
   const sid=await sourceRecord('contact_group',r.id);const refs=(await c.query('SELECT contact_group_id FROM kristine.external_references WHERE company_id=$1 AND source_record_id=$2',[companyId,sid])).rows;let gid;
   if(refs.length){if(!refs[0].contact_group_id)throw new Error('Contact mapping conflict');gid=refs[0].contact_group_id;await sourceVersion(sid,r.originalText);result.groupsUnchanged++;}
   else{
    if((await c.query('SELECT 1 FROM kristine.source_record_versions WHERE source_record_id=$1',[sid])).rows.length)throw new Error('Contact mapping missing; review required');
    gid=(await c.query('INSERT INTO kristine.contact_groups(company_id,display_name,phone,email,import_review_reasons) VALUES($1,$2,$3,$4,$5) RETURNING id',[companyId,r.name,r.phone,r.email,r.reasons])).rows[0].id;
    await c.query('INSERT INTO kristine.external_references(company_id,source_record_id,contact_group_id) VALUES($1,$2,$3)',[companyId,sid,gid]);await sourceVersion(sid,r.originalText);result.groupsCreated++;
    for(const m of r.members){const pid=(await c.query('INSERT INTO kristine.parties(company_id,kind,display_name,email,phone) VALUES($1,$2,$3,$4,$5) RETURNING id',[companyId,m.kind,m.name,m.email,m.phone])).rows[0].id;await c.query('INSERT INTO kristine.contact_group_members(company_id,group_id,member_key,party_id) VALUES($1,$2,$3,$4)',[companyId,gid,m.key,pid]);if(m.kind==='person'){await c.query('INSERT INTO kristine.contact_people(company_id,person_party_id) VALUES($1,$2)',[companyId,pid]);result.peopleCreated++;}else result.organizationsCreated++;}
   }
   const group=(await c.query('SELECT display_name,phone,email,import_review_reasons FROM kristine.contact_groups WHERE company_id=$1 AND id=$2',[companyId,gid])).rows;
   if(group.length!==1||!isDeepStrictEqual(Object.values(group[0]),[r.name,r.phone,r.email,r.reasons]))throw new Error('Contact group verification failed');
   const actual=(await c.query('SELECT m.member_key AS key,p.kind,p.display_name AS name,p.email,p.phone FROM kristine.contact_group_members m JOIN kristine.parties p ON p.company_id=m.company_id AND p.id=m.party_id WHERE m.company_id=$1 AND m.group_id=$2 ORDER BY m.member_key',[companyId,gid])).rows;
   if(!isDeepStrictEqual(actual,[...r.members].sort((a,b)=>a.key.localeCompare(b.key))))throw new Error('Contact person verification failed');groups.set(r.id,gid);
  }
  for(const l of links){const gid=groups.get(l.contactId);const inserted=await c.query('INSERT INTO kristine.project_contact_group_links(company_id,project_id,group_id,role,source_version_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id,group_id,role) DO NOTHING RETURNING id',[companyId,l.projectId,gid,l.role,l.versionId]);result.linksCreated+=inserted.rows.length;const actual=(await c.query('SELECT source_version_id FROM kristine.project_contact_group_links WHERE company_id=$1 AND project_id=$2 AND group_id=$3 AND role=$4',[companyId,l.projectId,gid,l.role])).rows;if(actual.length!==1||actual[0].source_version_id!==l.versionId)throw new Error('Contact link verification failed');result.linksVerified++;}
  await c.query("UPDATE kristine.import_runs SET status='validated',finished_at=clock_timestamp() WHERE id=$1",[run]);await c.query('COMMIT');begun=false;return result;
 }catch(e){if(begun)await c.query('ROLLBACK');throw e;}finally{c.release();}
}
module.exports={prepareContacts,importContactGroups};
