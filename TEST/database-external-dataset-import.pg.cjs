'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require(process.env.PGLITE_MODULE_PATH||'@electric-sql/pglite');
const {importExternalDatasets}=require('../storage/import-external-datasets');
test('external archives and SQL rows retain originals, exact decimals, schemas, duplicates, rollback and source history',async()=>{
 const db=new PGlite(),pool={connect:async()=>({query:(s,a)=>db.query(s,a),release(){}})};
 try{
  for(const f of fs.readdirSync(__dirname+'/../migrations').filter(f=>f.endsWith('.sql')).sort())await db.exec(fs.readFileSync(__dirname+'/../migrations/'+f,'utf8'));
  const companyId=(await db.query("INSERT INTO kristine.companies(name) VALUES('A') RETURNING id")).rows[0].id;
  const sourceInstanceId=(await db.query("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'winworker','WW') RETURNING id",[companyId])).rows[0].id,scope={companyId,sourceInstanceId};
  const archive=[{path:'archive/pdf-index-metadata.json',originalText:'[{"path":"N:/a.pdf","source":"WW","logical_id":"001","size":9007199254740993,"text_length":15}]'}];
  const run=files=>importExternalDatasets(pool,{...scope,files});const first=await run(archive);assert.equal(first.rowsVerified,1);
  assert.equal((await db.query('SELECT indexed_size_original FROM kristine.latest_external_archive_index')).rows[0].indexed_size_original,'9007199254740993');assert.equal((await run(archive)).rowsCreated,0);
  const files=Object.entries({WinWorker_Adressen_Standard:['Kunden','Ansprechpartner','WeitereEmailAdressen','Lieferanten_Eigenschaften'],WinWorker_Projekte_Standard:['Projekte','Projekt Info']}).flatMap(([database,tables])=>tables.map(table=>({path:'sql/'+database+'/dbo/'+table+'.json',originalText:JSON.stringify({database,schema:'dbo',table,columns:[['amount','decimal',9,20,2,false]],primaryKey:[],encodings:{decimal:'text-exact'},rows:table==='Kunden'?Array(401).fill({amount:'9007199254740993.17',code:'001',unknown:false}):[]})})));
  await run(files);assert.equal((await db.query('SELECT count(*)::int n FROM kristine.latest_external_dataset_rows')).rows[0].n,401);assert.equal((await db.query("SELECT raw_payload->>'amount' amount,source_metadata->'encodings' enc FROM kristine.latest_external_dataset_rows LIMIT 1")).rows[0].amount,'9007199254740993.17');assert.equal((await run(files)).rowsCreated,0);
  await assert.rejects(run(files.slice(1)),/Full external/);await assert.rejects(run([{...archive[0],originalText:'[{"path":"N:/a"},{"path":"N:/a"}]'}]),/duplicate/);
  let failed=false;const broken={connect:async()=>({query:async(s,a)=>{const r=await db.query(s,a);if(!failed&&s.includes('INSERT INTO kristine.imported_external_dataset_rows')){failed=true;throw Error('projection fault');}return r;},release(){}})};
  await assert.rejects(importExternalDatasets(broken,{...scope,files:[{...archive[0],originalText:archive[0].originalText.replace('N:/a.pdf','N:/b.pdf')}]}),/projection fault/);assert.equal((await db.query('SELECT count(*)::int n FROM kristine.latest_external_dataset_rows')).rows[0].n,401);
  await run(archive);assert.equal((await db.query('SELECT count(*)::int n FROM kristine.latest_external_dataset_rows')).rows[0].n,1);await run([{...archive[0],originalText:'[]'}]);assert.equal((await db.query('SELECT count(*)::int n FROM kristine.latest_external_dataset_rows')).rows[0].n,0);
  await assert.rejects(db.query('DELETE FROM kristine.external_dataset_runs'),/append-only/);
  assert.equal((await db.query('SELECT count(*)::int n FROM kristine.projects')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int n FROM kristine.bank_transactions')).rows[0].n,0);
 }finally{await db.close();}
});
