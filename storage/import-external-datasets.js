'use strict';
const {createHash}=require('node:crypto');
const {arraySourceTexts}=require('./json-source-slices');
const {importJsonSnapshots}=require('./import-json-snapshots');
const hash=x=>createHash('sha256').update(x).digest('hex');
const allowed={WinWorker_Adressen_Standard:['Kunden','Ansprechpartner','WeitereEmailAdressen','Lieferanten_Eigenschaften'],WinWorker_Projekte_Standard:['Projekte','Projekt Info']};
function prepareExternalDatasets(files){
 const seen=new Set();if(!files.length)throw Error('External snapshot must list datasets');
 const prepared=files.map(f=>{
  if(seen.has(f.path))throw Error('Duplicate external dataset');seen.add(f.path);const root=JSON.parse(f.originalText);let slices,kind;
  if(f.path==='archive/pdf-index-metadata.json'){kind='archive_index';slices=arraySourceTexts(f.originalText);const paths=new Set();for(const r of root){if(typeof r.path!=='string'||!r.path||paths.has(r.path))throw Error('Invalid or duplicate archive path');paths.add(r.path);}}
  else{const match=/^sql\/(WinWorker_[A-Za-z]+_Standard)\/dbo\/([^/]+)\.json$/.exec(f.path);if(!match||!allowed[match[1]]?.includes(match[2]))throw Error('Unsupported external dataset path');
   if(root.database!==match[1]||root.schema!=='dbo'||root.table!==match[2]||!Array.isArray(root.columns)||!Array.isArray(root.primaryKey))throw Error('External table metadata mismatch');
   if(root.columns.some(c=>!Array.isArray(c)||typeof c[0]!=='string'||/password|passwort|secret|token|credential/i.test(c[0])))throw Error('Invalid or excluded external table column');
   kind='sql_table';slices=arraySourceTexts(f.originalText,['rows']);
  }
  for(const s of slices){const r=JSON.parse(s);if(!r||typeof r!=='object'||Array.isArray(r))throw Error('External row must be object');}
  return {...f,kind,slices,sha256:hash(f.originalText)};
 }).sort((a,b)=>a.path.localeCompare(b.path));
 const expected=seen.has('archive/pdf-index-metadata.json')?['archive/pdf-index-metadata.json']:Object.entries(allowed).flatMap(([db,tables])=>tables.map(t=>'sql/'+db+'/dbo/'+t+'.json'));
 if(files.length!==expected.length||expected.some(p=>!seen.has(p)))throw Error('Full external snapshot requires all datasets for its source');
 return prepared;
}
async function importExternalDatasets(pool,{companyId,sourceInstanceId,files}){
 const prepared=prepareExternalDatasets(files),snapshots=await importJsonSnapshots(pool,{companyId,sourceInstanceId,files});const c=await pool.connect();let begun=false;
 try{await c.query('BEGIN');begun=true;
  if((await c.query('SELECT id FROM kristine.source_instances WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,sourceInstanceId])).rows.length!==1)throw Error('Source/company mismatch');
  const runId=(await c.query('INSERT INTO kristine.import_runs(company_id,source_instance_id,manifest_sha256) VALUES($1,$2,$3) RETURNING id',[companyId,sourceInstanceId,hash(JSON.stringify(prepared.map(f=>[f.path,f.sha256])))])).rows[0].id;
  await c.query('INSERT INTO kristine.external_dataset_runs(company_id,source_instance_id,import_run_id) VALUES($1,$2,$3)',[companyId,sourceInstanceId,runId]);const result={runId,snapshots,filesVerified:0,rowsVerified:0,rowsCreated:0,datasets:[]};
  for(const f of prepared){const vid=(await c.query("SELECT v.id FROM kristine.source_records s JOIN kristine.source_record_versions v ON v.company_id=s.company_id AND v.source_record_id=s.id WHERE s.company_id=$1 AND s.source_instance_id=$2 AND s.entity_type='json_file_snapshot' AND s.external_id=$3 AND v.source_sha256=$4",[companyId,sourceInstanceId,f.path,f.sha256])).rows[0]?.id;if(!vid)throw Error('External snapshot missing');
   const prior=(await c.query('SELECT count(*)::int n FROM kristine.imported_external_dataset_rows WHERE company_id=$1 AND source_version_id=$2',[companyId,vid])).rows[0].n;if(prior!==0&&prior!==f.slices.length)throw Error('Incomplete external projection');
   for(let offset=0;offset<f.slices.length;offset+=200){const batch=f.slices.slice(offset,offset+200),args=[companyId,vid,offset,'['+batch.join(',')+']'];const src='WITH src AS (SELECT value raw,((ordinality-1)+$3::int)::int pos FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY) ';
    if(!prior)result.rowsCreated+=(await c.query(src+'INSERT INTO kristine.imported_external_dataset_rows(company_id,source_version_id,position,raw_payload) SELECT $1,$2,pos,raw FROM src ON CONFLICT DO NOTHING RETURNING position',args)).rows.length;
    const check=(await c.query(src+'SELECT count(*)::int n,count(*) FILTER(WHERE dst.position IS NULL OR dst.raw_payload IS DISTINCT FROM raw)::int mismatch FROM src LEFT JOIN kristine.imported_external_dataset_rows dst ON dst.company_id=$1 AND dst.source_version_id=$2 AND dst.position=pos',args)).rows[0];if(check.n!==batch.length||check.mismatch)throw Error('External typed readback mismatch');
   }
   const count=(await c.query('SELECT count(*)::int n FROM kristine.imported_external_dataset_rows WHERE company_id=$1 AND source_version_id=$2',[companyId,vid])).rows[0].n;if(count!==f.slices.length)throw Error('External row count mismatch');
   const metadata=f.kind==='sql_table'?(await c.query("SELECT ($1::jsonb)-'rows' value",[f.originalText])).rows[0].value:{scope:'index-metadata-only',pdfBytesIncluded:false,ocrTextIncluded:false};
   await c.query('INSERT INTO kristine.external_dataset_files(company_id,source_instance_id,import_run_id,source_version_id,source_path,dataset_kind,source_metadata) VALUES($1,$2,$3,$4,$5,$6,$7)',[companyId,sourceInstanceId,runId,vid,f.path,f.kind,metadata]);
   const saved=(await c.query('SELECT source_metadata=$3::jsonb same FROM kristine.external_dataset_files WHERE import_run_id=$1 AND source_path=$2',[runId,f.path,JSON.stringify(metadata)])).rows[0];if(!saved.same)throw Error('External metadata mismatch');
   result.filesVerified++;result.rowsVerified+=count;result.datasets.push({path:f.path,kind:f.kind,rows:count});
  }
  await c.query("UPDATE kristine.import_runs SET status='validated',finished_at=clock_timestamp() WHERE id=$1",[runId]);await c.query('COMMIT');begun=false;return result;
 }catch(e){if(begun)await c.query('ROLLBACK');throw e;}finally{c.release();}
}
module.exports={prepareExternalDatasets,importExternalDatasets};
