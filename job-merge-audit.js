"use strict";

const fsp = require("fs/promises");
const path = require("path");

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

// Read-only evidence for a reported legacy merge. No files or assignments are changed.
async function auditJobMerge({ dataDir, sourceJobId, targetJobId }) {
  if (![sourceJobId, targetJobId].every(id => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id))) throw Error("Invalid job ID");
  const exists = async relative => (await fsp.stat(path.join(dataDir, relative)).catch(() => null)) !== null;
  const root = path.join(dataDir, "_kristine");
  const [meta, reviews, inbox, assignments, timeEvents, archive] = await Promise.all([
    readJson(path.join(dataDir, targetJobId, ".meta.json"), {}),
    readJson(path.join(root, "day-review-entries.json"), []),
    readJson(path.join(root, "photo-inbox.json"), {}),
    readJson(path.join(root, "media-assignments.json"), {}),
    readJson(path.join(root, "time-events.json"), []),
    readJson(path.join(root, "project-time-archive.json"), []),
  ]);
  const sourceReviews = reviews.filter(row => row.jobId === sourceJobId);
  const files = [...new Set(sourceReviews.map(row => String(row.file || "").replace(/\\/g, "/")).filter(Boolean))];
  let centralFiles = 0, movedLegacyFiles = 0, missingFiles = 0;
  for (const file of files) {
    if (file.includes("..") || path.isAbsolute(file)) continue;
    if (file.startsWith("_kristine/media/") && await exists(file)) centralFiles++;
    else if (file.startsWith(sourceJobId + "/") && await exists(targetJobId + file.slice(sourceJobId.length))) movedLegacyFiles++;
    else if (!await exists(file)) missingFiles++;
  }
  const inboxRows = Object.values(inbox.items || {}).filter(row => [row.jobId, row.previousJobId, row.originalJobId].includes(sourceJobId));
  const sourceArchive = archive.flatMap(row => row.segments || []).filter(row => row.jobId === sourceJobId);
  const docs = await fsp.readdir(path.join(dataDir, targetJobId, "_documentation")).catch(() => []);
  return {
    sourceJobId, targetJobId,
    sourceExists: await exists(sourceJobId), targetExists: await exists(targetJobId),
    targetName: String(meta.name || ""), targetMembers: meta.collectionMemberJobIds || [],
    sourceNames: [...new Set(sourceReviews.map(row => String(row.jobName || "")).filter(Boolean))].slice(0, 4),
    sourceReviews: sourceReviews.length, centralFiles, movedLegacyFiles, missingFiles,
    sourceInbox: inboxRows.reduce((counts, row) => { const key = row.status || "unknown"; counts[key] = (counts[key] || 0) + 1; return counts; }, {}),
    sourceMediaAssignments: Object.values(assignments).filter(row => row.jobId === sourceJobId).length,
    sourceTimeEvents: timeEvents.filter(row => row.jobId === sourceJobId).length,
    sourceArchivedSegments: sourceArchive.length,
    mergedDocumentIndexes: docs.filter(name => /^index_merged_\d+\.json$/.test(name)).length,
  };
}

module.exports = { auditJobMerge };
