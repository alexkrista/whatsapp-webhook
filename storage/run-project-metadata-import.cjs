'use strict';
// Explicit operator-run migration. Never called during application startup.
const fs=require('node:fs/promises');const path=require('node:path');
const {createHash}=require('node:crypto');const {isDeepStrictEqual}=require('node:util');
const {Pool}=require('/tmp/kristine-sql-tools/node_modules/pg');
const hash=value=>createHash('sha256').update(value).digest('hex');
const version='0a02bde511232736b6058354c30417bc46783297';
const root=process.env.DATA_DIR||'/var/data';
const pool=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000});
async function download(file,expected){
 const r=await fetch(`https://raw.githubusercontent.com/alexkrista/whatsapp-webhook/${version}/${file}`);
 if(!r.ok)throw new Error('Download failed: '+file);
 const text=await r.text();if(hash(text)!==expected)throw new Error('Checksum failed: '+file);return text;
}
async function backup(file,text){
 const dir=path.join(root,'_sql-import-originals','projects',file);await fs.mkdir(dir,{recursive:true,mode:0o700});
 const target=path.join(dir,hash(text)+'.json');
 try{await fs.writeFile(target,text,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
 if(hash(await fs.readFile(target))!==hash(text))throw new Error('Backup mismatch');
}
(async()=>{
 const moduleCode=await download('storage/import-project-metadata.js','f88f52cf78d63795f056fcee6ee9524e316d3155cc808af39ceaf7a21b953836');
 const migration=await download('migrations/005-project-import-review.sql','8b97cfda86d396dc85360d4df11567465df0488a96a7ca98bef518014611c9a9');
 const modulePath='/tmp/kristine-sql-tools/import-project-metadata.cjs';await fs.writeFile(modulePath,moduleCode,{mode:0o600});
 const {prepareProjects,importProjects}=require(modulePath);
 const records=[];
 for(const e of (await fs.readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  if(!e.isDirectory()||e.name.startsWith('_'))continue;
  const file=path.join(root,e.name,'.meta.json');let bytes;
  try{bytes=await fs.readFile(file);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  const originalText=bytes.toString('utf8');if(!Buffer.from(originalText,'utf8').equals(bytes))throw new Error('Invalid UTF-8 source');
  records.push({externalId:e.name,originalText});
 }
 if(records.length!==90)throw new Error('Project inventory changed; expected 90');
 const prepared=prepareProjects(records);
 const company=(await pool.query('SELECT id,name FROM kristine.companies')).rows;
 if(company.length!==1||company[0].name!=='Farben Krista GmbH & Co KG')throw new Error('Company requires review');
 const companyId=company[0].id;
 const sources=(await pool.query("SELECT id FROM kristine.source_instances WHERE company_id=$1 AND system_code='kristine' AND instance_key='render-baustellenprotokoll'",[companyId])).rows;
 if(sources.length!==1)throw new Error('Source requires review');const sourceInstanceId=sources[0].id;
 for(const r of records)await backup(r.externalId,r.originalText);
 for(const r of records)if(hash(await fs.readFile(path.join(root,r.externalId,'.meta.json')))!==hash(r.originalText))throw new Error('Source changed before import');
 console.log('Originaldateien vollständig gesichert:',records.length);
 const columns=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='kristine' AND table_name='projects' AND column_name IN ('offer_outcome','import_review_reasons')")).rows;
 if(columns.length===0)await pool.query(migration);
 else if(columns.length!==2)throw new Error('Incomplete project review schema');
 const result=await importProjects(pool,{companyId,sourceInstanceId,records});
 let verified=0,changed=0;
 for(const r of prepared){
  const rows=(await pool.query("SELECT p.project_number,p.name,p.status,p.offer_outcome,p.import_review_reasons,v.original_text,v.source_sha256,v.raw_payload FROM kristine.source_records s JOIN kristine.external_references x ON x.source_record_id=s.id JOIN kristine.projects p ON p.id=x.project_id AND p.company_id=s.company_id JOIN kristine.source_record_versions v ON v.source_record_id=s.id WHERE s.company_id=$1 AND s.source_instance_id=$2 AND s.entity_type='project' AND s.external_id=$3",[companyId,sourceInstanceId,r.externalId])).rows;
  const row=rows[0];
  if(rows.length!==1||row.project_number!==r.externalId||row.name!==r.name||row.status!==r.status||row.offer_outcome!==r.offerOutcome||!isDeepStrictEqual(row.import_review_reasons,r.reasons)||row.original_text!==r.originalText||row.source_sha256!==r.sha256||!isDeepStrictEqual(row.raw_payload,r.raw))throw new Error('Post-import verification failed');
  verified++;if(hash(await fs.readFile(path.join(root,r.externalId,'.meta.json')))!==r.sha256)changed++;
 }
 console.log('Baustellen neu importiert:',result.created);
 console.log('Bereits unverändert vorhanden:',result.unchanged);
 console.log('Vollständig geprüft:',verified,'von',records.length);
 console.log('Abgelehnte Angebote korrekt erhalten:',result.rejected);
 console.log('Zur Stammdatenprüfung markiert:',result.review);
 console.log('Seit Importaufnahme geänderte JSON-Dateien:',changed);
 console.log('Kristine arbeitet weiterhin mit JSON. Kein Anwendungsdeploy.');
})().catch(e=>{console.log('Import/Prüfung abgebrochen:',e.code||e.message.replace(/postgres(?:ql)?:\/\/\S+/g,'[ausgeblendet]'));process.exitCode=1;}).finally(()=>pool.end());
