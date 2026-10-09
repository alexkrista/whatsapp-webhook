'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {writeVehicleJsonAtomic}=require('../vehicle-json-atomic');

test('simultaneous same-millisecond vehicle state saves cannot steal each others temp files',async t=>{
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'krista-vehicle-collision-'));
  t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'sessions.json');
  const priorNow=Date.now;
  Date.now=()=>1791396126358;
  try{
    await Promise.all(Array.from({length:120},(_,n)=>
      writeVehicleJsonAtomic(file,{test:true,seq:n,vehicles:{A:{id:'A',driver:null}}})));
  }finally{Date.now=priorNow}
  const value=JSON.parse(await fsp.readFile(file,'utf8'));
  assert.equal(value.test,true);
  assert.ok(Number.isSafeInteger(value.seq)&&value.seq>=0&&value.seq<120);
  assert.deepEqual(value.vehicles,{A:{id:'A',driver:null}});
  assert.deepEqual((await fsp.readdir(dir)).filter(n=>n.startsWith('sessions.json.tmp-')),[]);
});

test('failed vehicle writes never erase the existing source file',async t=>{
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'krista-vehicle-write-'));
  t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'sessions.json');
  await writeVehicleJsonAtomic(file,{safe:'before'});
  await assert.rejects(writeVehicleJsonAtomic(file,{unsafe:12n}),/serialize a BigInt/);
  assert.deepEqual(JSON.parse(await fsp.readFile(file,'utf8')),{safe:'before'});
  assert.deepEqual((await fsp.readdir(dir)).filter(n=>n.includes('.tmp-')),[]);
});
