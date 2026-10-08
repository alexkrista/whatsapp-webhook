'use strict';
// Explicit operator command only. Never loaded by application startup.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {prepareExternalDatasets,importExternalDatasets}=require('./import-external-datasets');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function main(){
 const [input,expected]=process.argv.slice(2);
 if(!input||!/^[a-f0-9]{64}$/.test(expected||''))throw Error('Package and exact SHA-256 required');
 const packed=fs.readFileSync(input);if(sha(packed)!==expected)throw Error('Transfer checksum mismatch');
 const payload=JSON.parse(zlib.gunzipSync(packed).toString('utf8'));
 const entries=Object.entries(payload);
 const required=['Leistungstexte','LMaterial','LMaterialIndex','Floskeltexte'].map(t=>'sql/WinWorker_Stammdaten_Standard/dbo/'+t+'.json');
 if(entries.length!==4||required.some(p=>typeof payload[p]!=='string'))throw Error('Exact performance/material source set required');
 const files=entries.map(([path,originalText])=>({path,originalText}));prepareExternalDatasets(files);
 const {Pool}=require(process.env.PG_MODULE_PATH||'pg'),pool=new Pool({connectionString:process.env.DATABASE_URL,max:1});
 const companyId='89f06754-feaf-4daa-a5d4-2ee0091dfb4a';
 try{
  let sourceInstanceId;const c=await pool.connect();
  try{
   if((await c.query('SELECT current_database() name')).rows[0].name!=='kristine_postgres')throw Error('Unexpected target database');
   if(!(await c.query('SELECT id FROM kristine.companies WHERE id=$1',[companyId])).rows.length)throw Error('Expected company missing');
   sourceInstanceId=(await c.query("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'winworker','srv-db01-winworker-standard-performance-material') ON CONFLICT(company_id,system_code,instance_key) DO UPDATE SET instance_key=EXCLUDED.instance_key RETURNING id",[companyId])).rows[0].id;
  }finally{c.release();}
  const backup=path.join(path.dirname(input),'performance-material-import-'+Date.now());fs.mkdirSync(backup,{recursive:true});
  for(const f of files){const dest=path.join(backup,f.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,f.originalText);}
  const args={companyId,sourceInstanceId,files},first=await importExternalDatasets(pool,args),repeat=await importExternalDatasets(pool,args);
  if(repeat.rowsCreated!==0)throw Error('Repeat unexpectedly created projection rows');
  const report={checkedAt:new Date().toISOString(),sourceInstanceId,packageSha256:expected,backup,first,repeat};
  fs.writeFileSync(path.join(backup,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{await pool.end();}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={main};
