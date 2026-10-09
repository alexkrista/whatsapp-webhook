'use strict';

const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

// Unique temporary files prevent two same-millisecond writes from renaming
// the same path. Per-call cleanup never removes a concurrent writer's temp.
// This fixes the ENOENT crash, but NOT read-modify-write conflicts: vehicle
// state transitions must still be serialized by their caller or database.
async function writeVehicleJsonAtomic(file, value) {
  if (typeof file !== 'string' || !file) throw new TypeError('file required');
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomUUID();
  try {
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await fsp.rename(tmp, file);
  } finally {
    await fsp.rm(tmp, {force:true}).catch(() => {});
  }
}

module.exports = {writeVehicleJsonAtomic};
