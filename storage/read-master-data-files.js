'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {prepareMasterData}=require('./import-master-data');

// Explicit paths, no directory scanning or writes to source files.
async function readMasterDataFiles({employeesFile,projects=[]}){
 const records=[],originalFiles=[];
 async function read(file){
  const bytes=await fs.readFile(file);
  const text=bytes.toString('utf8');
  if(!Buffer.from(text,'utf8').equals(bytes))throw new Error('Source must be valid UTF-8');
  originalFiles.push({path:path.resolve(file),text,sha256:createHash('sha256').update(bytes).digest('hex')});
  return JSON.parse(text);
 }
 if(employeesFile){
  const rows=await read(employeesFile);
  if(!Array.isArray(rows))throw new Error('employees.json must contain an array');
  for(const row of rows)records.push({entityType:'employee',externalId:row.id,originalText:JSON.stringify(row)});
 }
 for(const project of projects){
  if(typeof project.jobId!=='string'||!project.jobId.trim())throw new Error('Explicit project jobId required');
  const raw=await read(project.metaFile);
  if(!raw||Array.isArray(raw)||typeof raw!=='object')throw new Error('Project metadata must be an object');
  if(raw.jobId!==undefined&&raw.jobId!==project.jobId)throw new Error('Project path/metadata ID mismatch');
  records.push({entityType:'project',externalId:project.jobId,originalText:JSON.stringify({...raw,jobId:project.jobId})});
 }
 prepareMasterData(records);
 // Caller must archive originalFiles before importing records. Contains personal data.
 return {records,originalFiles};
}
module.exports={readMasterDataFiles};
