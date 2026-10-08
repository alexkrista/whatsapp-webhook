'use strict';
// Explicit operator command; never loaded by application startup.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const hashes={'migrations/024-external-dataset-import.sql':'e42e7744ce07cb2ae31cee3c57cf6968fc726be311f9c6a482469407714e1f0f','storage/import-external-datasets.js':'53c5c8d1ad9e26083b1c0039c79d3d6c443be53e023cb49b9d3fe7e2dac0cc69','storage/import-json-snapshots.js':'f40bad738aadc711253772630505915fd2638cf193962f784fbbc69fc4a405aa','storage/json-source-slices.js':'d9059702d137988a41f96de743e08989dbc1c1bed0136f5ce0aa163d700c4aca'};
const commit='e2b360cd0a254673cfeeb73db4c4c605b79aaa90';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function main(){
 const root=__dirname,input=process.argv[2];if(!input)throw Error('Transfer package path required');
 const packed=fs.readFileSync(input);if(process.argv[3]&&sha(packed)!==process.argv[3])throw Error('Transfer checksum mismatch');
 const payload=JSON.parse(zlib.gunzipSync(packed).toString('utf8'));
 for(const [p,want] of Object.entries(hashes)){const r=await fetch('https://raw.githubusercontent.com/alexkrista/whatsapp-webhook/'+commit+'/'+p);if(!r.ok)throw Error('Import code unavailable');const body=await r.text();if(sha(body)!==want)throw Error('Import code checksum mismatch');fs.writeFileSync(path.join(root,path.basename(p)),body);}
 const backup=path.join(path.dirname(input),'external-datasets-'+Date.now());fs.mkdirSync(backup,{recursive:true});
 for(const [p,body] of Object.entries(payload)){if(typeof body!=='string'||p.startsWith('/')||p.split('/').includes('..'))throw Error('Invalid external file');const dest=path.join(backup,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,body);}
 const {Pool}=require(path.join(root,'node_modules/pg'));const pool=new Pool({connectionString:process.env.DATABASE_URL});
 try{
  const c=await pool.connect();try{if(!(await c.query("SELECT to_regclass('kristine.external_dataset_runs') name")).rows[0].name)await c.query(fs.readFileSync(path.join(root,'024-external-dataset-import.sql'),'utf8'));}finally{c.release();}
  const companyId='89f06754-feaf-4daa-a5d4-2ee0091dfb4a',importer=require('./import-external-datasets.js'),reports=[];
  for(const [system,key,include] of [['kristine','pc-alex02-brain-archive-index',p=>p.startsWith('archive/')],['winworker','srv-db01-winworker-standard-core',p=>p.startsWith('sql/')]]){
   let sourceInstanceId;const c=await pool.connect();try{sourceInstanceId=(await c.query('INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,$2,$3) ON CONFLICT(company_id,system_code,instance_key) DO UPDATE SET instance_key=EXCLUDED.instance_key RETURNING id',[companyId,system,key])).rows[0].id;}finally{c.release();}
   const args={companyId,sourceInstanceId,files:Object.entries(payload).filter(([p])=>include(p)).map(([path,originalText])=>({path,originalText}))};
   console.log('IMPORT START',key);const first=await importer.importExternalDatasets(pool,args);console.log('IMPORT VALIDATED',key,first.rowsVerified);const repeat=await importer.importExternalDatasets(pool,args);reports.push({key,sourceInstanceId,first,repeat});
  }
  const c=await pool.connect();let archiveCounts,size;try{archiveCounts=(await c.query('SELECT source_label_original,count(*)::int entries FROM kristine.latest_external_archive_index WHERE company_id=$1 GROUP BY source_label_original',[companyId])).rows;size=(await c.query('SELECT pg_database_size(current_database())::text bytes,pg_size_pretty(pg_database_size(current_database())) display')).rows[0];}finally{c.release();}
  const report={checkedAt:new Date().toISOString(),backup,reports,archiveCounts,databaseSize:size};fs.writeFileSync(path.join(backup,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{await pool.end();}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={main};
