'use strict';
// Read-only preflight. Never prints business payloads or modifies the source.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

async function audit(root) {
  const base = await fs.realpath(root);
  const files = [];
  const skipped = [];
  async function walk(dir) {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(base, full).split(path.sep).join('/');
      if (entry.isSymbolicLink()) { skipped.push({ path: relative, reason: 'symlink' }); continue; }
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile() || !/\.jsonl?$/i.test(entry.name)) continue;
      const handle = await fs.open(full, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        const bytes = await handle.readFile();
        const after = await handle.stat();
        const current = await fs.lstat(full);
        const stable = before.ino === current.ino && before.dev === current.dev && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && after.size === current.size && after.mtimeMs === current.mtimeMs && after.ctimeMs === current.ctimeMs;
        let records = null, shape = null, valid = true;
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (/\.jsonl$/i.test(entry.name)) {
            const lines = text.split(/\r?\n/).filter(line => line.trim());
            for (const line of lines) JSON.parse(line);
            records = lines.length; shape = 'jsonl';
          } else {
            const value = JSON.parse(text);
            shape = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
            records = Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : 1;
          }
        } catch { valid = false; }
        files.push({ path: relative, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), valid, stable, shape, records });
      } finally { await handle.close(); }
    }
  }
  await walk(base);
  return { version: 1, consistentSnapshot: false, ready: files.length > 0 && skipped.length === 0 && files.every(file => file.valid && file.stable), files, skipped };
}

if (require.main === module) {
  const root = process.argv[2];
  if (!root || process.argv.length !== 3) { process.stderr.write('Usage: node sql-migration-audit.js DATA_DIR\n'); process.exitCode = 2; }
  else audit(root).then(report => { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); if (!report.ready) process.exitCode = 1; }).catch(() => { process.stderr.write('Audit failed; no migration performed.\n'); process.exitCode = 1; });
}
module.exports = { audit };
