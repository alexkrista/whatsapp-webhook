const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {registerMediaMigration}=require('../media-migration');
test('Photo sharing validates assignment and email before mocked mail, compresses without changing original',async t=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'photo-share-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
 const file='_kristine/media/2026-09-12/clemens/photo.png',content=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=','base64');
 await fs.mkdir(path.dirname(path.join(dataDir,file)),{recursive:true});await fs.writeFile(path.join(dataDir,file),content);await fs.writeFile(path.join(dataDir,'_kristine/day-review-entries.json'),JSON.stringify([{id:'p1',jobId:'26080',date:'2026-09-12',file}]));
 const routes={};let mail=null,authorized=true;registerMediaMigration({get:(p,f)=>routes[p]=f,post:(p,...handlers)=>routes[p]=handlers.at(-1)},{dataDir,requireAdmin:(_q,res)=>{if(!authorized)res.status(403).json({});return authorized},sendPhotoMail:async input=>{mail=input}});
 const call=async(body,jobId='26080')=>{const res={statusCode:200,status(c){this.statusCode=c;return this},json(b){this.body=b}};await routes['/admin/api/job/:jobId/media/email']({params:{jobId},body},res);return res};
 const body={files:[file],to:'kunde@example.test',subject:'Baustellenfotos',text:'Fotos anbei'};
 assert.equal((await call({...body,to:'bad'})).statusCode,400);assert.equal(mail,null);
 assert.equal((await call(body,'26091')).statusCode,400);assert.equal(mail,null);
 assert.equal((await call({...body,files:['../../secret']})).statusCode,400);assert.equal(mail,null);
 assert.equal((await call(body)).statusCode,200);assert.equal(mail.attachments.length,1);assert.equal(mail.to,body.to);assert(mail.attachments[0].content.length>0);
 assert.deepEqual(await fs.readFile(path.join(dataDir,file)),content);
 authorized=false;mail=null;assert.equal((await call(body)).statusCode,403);assert.equal(mail,null);
});
