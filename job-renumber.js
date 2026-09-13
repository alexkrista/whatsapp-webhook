"use strict";

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const MIGRATION = "20260913-jansen-next-number-v1";
const SOURCE_ID = "2606109";
const ID_FIELDS = new Set(["jobId", "mainJobId", "sourceJobId", "targetJobId", "currentJobId", "assignedJobId", "lastJobId", "previousJobId", "collectionMainJobId", "protocolSite"]);
const ID_LISTS = new Set(["jobIds", "memberJobIds", "collectionMemberJobIds", "includedJobIds", "collectionMainMemberJobIds"]);
const json = value => JSON.stringify(value, null, 2) + "\n";
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const exists = file => { try { return fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
function read(file, fallback = null) { return exists(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
function atomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + "." + crypto.randomUUID() + ".tmp";
  try { fs.writeFileSync(temp, contents); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
function regularNextNumber(names, prefix = "26") {
  if (!/^\d{2}$/.test(prefix)) throw new Error("Invalid year prefix");
  const used = names.filter(id => new RegExp(`^${prefix}\\d{3}$`).test(id)).map(Number);
  const next = Math.max(Number(prefix + "000"), ...used) + 1;
  if (!String(next).startsWith(prefix) || String(next).length !== 5) throw new Error("Nummernkreis ist voll.");
  return String(next);
}
function rewriteReferences(value, oldId, newId, field = "") {
  if (typeof value === "string") return value === oldId && (ID_FIELDS.has(field) || ID_LISTS.has(field)) ? newId : value;
  if (Array.isArray(value)) return value.map(row => rewriteReferences(row, oldId, newId, field));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, row]) => [key, rewriteReferences(row, oldId, newId, key)]));
}
function filesUnder(root, skip = () => false, relative = "") {
  const rows = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const rel = path.join(relative, entry.name);
    if (skip(rel)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) rows.push(...filesUnder(root, skip, rel));
    else if (entry.isFile()) rows.push(rel);
  }
  return rows;
}
function createAliasResolver(dataDir) {
  const record = read(path.join(dataDir, "_system/job-number-aliases.json"), {}), aliases = record.aliases || {};
  const canonical = id => String(aliases[String(id)] || id || "");
  // Existing media keys and signed URLs retain their original path. Only the
  // files present during the move are aliases; later uploads use the new ID.
  const stableFile = file => record.files?.[file] || file;
  return { aliases, canonical, stableFile, isAlias: id => Object.hasOwn(aliases, String(id)) };
}

