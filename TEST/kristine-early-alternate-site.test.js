const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const { bookedAssignment } = require("../morning-status");

const planned = { jobId: "PLAN", jobName: "Planbaustelle" };
const time = {
  state: "working",
  events: [
    { type: "start", at: "07:00", actualAt: "06:42", jobId: "IST", jobName: "Andere Baustelle" },
  ],
};

assert.deepEqual(bookedAssignment(time), {
  jobId: "IST",
  jobName: "Andere Baustelle",
  siteCode: "",
});
assert.notEqual(bookedAssignment(time).jobId, planned.jobId);

const office = fs.readFileSync(path.join(root, "public", "kristine.html"), "utf8");
const employee = fs.readFileSync(path.join(root, "public", "kristine-go.js"), "utf8");
assert.match(office, /const siteName=bookedJob\?\.jobName\|\|selectedJob\?\.jobName\|\|currentPlan\?\.jobName/);
assert.match(employee, /activeJobOverride\?\.date === state\.bootstrap\?\.today/);

console.log("OK: Früher Start auf anderer Baustelle bleibt in Status und Anzeigen erhalten.");
