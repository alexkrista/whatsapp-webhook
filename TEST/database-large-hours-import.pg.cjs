 'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),z=require('node:zlib'),crypto=require('node:crypto');
const {PGlite}=require(process.env.PGLITE_MODULE_PATH||'@electric-sql/pglite');const {importLargeHours,KEY,rowTexts}=require('../storage/import-large-winworker-hours.cjs');const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
test('chunked hours preserve originals, typed rows, source isolation, repeat and rollback',async()=>{
const db=new PGlite(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'hours-test-')),pool={connect:async()=>({query:(s,a)=>db.query(s,a),release(){}})};try{
for(const f of fs.readdirSync(__dirname+'/../migrations').filter(f=>f.endsWith('.sql')).sort())await db.exec(fs.readFileSync(__dirname+'/../migrations/'+f,'utf8'));
const companyId=(await db.query("INSERT INTO kristine.companies(name) VALUES('Hours test') RETURNING id")).rows[0].id;
const sourceInstanceId=(await db.query("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'winworker',$2) RETURNING id",[companyId,KEY])).rows[0].id;
const wrong=(await db.query("INSERT INTO kristine.source_instances(company_id,system_code,instance_key) VALUES($1,'winworker','core') RETURNING id",[companyId])).rows[0].id;
const make=(n,suffix)=>{const input=path.join(dir,suffix+'.gz'),text=JSON.stringify({database:'WinWorker_Mitschreibung_Standard',schema:'dbo',table:'Stundenmitschreibung',columns:[['amount','decimal']],primaryKey:['ELIndex'],rows:Array.from({length:n},(_,i)=>({ELIndex:i,amount:'9007199254740993.17',text:'?\\"??'+suffix+'x'.repeat(2400)}))}),b=Buffer.from(text),packed=z.gzipSync(b);fs.writeFileSync(input,packed);return {input,companyId,sourceInstanceId,expectedGzip:sha(packed),expectedOriginal:sha(b),expectedBytes:b.length,expectedRows:n};};
const a=make(1001,'A');await assert.rejects(importLargeHours(pool,{...a,sourceInstanceId:wrong}),/source\/company/);assert.equal((await db.query('SELECT count(*)::int n FROM kristine.source_record_versions')).rows[0].n,0);
const first=await importLargeHours(pool,a);assert.equal(first.rowsCreated,1001);assert.equal(first.chunksVerified,2);const repeat=await importLargeHours(pool,a);assert.equal(repeat.rowsCreated,0);assert.equal(repeat.versionsCreated,0);
await assert.rejects(db.query('UPDATE kristine.external_source_chunks SET position=position'),/immutable|history|append|change/i);
const b=make(3,'B');let failed=false;const broken={connect:async()=>({query:async(s,a)=>{const r=await db.query(s,a);if(!failed&&s.includes('INSERT INTO kristine.imported_external_dataset_rows')){failed=true;throw Error('injected interruption');}return r;},release(){}})};
await assert.rejects(importLargeHours(broken,b),/injected/);assert.equal((await db.query('SELECT count(*)::int n FROM kristine.latest_external_dataset_rows')).rows[0].n,1001);
await importLargeHours(pool,b);assert.equal((await db.query('SELECT count(*)::int n FROM kristine.latest_external_dataset_rows')).rows[0].n,3);await importLargeHours(pool,a);assert.equal((await db.query('SELECT count(*)::int n FROM kristine.latest_external_dataset_rows')).rows[0].n,1001);
await assert.rejects(importLargeHours(pool,{...a,expectedGzip:'0'.repeat(64)}),/checksum/);
}finally{await db.close();fs.rmSync(dir,{recursive:true,force:true});}});
