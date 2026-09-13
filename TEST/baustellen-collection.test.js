"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "public/ui/baustellen-collection.js"), "utf8");
const page = fs.readFileSync(path.join(root, "public/baustellen.html"), "utf8");
const topbar = fs.readFileSync(path.join(root, "public/ui/topbar.js"), "utf8");
const entry = "window.BaustellenCollections={version:VERSION,refresh};";
assert.ok(source.includes(entry));

// Exercise the actual private functions without adding a production test API.
const locationUrl = new URL("https://example.invalid/kristine/baustellen?token=test-token&view=all#26001");
const context = {
  URL, URLSearchParams,
  location: {
    get href() { return locationUrl.href; },
    set href(value) { locationUrl.href = new URL(value, locationUrl).href; },
    get hash() { return locationUrl.hash; },
    get search() { return locationUrl.search; },
    get origin() { return locationUrl.origin; },
    get searchParams() { return locationUrl.searchParams; },
  },
  document: { readyState: "loading", addEventListener() {} },
  window: {},
};
vm.runInNewContext(source.replace(entry,
  "window.BaustellenCollections={setJobs,groupsFor,groupCount,groupLabel,groupMarkup,jobUrl,openJob};"), context);
const collections = context.window.BaustellenCollections;
const ids = group => Array.from(group.members, job => String(job.jobId));
const jobs = [
  { jobId: "26001", name: "Testgebäude", collectionMemberJobIds: ["26002", "26003", "26004"],
    collectionSummary: { count: 4, jobIds: ["26001", "26002", "26003", "26004"] } },
  { jobId: "26002", name: "Fassade", collectionParentJobIds: ["26001"] },
  { jobId: "26003", name: "Bad", collectionParentJobIds: ["26001"] },
  { jobId: "26004", name: "Wohnung", collectionParentJobIds: ["26001"] },
  { jobId: "27001", name: "Testgebäude" }, // A similar name is not a link.
];
collections.setJobs(jobs);
for (const job of jobs.slice(0, 4)) {
  const groups = collections.groupsFor(job.jobId);
  assert.equal(groups.length, 1);
  assert.deepEqual(ids(groups[0]), ["26001", "26002", "26003", "26004"]);
  assert.equal(collections.groupLabel(groups), "Vereint · 4 Baustellen");
  const markup = collections.groupMarkup(groups, job.jobId);
  assert.equal((markup.match(/aria-current="page"/g) || []).length, 1);
  assert.match(markup, new RegExp(`data-collection-link="${job.jobId}" aria-current="page"`));
  assert.equal((markup.match(/class="collection-member"/g) || []).length, 4);
  assert.match(markup, /Aktuell geöffnet/);
  assert.match(markup, /href="\/kristine\/baustellen\?token=test-token&amp;view=all#26002"/);
}
assert.equal(collections.groupsFor("27001").length, 0);
assert.equal(collections.groupsFor("unknown").length, 0);

// Older metadata, duplicate IDs and stale counts must not hide or inflate members.
collections.setJobs([
  { jobId: 26001, collectionMemberJobIds: [26002, "26002", "missing"],
    collectionSummary: { count: 99, jobIds: ["26002", "26002", "26001"] } },
  { jobId: "26002", name: "Teilakte ohne Parent-Feld" },
]);
assert.deepEqual(ids(collections.groupsFor("26002")[0]), ["26001", "26002"]);
assert.equal(collections.groupLabel(collections.groupsFor(26001)), "Vereint · 2 Baustellen");

collections.setJobs([{ jobId: "26001", collectionMemberJobIds: ["missing"] }]);
assert.equal(collections.groupsFor("26001").length, 0);
collections.setJobs(jobs.map(({ collectionMemberJobIds, collectionSummary, collectionParentJobIds, ...job }) => job));
assert.equal(collections.groupsFor("26001").length, 0, "dissolving removes stale memberships");

// Preserve all explicit groups in legacy data, without duplicate counting.
collections.setJobs([
  { jobId: "a", name: "A", collectionMemberJobIds: ["shared"] },
  { jobId: "b", name: "B", collectionMemberJobIds: ["shared"] },
  { jobId: "shared" },
]);
assert.equal(collections.groupsFor("shared").length, 2);
assert.equal(collections.groupCount(collections.groupsFor("shared")), 3);

