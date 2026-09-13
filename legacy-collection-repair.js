"use strict";

const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const REPAIR_ID = "20260913-keckeis-25018";
const SOURCE = "keckeis_gabi_harry";
const TARGET = "25018";

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function atomicJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await fsp.rename(temp, file);
}

async function repairLegacyCollection({ dataDir }) {
  const backup = path.join(dataDir, "_system", "repairs", REPAIR_ID);
  const completedFile = path.join(backup, "completed.json");
  if (await readJson(completedFile, null)) return { status: "already_repaired", sourceJobId: SOURCE, targetJobId: TARGET };
  const targetFile = path.join(dataDir, TARGET, ".meta.json");
  const sourceFile = path.join(dataDir, SOURCE, ".meta.json");
  const target = await readJson(targetFile, null);
  if (!target || !/keckeis/i.test(String(target.name || ""))) return { status: "skipped", reason: "target_not_confirmed" };
  const sourceDir = await fsp.stat(path.join(dataDir, SOURCE)).catch(() => null);
  const previousSource = await readJson(sourceFile, null);
  if (sourceDir && previousSource?.legacyCollectionRepair !== REPAIR_ID) return { status: "skipped", reason: "source_already_exists" };
  for (const entry of await fsp.readdir(dataDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === TARGET || entry.name.startsWith("_")) continue;
    const meta = await readJson(path.join(dataDir, entry.name, ".meta.json"), {});
    if (Array.isArray(meta.collectionMemberJobIds) && meta.collectionMemberJobIds.includes(SOURCE)) return { status: "skipped", reason: "source_has_another_collection" };
  }

  const inboxFile = path.join(dataDir, "_kristine", "photo-inbox.json");
  const reviewFile = path.join(dataDir, "_kristine", "day-review-entries.json");
  const assignmentFile = path.join(dataDir, "_kristine", "media-assignments.json");
  const [inbox, reviews, assignments] = await Promise.all([
    readJson(inboxFile, { items: {} }), readJson(reviewFile, []), readJson(assignmentFile, {}),
  ]);
  if (!inbox?.items || typeof inbox.items !== "object" || Array.isArray(inbox.items) || !Array.isArray(reviews) || !assignments || typeof assignments !== "object" || Array.isArray(assignments)) throw Error("Unexpected photo index format");
  const isFile = async relative => !path.isAbsolute(relative) && !relative.includes("..") && (await fsp.stat(path.join(dataDir, relative)).catch(() => null))?.isFile();
  const files = new Set([...Object.keys(inbox.items), ...reviews.map(row => row.file), ...Object.keys(assignments)].filter(value => typeof value === "string"));
  const moved = new Map();
  let ambiguousFiles = 0;
  for (const file of files) {
    if (!file.startsWith(SOURCE + "/") || !/\.(jpe?g|png|webp|mp4|mov|m4v|avi|webm)$/i.test(file)) continue;
    const destination = TARGET + file.slice(SOURCE.length);
    if (!await isFile(file) && await isFile(destination)) {
      const ext = path.extname(destination), stem = path.basename(destination, ext);
      const siblings = await fsp.readdir(path.dirname(path.join(dataDir, destination)));
      if (siblings.some(name => name.startsWith(stem + "_merged_") && name.endsWith(ext))) { ambiguousFiles++; continue; }
      moved.set(file, destination);
    }
  }
  const sourcePhotos = Object.values(inbox.items).filter(row => row?.jobId === SOURCE && row.status === "confirmed");
  let verifiedPhotos = 0;
  for (const row of sourcePhotos) {
    const file = moved.get(row.file) || row.file;
    if (typeof file === "string" && await isFile(file)) verifiedPhotos++;
  }
  if (!moved.size && !verifiedPhotos) return { status: "skipped", reason: "no_verified_source_photos", sourcePhotoReferences: sourcePhotos.length };

  // Do not overwrite a newer index entry for the destination path.
  for (const [from, to] of moved) {
    if ((inbox.items[from] && inbox.items[to]) || (assignments[from] && assignments[to])) throw Error("Conflicting photo assignment at moved destination");
  }
  const at = new Date().toISOString();
  const rebaseRow = (row, from, to) => ({
    ...row, file: to, originalJobId: TARGET,
    pathHistory: [...(Array.isArray(row.pathHistory) ? row.pathHistory : []), { from, to, originalJobId: row.originalJobId || SOURCE, at, repair: REPAIR_ID }],
  });
  const newInbox = { ...inbox, items: { ...inbox.items } };
  const newAssignments = { ...assignments };
  for (const [from, to] of moved) {
    if (newInbox.items[from]) { newInbox.items[to] = rebaseRow(newInbox.items[from], from, to); delete newInbox.items[from]; }
    if (newAssignments[from]) { newAssignments[to] = rebaseRow(newAssignments[from], from, to); delete newAssignments[from]; }
  }
  const newReviews = reviews.map(row => moved.has(row.file) ? { ...row, file: moved.get(row.file) } : row);
  const sourceName = sourcePhotos.find(row => String(row.jobName || "").trim())?.jobName || "Keckeis Gabi / Harry";
  const source = previousSource || {
    name: String(sourceName), status: target.status || "Auftrag",
    notes: "Zuordnung nach der früheren Zusammenführung mit #25018 wiederhergestellt. Bereits verschobene Bautage und Dokumente liegen in der Hauptakte #25018.",
    legacyCollectionRepair: REPAIR_ID, createdAt: at,
  };
  const newTarget = { ...target, collectionMemberJobIds: [...new Set([...(target.collectionMemberJobIds || []), SOURCE])], updatedAt: at };
  const changes = [[targetFile, newTarget], [sourceFile, source]];
  if (JSON.stringify(inbox) !== JSON.stringify(newInbox)) changes.unshift([inboxFile, newInbox]);
  if (JSON.stringify(reviews) !== JSON.stringify(newReviews)) changes.unshift([reviewFile, newReviews]);
  if (JSON.stringify(assignments) !== JSON.stringify(newAssignments)) changes.unshift([assignmentFile, newAssignments]);
  await fsp.mkdir(backup, { recursive: true });
  for (const [file] of changes) {
    const raw = await fsp.readFile(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (raw !== null) await fsp.writeFile(path.join(backup, path.relative(dataDir, file).replaceAll(path.sep, "__")), raw, { flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
  }
  await atomicJson(path.join(backup, "plan.json"), { sourceJobId: SOURCE, targetJobId: TARGET, at, verifiedPhotos, movedFileReferences: moved.size });
  for (const [file, value] of changes) await atomicJson(file, value);
  const result = { status: "repaired", sourceJobId: SOURCE, targetJobId: TARGET, verifiedPhotos, movedFileReferences: moved.size, ambiguousFiles, at };
  await atomicJson(completedFile, result);
  return result;
}

module.exports = { repairLegacyCollection };
