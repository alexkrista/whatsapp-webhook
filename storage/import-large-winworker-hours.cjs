 'use strict';
const fs=require('node:fs'),zlib=require('node:zlib'),crypto=require('node:crypto');
const SOURCE='sql/WinWorker_Mitschreibung_Standard/dbo/Stundenmitschreibung.json';
const KEY='srv-db01-winworker-standard-time-history';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function* originalChunks(input){let pending=Buffer.alloc(0);for await(const b of fs.createReadStream(input).pipe(zlib.createGunzip())){pending=Buffer.concat([pending,b]);while(pending.length>=2097152){yield pending.subarray(0,2097152);pending=pending.subarray(2097152);}}if(pending.length)yield pending;}
async function* rowTexts(input){
 let header='',started=false,text='',depth=0,string=false,escape=false,closed=false,tail='';const decoder=new (require('node:string_decoder').StringDecoder)('utf8');
 function* consume(chunk){for(const ch of chunk){if(!started){header+=ch;if(header.length>1048576)throw Error('Oversized source header');if(header.endsWith('"rows":[')){started=true;const root=JSON.parse(header+']}');delete root.rows;if(root.database!=='WinWorker_Mitschreibung_Standard'||root.schema!=='dbo'||root.table!=='Stundenmitschreibung'||!Array.isArray(root.columns)||!Array.isArray(root.primaryKey)||root.columns.some(c=>/password|passwort|secret|token|credential/i.test(c[0])))throw Error('Source metadata mismatch');yield {metadata:root};}continue;}
 if(closed){tail+=ch;if(tail.length>1000)throw Error('Invalid trailing source');continue;}
 if(depth===0){if(/\s|,/.test(ch))continue;if(ch===']'){closed=true;continue;}if(ch!=='{')throw Error('Expected source object');text='{';depth=1;continue;}
 text+=ch;if(text.length>1048576)throw Error('Oversized source row');
 if(string){if(escape)escape=false;else if(ch==='\\')escape=true;else if(ch==='"')string=false;}
 else if(ch==='"')string=true;else if(ch==='{'||ch==='[')depth++;else if(ch==='}'||ch===']')depth--;
 if(depth===0){if(Buffer.byteLength(text)>1048576)throw Error('Oversized source row');yield {text};text='';}
 }}
 for await(const b of fs.createReadStream(input).pipe(zlib.createGunzip()))yield* consume(decoder.write(b));yield* consume(decoder.end());if(!started||!closed||depth||!/^\s*}\s*$/.test(tail))throw Error('Incomplete source JSON');
}
async function importLargeHours(pool,{input,companyId,sourceInstanceId,expectedGzip,expectedOriginal,expectedBytes,expectedRows}){
 if(!/^[a-f0-9]{64}$/.test(expectedGzip)||!/^[a-f0-9]{64}$/.test(expectedOriginal))throw Error('Exact source checksums required');
 const packedHash=crypto.createHash('sha256');for await(const b of fs.createReadStream(input))packedHash.update(b);if(packedHash.digest('hex')!==expectedGzip)throw Error('Gzip checksum mismatch');
 const c=await pool.connect();let begun=false;try{
 await c.query('BEGIN');begun=true;const src=(await c.query('SELECT system_code,instance_key FROM kristine.source_instances WHERE company_id=$1 AND id=$2 FOR UPDATE',[companyId,sourceInstanceId])).rows[0];if(!src||src.system_code!=='winworker'||src.instance_key!==KEY)throw Error('Hours source/company mismatch');
 const runId=(await c.query('INSERT INTO kristine.import_runs(company_id,source_instance_id,manifest_sha256) VALUES($1,$2,$3) RETURNING id',[companyId,sourceInstanceId,expectedOriginal])).rows[0].id;
 const sid=(await c.query("INSERT INTO kristine.source_records(company_id,source_instance_id,entity_type,external_id) VALUES($1,$2,'large_json_file_snapshot',$3) ON CONFLICT(company_id,source_instance_id,entity_type,external_id) DO UPDATE SET external_id=EXCLUDED.external_id RETURNING id",[companyId,sourceInstanceId,SOURCE])).rows[0].id;
 const meta={storage:'gzip_chunks_v1',originalBytes:expectedBytes,originalSha256:expectedOriginal,rows:expectedRows,chunkSize:2097152};
 const prior=(await c.query('SELECT id,raw_payload FROM kristine.source_record_versions WHERE source_record_id=$1 AND source_sha256=$2',[sid,expectedOriginal])).rows;if(prior.length>1)throw Error('Duplicate original version');let vid=prior[0]?.id;if(vid&&JSON.stringify(prior[0].raw_payload)!==JSON.stringify(meta)){const util=require('node:util');if(!util.isDeepStrictEqual(prior[0].raw_payload,meta))throw Error('Original metadata conflict');}
 if(!vid)vid=(await c.query('INSERT INTO kristine.source_record_versions(company_id,source_instance_id,source_record_id,import_run_id,raw_payload,original_text,source_sha256) VALUES($1,$2,$3,$4,$5,NULL,$6) RETURNING id',[companyId,sourceInstanceId,sid,runId,meta,expectedOriginal])).rows[0].id;
 let chunks=0,bytes=0;const rebuilt=crypto.createHash('sha256');
 for await(const b of originalChunks(input)){const h=sha(b);if(!prior.length)await c.query('INSERT INTO kristine.external_source_chunks(company_id,source_version_id,position,original_bytes,original_sha256,gzip_bytes) VALUES($1,$2,$3,$4,$5,$6)',[companyId,vid,chunks,b.length,h,zlib.gzipSync(b)]);
 const saved=(await c.query('SELECT original_bytes,original_sha256,gzip_bytes FROM kristine.external_source_chunks WHERE company_id=$1 AND source_version_id=$2 AND position=$3',[companyId,vid,chunks])).rows[0];if(!saved)throw Error('Missing original chunk');const raw=zlib.gunzipSync(saved.gzip_bytes);if(raw.length!==saved.original_bytes||sha(raw)!==saved.original_sha256||!raw.equals(b))throw Error('Original chunk readback mismatch');rebuilt.update(raw);bytes+=raw.length;chunks++;}
 if(bytes!==expectedBytes||rebuilt.digest('hex')!==expectedOriginal||(await c.query('SELECT count(*)::int n FROM kristine.external_source_chunks WHERE source_version_id=$1',[vid])).rows[0].n!==chunks)throw Error('Reconstructed original mismatch');
 const priorRows=(await c.query('SELECT count(*)::int n FROM kristine.imported_external_dataset_rows WHERE source_version_id=$1',[vid])).rows[0].n;if(priorRows!==0&&priorRows!==expectedRows)throw Error('Incomplete prior projection');
 let batch=[],offset=0,created=0,metadata;
 async function flush(){if(!batch.length)return;const args=[companyId,vid,offset,'['+batch.join(',')+']'];const src='WITH src AS (SELECT value raw,((ordinality-1)+$3::int)::int pos FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY) ';
 if(!priorRows)created+=(await c.query(src+'INSERT INTO kristine.imported_external_dataset_rows(company_id,source_version_id,position,raw_payload) SELECT $1,$2,pos,raw FROM src RETURNING position',args)).rows.length;
 const check=(await c.query(src+'SELECT count(*)::int n,count(*) FILTER(WHERE dst.position IS NULL OR dst.raw_payload IS DISTINCT FROM raw)::int mismatch FROM src LEFT JOIN kristine.imported_external_dataset_rows dst ON dst.company_id=$1 AND dst.source_version_id=$2 AND dst.position=pos',args)).rows[0];if(check.n!==batch.length||check.mismatch)throw Error('Hours typed readback mismatch');offset+=batch.length;batch=[];}
 for await(const r of rowTexts(input)){if(r.metadata){metadata=r.metadata;continue;}batch.push(r.text);if(batch.length===200)await flush();}await flush();
 if(offset!==expectedRows||(await c.query('SELECT count(*)::int n FROM kristine.imported_external_dataset_rows WHERE source_version_id=$1',[vid])).rows[0].n!==expectedRows)throw Error('Hours row count mismatch');
 await c.query('INSERT INTO kristine.external_dataset_runs(company_id,source_instance_id,import_run_id) VALUES($1,$2,$3)',[companyId,sourceInstanceId,runId]);await c.query("INSERT INTO kristine.external_dataset_files(company_id,source_instance_id,import_run_id,source_version_id,source_path,dataset_kind,source_metadata) VALUES($1,$2,$3,$4,$5,'sql_table',$6)",[companyId,sourceInstanceId,runId,vid,SOURCE,metadata]);
 await c.query("UPDATE kristine.import_runs SET status='validated',finished_at=clock_timestamp() WHERE id=$1",[runId]);await c.query('COMMIT');begun=false;return {runId,sourceVersionId:vid,chunksVerified:chunks,originalBytesVerified:bytes,rowsVerified:offset,rowsCreated:created,versionsCreated:prior.length?0:1};
 }catch(e){if(begun)await c.query('ROLLBACK');throw e;}finally{c.release();}
}
module.exports={importLargeHours,rowTexts,originalChunks,SOURCE,KEY};
