'use strict';

const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

// Serialize overlapping writes inside this Node process AND use independent
// temporary names between processes. This prevents Linux ENOENT from temp
// collisions and Windows EPERM from concurrent replacement renames.
// Callers still must serialize whole read/modify/write state transitions;
// this is not a replacement for a transactional storage engine.
const tails=new Map();

async function writeVehicleJsonAtomic(file, value) {
  if (typeof file !== 'string' || !file) throw new TypeError('file required');
  const text=JSON.stringify(value,null,2); // Freeze before the async queue.
  const previous=tails.get(file) || Promise.resolve();
  const next=previous.catch(()=>{}).then(async()=>{
    const tmp=file+'.tmp-'+process.pid+'-'+crypto.randomUUID();
    try {
      await fsp.writeFile(tmp,text,'utf8');
      await fsp.rename(tmp,file);
    } finally {
      await fsp.rm(tmp,{force:true}).catch(()=>{});
    }
  });
  tails.set(file,next);
  // Never leave a rejected promise unhandled while removing the queue tail.
  void next.then(
    ()=>{if(tails.get(file)===next)tails.delete(file)},
    ()=>{if(tails.get(file)===next)tails.delete(file)}
  );
  return next;
}
module.exports={writeVehicleJsonAtomic};