collections.setJobs([
  { jobId: "a", collectionMemberJobIds: ['legacy & "id"'] },
  { jobId: 'legacy & "id"', name: '<img src=x onerror="alert(1)"> & Test' },
]);
const escaped = collections.groupMarkup(collections.groupsFor("a"), "a");
assert.ok(!escaped.includes("<img"));
assert.match(escaped, /&lt;img/);
assert.match(escaped, /legacy &amp; &quot;id&quot;/);
assert.equal(collections.jobUrl('legacy & "id"'),
  "/kristine/baustellen?token=test-token&view=all#legacy%20%26%20%22id%22");
let reloads = 0;
context.location.reload = () => { reloads++; };
collections.openJob("26001");
assert.equal(reloads, 0, "current project link is a no-op");
collections.openJob("26002");
assert.equal(reloads, 1);
assert.equal(context.location.hash, "#26002");
assert.equal(context.location.searchParams.get("token"), "test-token");

// replaceState does not emit hashchange: the page must explicitly notify the UI.
for (const event of ["krista:baustellen-rendered", "krista:baustelle-opened", "krista:baustelle-closed"]) {
  assert.ok(page.includes(`new CustomEvent('${event}'`));
  assert.ok(source.includes(`addEventListener("${event}"`));
}
assert.match(page, /Keine Baustellen gefunden\.<\/div>';notifyCollections\(\);return/);
assert.match(source, /#detail \.detail-top/);
assert.doesNotMatch(source, /getElementById\("detailNumber"\)/, "legacy ID formatting must not erase the badge");
assert.match(page, /topbar\.js\?v=20260913-collection-2/);
assert.match(topbar, /baustellen-collection\.js\?v=20260913-collection-2/);
for (const match of page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
  if (match[1].trim()) new vm.Script(match[1]);
}

(async () => {
  const listeners = new Map(), pending = [], warnings = [];
  const lifecycle = {
    URL, URLSearchParams, location: context.location,
    document: {
      readyState: "loading",
      addEventListener(name, handler) { listeners.set(name, handler); },
      getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
      createElement() { return {}; }, head: { appendChild() {} },
    },
    window: { addEventListener() {} },
    setInterval() { return 1; }, clearInterval() {}, setTimeout,
    console: { warn(...args) { warnings.push(args); } },
    fetch(url, options) { return new Promise(resolve => pending.push({ url, options, resolve })); },
  };
  vm.runInNewContext(source.replace(entry,
    "window.BaustellenCollections={refresh,groupsFor,groupCount};"), lifecycle);
  listeners.get("DOMContentLoaded")();
  assert.equal(pending.length, 1, "data loads even before the knowledge hub exists");
  listeners.get("krista:baustellen-rendered")({ detail: { jobs } });
  pending.shift().resolve({ ok: true, text: async () => JSON.stringify({ jobs: [] }) });
  await new Promise(resolve => setImmediate(resolve));
  const ui = lifecycle.window.BaustellenCollections;
  assert.equal(ui.groupCount(ui.groupsFor("26002")), 4, "late response cannot overwrite fresher page data");
  listeners.get("krista:baustelle-opened")();
  listeners.get("krista:baustelle-closed")();
  const failedRefresh = ui.refresh();
  const request = pending.shift();
  assert.ok(!request.options.method || request.options.method === "GET");
  request.resolve({ ok: false, statusText: "Unavailable", text: async () => '{"error":"Unavailable"}' });
  await failedRefresh;
  assert.equal(warnings.length, 1);
  assert.equal(ui.groupCount(ui.groupsFor("26002")), 4, "failed refresh preserves last known membership");
  listeners.get("krista:baustellen-rendered")({ detail: { jobs: [] } });
  assert.equal(ui.groupsFor("26002").length, 0);
  console.log("OK: Vereint-Anzeige für alle Mitglieder, Links, sichere Ausgabe, Seitenereignisse, verspätete Antworten und fehlgeschlagene Aktualisierung.");
})().catch(error => { console.error(error); process.exitCode = 1; });
