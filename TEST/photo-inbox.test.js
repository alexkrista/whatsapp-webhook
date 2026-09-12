const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createPhotoInbox,suggestJob}=require('../photo-inbox');const {listJobMedia}=require('../media-migration');
test('Stamp suggestions stop after checkout and handle changes and ambiguous events',()=>{
 const photo={employeeId:'e1',date:'2026-09-12',at:'10:00'},event=(at,type,jobId)=>({employeeId:'e1',date:photo.date,at,type,jobId});
 assert.equal(suggestJob(photo,[event('07:00','start','26080')]).jobId,'26080');
 assert.equal(suggestJob(photo,[event('07:00','start','26080'),event('09:00','stop','26080')]).jobId,'');
 assert.equal(suggestJob(photo,[event('07:00','start','26080'),event('09:00','weiter','26091')]).jobId,'26091');
 assert.equal(suggestJob(photo,[event('09:00','start','26080'),event('09:00','start','26091')]).jobId,'');
});
test('Photo inbox preserves existing assignments, groups new photos, confirms atomically, closes and reopens one task',async t=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'photo-inbox-'));t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));const root=path.join(dataDir,'_kristine');await fs.mkdir(root,{recursive:true});for(const job of ['26080','26091'])await fs.mkdir(path.join(dataDir,job));
 const reviewsFile=path.join(root,'day-review-entries.json'),writeReviews=rows=>fs.writeFile(reviewsFile,JSON.stringify(rows));
 const original={id:'old',file:'_kristine/media/old.jpg',employeeId:'e1',employeeName:'Clemens',date:'2026-09-11',at:'10:00',category:'photo',jobId:'26080',createdAt:'2026-09-11T08:00:00Z'};await fs.mkdir(path.join(root,'media'));await fs.writeFile(path.join(dataDir,original.file),'image');await writeReviews([original]);
 const inbox=createPhotoInbox(dataDir);assert.equal(Object.keys((await inbox.sync()).items).length,0);
 const events=[{employeeId:'e1',date:'2026-09-12',at:'07:00',type:'start',jobId:'26080'},{employeeId:'e1',date:'2026-09-12',at:'11:00',type:'stop',jobId:'26080'}];await fs.writeFile(path.join(root,'time-events.json'),JSON.stringify(events));
 const photo=i=>({...original,id:'p'+i,file:'_kristine/media/p'+i+'.jpg',date:'2026-09-12',createdAt:new Date().toISOString(),at:i===2?'12:00':'10:00'});
 const photos=[photo(1),photo(2)];for(const row of photos)await fs.writeFile(path.join(dataDir,row.file),'image');await writeReviews([original,...photos]);
 let state=await inbox.sync();assert.equal(Object.keys(state.items).length,2);assert.equal(state.items[photos[0].file].suggestion.jobId,'26080');assert.equal(state.items[photos[1].file].suggestion.jobId,'');
 assert.equal((await listJobMedia({dataDir,jobId:'26080'})).length,1);
 const tasks=()=>fs.readFile(path.join(root,'tasks.json'),'utf8').then(JSON.parse);assert.equal((await tasks()).length,1);await inbox.sync();assert.equal((await tasks()).length,1);
 await assert.rejects(inbox.confirm([{file:photos[0].file,jobId:'26091'},{file:photos[1].file,jobId:'missing'}]));assert.equal((await inbox.sync()).items[photos[0].file].status,'pending');
 await inbox.confirm(photos.map(row=>({file:row.file,jobId:'26091'})));assert.equal((await tasks())[0].status,'done');assert.equal((await listJobMedia({dataDir,jobId:'26091'})).length,2);assert.equal((await listJobMedia({dataDir,jobId:'26080'})).length,1);
 await inbox.confirm(photos.map(row=>({file:row.file,jobId:'26091'})));assert.equal((await tasks()).length,1);
 const extra=photo(3);await fs.writeFile(path.join(dataDir,extra.file),'image');const current=JSON.parse(await fs.readFile(reviewsFile));await writeReviews([...current,extra]);await inbox.sync();assert.equal((await tasks()).length,1);assert.equal((await tasks())[0].status,'open');
 assert.equal((await listJobMedia({dataDir,jobId:'26091'})).length,2);
});
