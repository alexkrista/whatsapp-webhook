"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const D = require("./public/ui/baustellen-data");
const H = require("./public/ui/baustellen-hours-core");

function createBaustellenHoursService({ dataDir, readBootstrap, now = () => new Date() }) {
  let lastKey = "", lastSnapshot = null;
  return async function attachHours(payload) {
    const jobs = D.catalog(payload);
    const bootstrap = await readBootstrap();
    const references = D.projects({kind:"collection",collectionMemberJobIds:jobs.filter(row=>!D.isCollection(row)).map(row=>row.jobId)}, jobs);
    const wwByMember = new Map(), snapshots = [];
    for (const reference of references) {
      const file = path.join(dataDir, "_system", "ww-cache", "hours", `${reference.projectNumber}.json`);
      let snapshot;
      try { snapshot = JSON.parse(await fs.readFile(file, "utf8")); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      snapshots.push({reference,snapshot});
    }
    const at = now();
    const inputs=jobs.map(({jobId,kind,status,calculation,collectionParentJobIds,collectionMemberJobIds,collectionSummary,wwProjectNumber,wwProjectLinks,hoursCutoverDate,hoursOverlapExcludedWwKeys,hoursOverlapResolvedAt})=>({jobId,kind,status,calculation,collectionParentJobIds,collectionMemberJobIds,memberIds:collectionSummary?.jobIds,wwProjectNumber,wwProjectLinks,hoursCutoverDate,hoursOverlapExcludedWwKeys,hoursOverlapResolvedAt}));
    const key = createHash("sha256").update(JSON.stringify({jobs:inputs,bootstrap,snapshots,minute:Math.floor(at.getTime()/60000)})).digest("hex");
    if (key !== lastKey) {
      for (const job of jobs) {
        const found = snapshots.filter(row=>row.reference.jobId===String(job.jobId)).map(({reference,snapshot})=>({number:reference.projectNumber,data:H.parseWwHours({hours:snapshot.data,cached:true,syncedAt:snapshot.syncedAt},reference.projectNumber)}));
        wwByMember.set(String(job.jobId), H.combineWw(found));
      }
      lastSnapshot = H.createEngine({jobs,bootstrap,wwByMember,now:at}).snapshot();
      lastSnapshot.missingProjects = references.filter(ref=>!snapshots.some(row=>row.reference.projectNumber===ref.projectNumber)).map(ref=>ref.projectNumber);
      lastKey = key;
    }
    return {...payload,baustellenHours:lastSnapshot};
  };
}

module.exports = { createBaustellenHoursService };
