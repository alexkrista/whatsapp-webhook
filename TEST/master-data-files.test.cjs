'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {readMasterDataFiles}=require('../storage/read-master-data-files');
test('file adapter retains original files, leading zeros and explicit project identity',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'master-import-'));
 try{
  const employeesFile=path.join(dir,'employees.json'),metaFile=path.join(dir,'meta.json');
  const original='[\n {"id":"001","name":"Test","finkzeitPersonalNumber":"0026"}\n]\n';
  await fs.writeFile(employeesFile,original);await fs.writeFile(metaFile,'{"name":"Project","status":"Auftrag"}');
  const bundle=await readMasterDataFiles({employeesFile,projects:[{jobId:'023',metaFile}]});
  assert.equal(bundle.originalFiles[0].text,original);
  assert.equal(bundle.records[0].externalId,'001');
  assert.equal(JSON.parse(bundle.records[0].originalText).finkzeitPersonalNumber,'0026');
  assert.equal(bundle.records[1].externalId,'023');
  assert.equal(await fs.readFile(employeesFile,'utf8'),original);
  await fs.writeFile(metaFile,'{"jobId":"999","name":"Project","status":"Auftrag"}');
  await assert.rejects(readMasterDataFiles({projects:[{jobId:'023',metaFile}]}),/mismatch/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
