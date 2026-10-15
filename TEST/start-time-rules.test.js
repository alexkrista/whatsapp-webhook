"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {clampStartTime}=require('../morning-status');
const {normalizeTimeEvents,normalizeSegments,normalizeProjectArchive}=require('../start-time-rules');
const base={employeeId:'worker',date:'2026-10-13',jobId:'26101'};
test('agreed morning window: no start before 07:00, inclusive 07:15; 07:16 stays actual',()=>{
 for(const at of ['00:01','06:45','06:59','07:00','07:01','07:08','07:15'])assert.equal(clampStartTime(at),'07:00');
 assert.equal(clampStartTime('07:16'),'07:16');assert.equal(clampStartTime('08:00'),'08:00');
});
test('all entry sources and initial resume are normalized with original stamp retained',()=>{
 for(const source of ['office','kgo','employee_finished_job_afterentry','automatic_worktime'])for(const type of ['start','weiter']){
  const rows=[{...base,type,at:'06:45',source}];const out=normalizeTimeEvents(rows);assert.equal(out[0].at,'07:00');assert.equal(out[0].actualAt,'06:45');assert.equal(rows[0].at,'06:45');
 }
});
test('normalizing a workday preserves genuine later pauses, resumes and site changes',()=>{
 const rows=[['start','06:45'],['pause','07:05'],['weiter','07:10'],['weiter','09:30'],['ende','17:00']].map(([type,at])=>({...base,type,at}));
 assert.deepEqual(normalizeTimeEvents(rows).map(row=>row.at),['07:00','07:05','07:10','09:30','17:00']);
 assert.deepEqual(normalizeTimeEvents(normalizeTimeEvents(rows)),normalizeTimeEvents(rows));
});
test('07:00 minimum also applies to office; actual office starts after 07:00 are preserved',()=>{
 const rows=[{...base,type:'start',at:'06:45'}];assert.equal(normalizeTimeEvents(rows,{worker:{activityMode:'unproductive'}})[0].at,'07:00');
 assert.equal(normalizeTimeEvents([{...rows[0],jobId:'022'}])[0].at,'07:00');assert.equal(normalizeTimeEvents(rows,{worker:{activityMode:'partial'}})[0].at,'07:00');assert.equal(normalizeTimeEvents([{...rows[0],at:'07:08',jobId:'022'}])[0].at,'07:08');
});
test('closed payroll and project months remain exactly frozen',()=>{
 const rows=[{...base,type:'start',at:'06:45'}],closed=[{employeeId:'worker',month:'2026-10'}];assert.deepEqual(normalizeTimeEvents(rows,{},closed),rows);
 const archive=[{employeeId:base.employeeId,date:base.date,segments:[{type:'work',from:'06:45',to:'12:00',jobId:base.jobId}]}];assert.deepEqual(normalizeProjectArchive(archive,{},closed),archive);
 assert.equal(normalizeProjectArchive(archive)[0].segments[0].from,'07:00');
});
test('day-close corrections normalize the first block, retain jobs and record the entered start',()=>{
 const out=normalizeSegments([{type:'work',from:'06:45',to:'12:00',jobId:'A'},{type:'lunch',from:'12:00',to:'12:30'},{type:'work',from:'12:30',to:'17:00',jobId:'B'}],'worker',base.date);
 assert.equal(out[0].from,'07:00');assert.equal(out[0].actualFrom,'06:45');assert.equal(out[0].jobId,'A');assert.equal(out[2].from,'12:30');assert.equal(out[2].jobId,'B');
});
