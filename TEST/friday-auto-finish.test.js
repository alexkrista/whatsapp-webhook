"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {automaticFinishWindow,registerMorningStatus}=require('../morning-status');
test('Friday schedule is 14:15; other days retain their existing finish window',()=>{
 assert.deepEqual(automaticFinishWindow('2026-10-16'),{from:'14:15',to:'14:44'});assert.deepEqual(automaticFinishWindow('2026-10-15'),{from:'17:00',to:'17:29'});assert.deepEqual(automaticFinishWindow('2026-10-19'),{from:'17:00',to:'17:29'});
});
test('Friday books 14:15 and says 14:15; midday, resume and Thursday finish remain unchanged',async t=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'friday-finish-')),root=path.join(dataDir,'_kristine');await fs.mkdir(root);t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
 const employees=[{id:'worker',name:'Production Worker',phone:'0664000000',active:true,activityMode:'productive'}],messages=[];
 const days=['2026-10-15','2026-10-16'];await fs.writeFile(path.join(root,'time-events.json'),JSON.stringify(days.map(date=>({employeeId:'worker',date,type:'start',at:'07:00',jobId:'A'}))));
 const service=await registerMorningStatus({dataDir,readEmployees:async()=>employees,sendWhatsApp:async message=>messages.push(message),logger:{log(){},warn(){},error(){}},phoneNumberId:'test'});
 for(const date of days){assert.equal((await service.runWorktimePrompt('lunch',date,true)).booked,1);assert.equal((await service.runWorktimePrompt('resume',date,true)).booked,1);assert.equal((await service.runWorktimePrompt('finish',date,true)).booked,1)}
 const events=JSON.parse(await fs.readFile(path.join(root,'time-events.json'),'utf8'));
 assert.equal(events.find(row=>row.date===days[0]&&row.type==='ende').at,'17:00');assert.equal(events.find(row=>row.date===days[1]&&row.type==='ende').at,'14:15');
 assert.equal(events.filter(row=>row.type==='mittag'&&row.at==='12:00').length,2);assert.equal(events.filter(row=>row.type==='weiter'&&row.at==='12:30').length,2);assert.match(messages.at(-1).reply,/14:15/);assert.deepEqual(messages.at(-1).buttons,['Nein']);
 assert.equal((await service.runWorktimePrompt('finish',days[1])).skipped,true);
});
