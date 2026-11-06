'use strict';
const {createHash}=require('node:crypto'),{isDeepStrictEqual}=require('node:util');
const {arraySourceTexts}=require('./json-source-slices');
const hash=s=>createHash('sha256').update(s).digest('hex');
const text=v=>v==null?null:typeof v==='string'?v:(()=>{throw Error('Supplemental field must remain text');})();
const object=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:(()=>{throw Error('Supplemental object expected');})();
const array=v=>v==null?[]:Array.isArray(v)?v:(()=>{throw Error('Supplemental array expected');})();
async function importSupplementalWorkflows(pool,{companyId,sourceInstanceId,visitsText,rulesText,emailsText}){
 const visits=array(JSON.parse(visitsText)),rules=object(JSON.parse(rulesText)),emails=object(object(JSON.parse(emailsText)).emails);
 const slices=arraySourceTexts(visitsText);if(slices.length!==visits.length)throw Error('Visit source range mismatch');
 const ids=new Set();for(const r of visits){object(r);if(!text(r.id)||ids.has(r.id))throw Error('Missing or duplicate visit ID');ids.add(r.id);}
 const c=await pool.connect();let begun=false;
 try{
  await c.query('BEGIN');begun=true;
  if((await c.query('SELECT id FROM kristine.source_instances WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,sourceInstanceId])).rows.length!==1)throw Error('Source/company mismatch');
  const manifest=hash(JSON.stringify([hash(visitsText),hash(rulesText),hash(emailsText)]));
  const runId=(await c.query('INSERT INTO kristine.import_runs(company_id,source_instance_id,manifest_sha256) VALUES($1,$2,$3) RETURNING id',[companyId,sourceInstanceId,manifest])).rows[0].id;
  await c.query('INSERT INTO kristine.supplemental_import_runs(company_id,source_instance_id,import_run_id) VALUES($1,$2,$3)',[companyId,sourceInstanceId,runId]);
  const result={runId,visitsVerified:0,visitVersionsCreated:0,timelineVerified:0,assetsVerified:0,settingsVerified:0,settingVersionsCreated:0};
  async function source(kind,id,original){
   const sid=(await c.query('INSERT INTO kristine.source_records(company_id,source_instance_id,entity_type,external_id) VALUES($1,$2,$3,$4) ON CONFLICT(company_id,source_instance_id,entity_type,external_id) DO UPDATE SET external_id=EXCLUDED.external_id RETURNING id',[companyId,sourceInstanceId,kind,id])).rows[0].id;
   const sha=hash(original),old=(await c.query('SELECT id FROM kristine.source_record_versions WHERE company_id=$1 AND source_record_id=$2 AND source_sha256=$3',[companyId,sid,sha])).rows;
   const vid=old.length?old[0].id:(await c.query('INSERT INTO kristine.source_record_versions(company_id,source_instance_id,source_record_id,import_run_id,raw_payload,original_text,source_sha256) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING id',[companyId,sourceInstanceId,sid,runId,original,original,sha])).rows[0].id;
   const verified=(await c.query('SELECT original_text=$3 AND raw_payload=$3::jsonb AND source_sha256=$4 AS ok FROM kristine.source_record_versions WHERE company_id=$1 AND id=$2',[companyId,vid,original,sha])).rows[0];
   if(!verified?.ok)throw Error('Supplemental source integrity conflict');return {sid,vid};
  }
  async function save(table,row){
   const keys=Object.keys(row),old=(await c.query('SELECT id FROM kristine.'+table+' WHERE company_id=$1 AND source_record_id=$2 AND source_version_id=$3',[companyId,row.source_record_id,row.source_version_id])).rows;
   const id=old.length?old[0].id:(await c.query('INSERT INTO kristine.'+table+'(company_id,'+keys.join(',')+') VALUES('+[companyId,...keys.map(k=>row[k])].map((_,i)=>'$'+(i+1)).join(',')+') RETURNING id',[companyId,...keys.map(k=>row[k])])).rows[0].id;
   const actual=(await c.query('SELECT '+keys.join(',')+' FROM kristine.'+table+' WHERE company_id=$1 AND id=$2',[companyId,id])).rows[0];
   if(!isDeepStrictEqual(actual,row))throw Error('Supplemental typed readback failed');return{id,created:!old.length};
  }
  async function children(table,parent,rows,originals){
   for(const [index,row]of rows.entries()){const keys=Object.keys(row);await c.query('INSERT INTO kristine.'+table+'(company_id,visit_version_id,'+keys.join(',')+') VALUES('+[companyId,parent,...keys.map(k=>row[k])].map((_,i)=>'$'+(i+1)+(keys[i-2]==='raw_payload'?'::jsonb':'')).join(',')+') ON CONFLICT DO NOTHING',[companyId,parent,...keys.map(k=>k==='raw_payload'?originals[index]:row[k])]);}
   for(let i=0;i<rows.length;i++){const row=rows[i],args=[companyId,parent,row.position,originals[i]],filter=table.endsWith('assets')?' AND collection=$5':'';if(filter)args.push(row.collection);const ok=(await c.query('SELECT raw_payload=$4::jsonb AS ok FROM kristine.'+table+' WHERE company_id=$1 AND visit_version_id=$2 AND position=$3'+filter,args)).rows[0]?.ok;if(!ok)throw Error('Supplemental child source integrity conflict');}
   if(!rows.length){if((await c.query('SELECT count(*)::int n FROM kristine.'+table+' WHERE company_id=$1 AND visit_version_id=$2',[companyId,parent])).rows[0].n)throw Error('Unexpected supplemental children');return;}
   const keys=Object.keys(rows[0]),actual=(await c.query('SELECT '+keys.join(',')+' FROM kristine.'+table+' WHERE company_id=$1 AND visit_version_id=$2 ORDER BY '+(table.endsWith('assets')?'collection,position':'position'),[companyId,parent])).rows;
   if(!isDeepStrictEqual(actual,rows))throw Error('Supplemental children readback failed');
  }
  await source('supplemental_file','_kristine/visit-workflows.json',visitsText);
  await source('supplemental_file','_kristine/employee-work-rules.json',rulesText);
  await source('supplemental_file','_kristine/employee-contact-emails.json',emailsText);
  for(let i=0;i<visits.length;i++){
   const r=visits[i],p=r.protocol==null?{}:object(r.protocol),a=r.appointment==null?{}:object(r.appointment),{sid,vid}=await source('visit_workflow',r.id,slices[i]);
   const amount=(await c.query("SELECT raw_payload->>'contractAmount' AS amount FROM kristine.source_record_versions WHERE company_id=$1 AND id=$2",[companyId,vid])).rows[0].amount;
   const row={source_record_id:sid,source_version_id:vid,legacy_id:r.id,legacy_key:text(r.key),legacy_task_id:text(r.taskId),legacy_project_id:text(r.jobId),target_original:text(r.target),status_original:text(r.status),title:text(r.title),customer_original:text(r.customer),address_original:text(r.address),contact_phone_original:text(r.contactPhone),contact_email_original:text(r.contactEmail),created_at_original:text(r.createdAt),updated_at_original:text(r.updatedAt),start_date_original:text(r.startDate),legacy_start_employee_id:text(r.startEmployeeId),start_employee_name_original:text(r.startEmployeeName),contract_amount_original:amount,appointment_date_original:text(a.date),appointment_from_original:text(a.from),appointment_to_original:text(a.to),calendar_owner_original:text(a.calendarOwner),calendar_account_original:text(a.calendarAccount),discussion:text(p.discussion),work_description:text(p.work),estimate_description:text(p.estimate),next_steps:text(p.nextSteps),protocol_saved_at_original:text(p.savedAt),conversion_target_original:text(p.conversionTarget),conversion_status_original:text(p.conversionStatus),conversion_prepared_at_original:text(p.conversionPreparedAt),protocol_source_task_id:text(p.sourceTaskId)};
   const saved=await save('imported_visit_versions',row);
   const timeline=array(r.timeline).map((x,position)=>{object(x);return{position,type_original:text(x.type),label_original:text(x.label),at_original:text(x.at),raw_payload:x};});
   const assets=[];for(const collection of ['files','recordings'])for(const [position,x]of array(p[collection]).entries()){
    object(x);if(x.size!=null&&!(typeof x.size==='string'||Number.isSafeInteger(x.size)&&x.size>=0))throw Error('Invalid asset size');
    assets.push({collection,position,legacy_id:text(x.id),legacy_task_id:text(x.taskId),name_original:text(x.name),mime_type_original:text(x.mimeType),size_original:x.size==null?null:String(x.size),sha256_original:text(x.sha256),url_original:text(x.url??x.audioUrl),created_at_original:text(x.createdAt),recorded_at_original:text(x.recordedAt),consent_at_original:text(x.consentAt),kind_original:text(x.kind),transcript:text(x.transcript),transcription_error:text(x.transcriptionError),raw_payload:x});
   }
   const timelineTexts=r.timeline==null?[]:arraySourceTexts(slices[i],['timeline']);
   const assetTexts=['files','recordings'].flatMap(k=>p[k]==null?[]:arraySourceTexts(slices[i],['protocol',k]));
   await children('imported_visit_timeline',saved.id,timeline,timelineTexts);await children('imported_visit_assets',saved.id,assets,assetTexts);
   await c.query('INSERT INTO kristine.supplemental_visit_members(company_id,source_instance_id,import_run_id,version_id) VALUES($1,$2,$3,$4)',[companyId,sourceInstanceId,runId,saved.id]);
   result.visitsVerified++;if(saved.created)result.visitVersionsCreated++;result.timelineVerified+=timeline.length;result.assetsVerified+=assets.length;
  }
  for(const [kind,entries]of [['work_rules',rules],['contact_email',emails]])for(const [legacy,value]of Object.entries(entries)){
   if(!legacy)throw Error('Missing employee ID');const r=kind==='work_rules'?object(value):{email:text(value)};if(r.buak!=null&&typeof r.buak!=='boolean')throw Error('BUAK flag must remain boolean');
   const {sid,vid}=await source('employee_'+kind,legacy,JSON.stringify(value));
   const saved=await save('imported_employee_setting_versions',{source_record_id:sid,source_version_id:vid,legacy_employee_id:legacy,setting_kind:kind,activity_mode_original:text(r.activityMode),buak_original:r.buak??null,email_original:text(r.email)});
   await c.query('INSERT INTO kristine.supplemental_employee_setting_members(company_id,source_instance_id,import_run_id,version_id) VALUES($1,$2,$3,$4)',[companyId,sourceInstanceId,runId,saved.id]);
   result.settingsVerified++;if(saved.created)result.settingVersionsCreated++;
  }
  await c.query("UPDATE kristine.import_runs SET status='validated',finished_at=clock_timestamp() WHERE id=$1",[runId]);
  await c.query('COMMIT');begun=false;return result;
 }catch(e){if(begun)await c.query('ROLLBACK');throw e;}finally{c.release();}
}
module.exports={importSupplementalWorkflows};