// This one-off operation is authorized for Jansen only and runs before the
// server accepts requests. Physical files are kept; the old path remains a
// symlink so stored/signed document URLs still refer to exactly the same data.
function renumberJansen({ dataDir, checkpoint = () => {} }) {
  const repair = path.join(dataDir, "_system/repairs", MIGRATION), planPath = path.join(repair, "plan.json"), donePath = path.join(repair, "completed.json");
  const completed = read(donePath);
  if (completed) return { ...completed, status: "already_renumbered" };
  if (!exists(dataDir)) return { status: "source_missing", oldJobId: SOURCE_ID };
  let plan = read(planPath);
  if (!plan) {
    const oldDir = path.join(dataDir, SOURCE_ID), stat = exists(oldDir);
    if (!stat) return { status: "source_missing", oldJobId: SOURCE_ID };
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { status: "blocked", reason: "Source is not an independent file", oldJobId: SOURCE_ID };
    const meta = read(path.join(oldDir, ".meta.json"), {});
    if (!/\bjansen\b/i.test(String(meta.name || ""))) return { status: "blocked", reason: "Customer identity does not match", oldJobId: SOURCE_ID };
    const collections = read(path.join(dataDir, "_system/sammelmappen.json"), { collections: {} });
    if (Object.values(collections.collections || {}).some(row => row.active !== false && (row.mainJobId === SOURCE_ID || row.memberJobIds?.includes(SOURCE_ID))) || meta.collectionMemberJobIds?.length) return { status: "blocked", reason: "Source is part of a collection", oldJobId: SOURCE_ID };
    const aliasesPath = path.join(dataDir, "_system/job-number-aliases.json"), oldAliases = read(aliasesPath, { version: 1, aliases: {} });
    const newId = regularNextNumber([...fs.readdirSync(dataDir), ...Object.keys(oldAliases.aliases || {}), ...Object.values(oldAliases.aliases || {})]);
    const at = new Date().toISOString(), changes = [], manifest = [];
    const skip = rel => /^_system\/(repairs|ww-cache|collection-views)(\/|$)/.test(rel.replaceAll(path.sep, "/")) || /(^|\/)(backups|_trash|_deleted)(\/|$)/.test(rel.replaceAll(path.sep, "/"));
    const record = (file, after) => {
      const before = exists(path.join(dataDir, file)) ? fs.readFileSync(path.join(dataDir, file)) : null;
      if (before && before.equals(Buffer.from(after))) return;
      changes.push({ file, beforeHash: before ? sha(before) : null, afterHash: sha(after), after });
    };
    for (const rel of filesUnder(oldDir)) {
      const contents = fs.readFileSync(path.join(oldDir, rel));
      manifest.push({ file: rel, hash: sha(contents), bytes: contents.length });
    }
    for (const file of filesUnder(dataDir, skip)) {
      if (!/\.(json|jsonl)$/.test(file) || file === `${SOURCE_ID}/.meta.json` || file === "_system/job-number-aliases.json") continue;
      const before = fs.readFileSync(path.join(dataDir, file), "utf8");
      if (!before.includes(SOURCE_ID)) continue;
      let after;
      if (file.endsWith(".jsonl")) {
        after = before.split("\n").map(line => {
          if (!line.trim() || !line.includes(SOURCE_ID)) return line;
          const parsed = JSON.parse(line), rewritten = rewriteReferences(parsed, SOURCE_ID, newId);
          return JSON.stringify(parsed) === JSON.stringify(rewritten) ? line : JSON.stringify(rewritten);
        }).join("\n");
      } else {
        const parsed = JSON.parse(before), rewritten = rewriteReferences(parsed, SOURCE_ID, newId);
        after = JSON.stringify(parsed) === JSON.stringify(rewritten) ? before : json(rewritten);
      }
      if (after !== before) record(file, after);
    }
    record(`${SOURCE_ID}/.meta.json`, json({ ...meta, previousJobIds: [...new Set([...(meta.previousJobIds || []), SOURCE_ID])], wwProjectNumber: meta.wwProjectNumber || SOURCE_ID, renumberedAt: at }));
    record("_system/job-number-aliases.json", json({ ...oldAliases, aliases: { ...oldAliases.aliases, [SOURCE_ID]: newId }, files: { ...oldAliases.files, ...Object.fromEntries(manifest.map(row => [`${newId}/${row.file}`, `${SOURCE_ID}/${row.file}`])) } }));
    const historyFile = `${SOURCE_ID}/.history.jsonl`, existingHistoryChange = changes.find(row => row.file === historyFile);
    const historyBefore = existingHistoryChange?.after ?? (exists(path.join(dataDir, historyFile)) ? fs.readFileSync(path.join(dataDir, historyFile), "utf8") : "");
    const historyAfter = historyBefore + (historyBefore && !historyBefore.endsWith("\n") ? "\n" : "") + JSON.stringify({ at, type: "job_renumbered", title: `Baustellennummer ${SOURCE_ID} → ${newId}`, source: "admin", data: { oldJobId: SOURCE_ID, newJobId: newId, reason: "Nächste freie reguläre KRISTINE-Baustellennummer auf Benutzerwunsch" } }) + "\n";
    if (existingHistoryChange) changes.splice(changes.indexOf(existingHistoryChange), 1);
    record(historyFile, historyAfter);
    plan = { version: 1, oldJobId: SOURCE_ID, newJobId: newId, at, manifest, changes };
    // Back up every original project file and every external reference before
    // publishing the plan. Incomplete backup preparation never starts a move.
    for (const row of manifest) {
      const target = path.join(repair, "source", row.file); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(oldDir, row.file), target);
      if (sha(fs.readFileSync(target)) !== row.hash) throw new Error("Project backup verification failed");
    }
    for (const change of changes) if (change.beforeHash !== null) {
      const target = path.join(repair, "references", change.file); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(dataDir, change.file), target);
      if (sha(fs.readFileSync(target)) !== change.beforeHash) throw new Error("Reference backup verification failed");
    }
    atomic(planPath, json(plan)); checkpoint("prepared");
  }
  const oldDir = path.join(dataDir, plan.oldJobId), newDir = path.join(dataDir, plan.newJobId);
  const oldStat = exists(oldDir), newStat = exists(newDir);
  if (oldStat?.isDirectory() && newStat) throw new Error("Zielnummer inzwischen belegt; keine Daten überschrieben.");
  if (oldStat?.isSymbolicLink() && fs.realpathSync(oldDir) !== path.resolve(newDir)) throw new Error("Unexpected old-number link");
  if (!oldStat && !newStat) throw new Error("Project directory missing");
  const moved = !oldStat?.isDirectory();
  const currentPath = file => path.join(dataDir, moved && file.startsWith(plan.oldJobId + "/") ? plan.newJobId + file.slice(plan.oldJobId.length) : file);
  // Validate the entire journal before any write, including a resumed run.
  for (const change of plan.changes) {
    const file = currentPath(change.file), hash = exists(file) ? sha(fs.readFileSync(file)) : null;
    if (hash !== change.beforeHash && hash !== change.afterHash) throw new Error("A file changed after the renumbering plan; stopped without overwriting it.");
  }
  for (const row of plan.manifest) {
    const file = path.join(moved ? newDir : oldDir, row.file), hash = sha(fs.readFileSync(file));
    const change = plan.changes.find(change => change.file === plan.oldJobId + "/" + row.file);
    if (hash !== row.hash && hash !== change?.afterHash) throw new Error("Project file changed after backup; stopped.");
  }
  if (!moved) { fs.renameSync(oldDir, newDir); checkpoint("moved"); }
  for (const change of plan.changes) {
    const file = path.join(dataDir, change.file.startsWith(plan.oldJobId + "/") ? plan.newJobId + change.file.slice(plan.oldJobId.length) : change.file);
    if (!exists(file) || sha(fs.readFileSync(file)) !== change.afterHash) atomic(file, change.after);
  }
  checkpoint("references_updated");
  if (!exists(oldDir)) fs.symlinkSync(plan.newJobId, oldDir, "dir");
  for (const row of plan.manifest) {
    const expected = plan.changes.find(change => change.file === plan.oldJobId + "/" + row.file)?.afterHash || row.hash;
    if (sha(fs.readFileSync(path.join(newDir, row.file))) !== expected) throw new Error("Renumbered project verification failed");
  }
  const calc = read(path.join(newDir, ".order-calculation.json"), {});
  const result = { status: "renumbered", oldJobId: plan.oldJobId, newJobId: plan.newJobId, at: plan.at, filesVerified: plan.manifest.length, referenceFilesUpdated: plan.changes.filter(row => !row.file.startsWith(plan.oldJobId + "/")).length, calculationPositions: calc.positions?.length || 0, netTotal: calc.netTotal || 0 };
  atomic(donePath, json(result)); return result;
}
module.exports = { MIGRATION, SOURCE_ID, regularNextNumber, rewriteReferences, createAliasResolver, renumberJansen };
