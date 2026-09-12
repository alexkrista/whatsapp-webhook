const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {listJobMedia,reassignJobMedia,registerMediaMigration}=require('../media-migration');
test('Reassign legacy and KGO photos, serve in target, reject stale selection and undo without touching originals',async t=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'photo-move-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
 const legacy='26091/2026/08/21/1787323140_photo.jpg',central='_kristine/media/2026-08-21/clemens/photo.jpg';
 for(const file of [legacy,central]){await fs.mkdir(path.dirname(path.join(dataDir,file)),{recursive:true});await fs.writeFile(path.join(dataDir,file),'original image')}
 await fs.mkdir(path.join(dataDir,'26080'),{recursive:true});await fs.writeFile(path.join(dataDir,'_kristine/day-review-entries.json'),JSON.stringify([{id:'photo1',jobId:'26091',file:central,date:'2026-08-21',at:'16:39',employeeName:'Clemens Krista'}]));
 assert.equal((await listJobMedia({dataDir,jobId:'26091'})).length,2);
 await reassignJobMedia({dataDir,jobId:'26091',targetJobId:'26080',files:[legacy,central]});
 assert.equal((await listJobMedia({dataDir,jobId:'26091'})).length,0);
 const target=await listJobMedia({dataDir,jobId:'26080'});assert.equal(target.length,2);assert.equal(target.find(x=>x.file===central).employeeName,'Clemens Krista');
 const routes={};registerMediaMigration({get:(p,f)=>routes[p]=f,post:()=>{}},{dataDir,requireAdmin:()=>true});
 for(const jobId of ['26080','26091']){const res={statusCode:200,status(c){this.statusCode=c;return this},send(){},setHeader(){},sendFile(file){this.file=file}};await routes['/admin/api/job/:jobId/media-file']({params:{jobId},query:{file:legacy}},res);assert.equal(res.statusCode,jobId==='26080'?200:404)}
 await assert.rejects(reassignJobMedia({dataDir,jobId:'26091',targetJobId:'26080',files:[central]}));
 await assert.rejects(reassignJobMedia({dataDir,jobId:'26080',targetJobId:'../bad',files:[central]}));
 await reassignJobMedia({dataDir,jobId:'26080',targetJobId:'26091',files:[legacy,central]});
 assert.equal((await listJobMedia({dataDir,jobId:'26091'})).length,2);assert.equal((await listJobMedia({dataDir,jobId:'26080'})).length,0);
 for(const file of [legacy,central])assert.equal(await fs.readFile(path.join(dataDir,file),'utf8'),'original image');
});
