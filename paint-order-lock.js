"use strict";
// Serialize invoice receipt and sent-order changes for the same data directory.
const queues = new Map();
function withOrderLock(root, fn) {
  const next = (queues.get(root) || Promise.resolve()).then(fn);
  const settled = next.catch(() => {});
  queues.set(root, settled);
  settled.then(() => { if (queues.get(root) === settled) queues.delete(root); });
  return next;
}
module.exports = { withOrderLock };
