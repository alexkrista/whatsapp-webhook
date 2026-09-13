"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createCollectionStore, collectionCatalog, collectionWriteGuard, MIGRATION } = require("../sammelmappen");
const D = require("../public/ui/baustellen-data");

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sammelmappen-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ids = ["24177", "26018", "25047", ...Array.from({ length: 36 }, (_, i) => String(27000 + i))];
  const metas = Object.fromEntries([...ids, "25018", "keckeis_gabi_harry", "99900"].map(id => [id, { name: id, status: "Laufend", billingRate: 85, contractAmount: id === "24177" ? 150000 : 0, untouched: { keep: true } }]));
  metas["24177"].name = "Egon Allgäuer";
  metas["24177"].collectionMemberJobIds = ids.slice(1);
  metas["24177"].wwProjectLinks = ids.map(projectNumber => ({ projectNumber, projectIndex: Number(projectNumber) }));
  metas["24177"].hoursOverlapResolvedAt = "2026-09-12";
  metas["24177"].hoursOverlapExcludedWwKeys = ["26018|2026-09-01|name:max"];
  metas["25047"].hoursCutoverDate = "2026-06-01";
  metas["25018"].name = "Keckeis";
  metas["25018"].collectionMemberJobIds = ["keckeis_gabi_harry"];
  metas["25018"].customerPortal = { status: "active", mode: "collection", includedJobIds: ["keckeis_gabi_harry"] };
  const originals = new Map();
  for (const [id, meta] of Object.entries(metas)) {
    await fs.mkdir(path.join(dir, id, "2026-09-01"), { recursive: true });
    for (const [name, value] of [[".meta.json", JSON.stringify(meta)], [".order-calculation.json", JSON.stringify({ netTotal: meta.contractAmount, positions: [] })], ["2026-09-01/photo.jpg", "original-photo-" + id], ["2026-09-01/regie.json", JSON.stringify({ hours: 2, jobId: id })]]) {
      const file = path.join(id, name); originals.set(file, value); await fs.writeFile(path.join(dir, file), value);
    }
  }
  return { dir, ids, metas, originals, store: createCollectionStore({ dataDir: dir }), meta: id => fs.readFile(path.join(dir, id, ".meta.json"), "utf8").then(JSON.parse) };
}

test("both existing groups become separate S containers; all business files stay byte-identical", async t => {
  const f = await fixture(t), result = await f.store.migrateLegacy();
  assert.equal(result.status, "migrated");
  assert.deepEqual(result.collections.map(row => [row.id, row.mainJobId, row.memberCount]), [["S24177", "24177", 39], ["S25018", "25018", 2]]);
  for (const id of ["S24177", "S25018"]) await assert.rejects(fs.access(path.join(f.dir, id)), { code: "ENOENT" });
  assert.deepEqual((await f.meta("24177")).collectionMemberJobIds, []);
  assert.deepEqual((await f.meta("25018")).collectionMemberJobIds, []);
  assert.deepEqual((await f.meta("25018")).customerPortal, f.metas["25018"].customerPortal);
  for (const [file, original] of f.originals) if (!file.endsWith(".meta.json")) assert.equal(await fs.readFile(path.join(f.dir, file), "utf8"), original);
  for (const id of f.ids) {
    const meta = await f.meta(id);
    assert.deepEqual(meta.untouched, { keep: true }); assert.equal(meta.contractAmount, f.metas[id].contractAmount);
    assert.deepEqual(D.projects({ ...meta, jobId: id }, [{ ...meta, jobId: id }]).map(ref => ref.projectNumber), [id]);
  }
  assert.equal((await f.meta("26018")).hoursOverlapResolvedAt, "2026-09-12");
  assert.equal((await f.meta("25047")).hoursCutoverDate, "2026-06-01", "a member's explicit policy remains its own");
  const plan = JSON.parse(await fs.readFile(path.join(f.dir, "_system/repairs", MIGRATION, "plan.json"), "utf8"));
  for (const change of plan.changes) if (f.originals.has(change.file)) assert.equal(change.before, f.originals.get(change.file));
  assert.equal((await f.store.migrateLegacy()).status, "already_migrated");
});

test("a partial migration resumes its journal and never overwrites a later change", async t => {
  const f = await fixture(t); await f.store.migrateLegacy();
  const repair = path.join(f.dir, "_system/repairs", MIGRATION), plan = JSON.parse(await fs.readFile(path.join(repair, "plan.json"), "utf8"));
  await fs.rm(path.join(repair, "completed.json"));
  const first = plan.changes[0]; await fs.writeFile(path.join(f.dir, first.file), first.before);
  const registry = plan.changes.at(-1); await fs.rm(path.join(f.dir, registry.file));
  assert.equal((await f.store.migrateLegacy()).status, "migrated");
  assert.equal(await fs.readFile(path.join(f.dir, first.file), "utf8"), first.after);
  await fs.rm(path.join(repair, "completed.json"));
  const newer = first.after + "\n"; await fs.writeFile(path.join(f.dir, first.file), newer);
  await assert.rejects(f.store.migrateLegacy(), /inzwischen verändert/);
  assert.equal(await fs.readFile(path.join(f.dir, first.file), "utf8"), newer);
});

for (const scenario of ["number collision", "missing member"]) test(`migration preflight: ${scenario} changes neither group`, async t => {
  const f = await fixture(t);
  if (scenario === "number collision") await fs.mkdir(path.join(f.dir, "S25018"));
  else await fs.rm(path.join(f.dir, "keckeis_gabi_harry"), { recursive: true });
  await assert.rejects(f.store.migrateLegacy(), scenario === "number collision" ? /bereits/ : /nicht gefunden/);
  assert.deepEqual(await f.meta("24177"), f.metas["24177"]);
  assert.deepEqual(await f.meta("25018"), f.metas["25018"]);
  assert.deepEqual(await f.store.list(), []);
});

test("membership edits retain the main project, reject conflicts, and dissolution survives restart", async t => {
  const f = await fixture(t); await f.store.migrateLegacy();
  await assert.rejects(f.store.save({ jobId: "S24177", memberJobIds: ["25018"] }), /bereits/);
  await assert.rejects(f.store.save({ jobId: "99900", memberJobIds: ["..\/24177"] }), /Ungültige/);
  const updated = await f.store.save({ jobId: "S24177", memberJobIds: ["26018", "26018"] });
  assert.deepEqual(updated.memberJobIds, ["24177", "26018"]);
  assert.equal((await f.meta("24177")).collectionMemberJobIds.length, 0);
  const fresh = await f.store.save({ jobId: "99900", memberJobIds: ["25047"] });
  assert.equal(fresh.id, "S99900"); assert.deepEqual(fresh.memberJobIds, ["99900", "25047"]);
  await f.store.save({ jobId: "S24177", memberJobIds: [] });
  await f.store.migrateLegacy(); assert.equal(await f.store.get("S24177"), null);
  assert.equal(await f.store.reserved("S24177"), true);
  for (const id of f.ids) await fs.access(path.join(f.dir, id));
});

test("S25018 sums independent projects while 25018 keeps its own balance", () => {
  const jobs = [{ jobId: "25018", name: "Keckeis", status: "Laufend", calculation: { calculatedHours: 510, actualHours: 468 } }, { jobId: "keckeis_gabi_harry", status: "Laufend", calculation: { calculatedHours: 0, actualHours: 26 } }];
  const collections = collectionCatalog(jobs, [{ id: "S25018", mainJobId: "25018", memberJobIds: ["25018", "keckeis_gabi_harry"] }]);
  const all = D.catalog({ jobs, collections });
  assert.deepEqual(D.memberIds(collections[0]), ["25018", "keckeis_gabi_harry"]);
  assert.equal(collections[0].collectionSummary.count, 2);
  assert.equal(collections[0].collectionSummary.actualHours, 494);
  assert.equal(collections[0].collectionSummary.remainingHours, 16);
  assert.equal(D.openHours(jobs[0], all), 42);
  assert.equal(jobs[0].collectionSummary, undefined);
  assert.deepEqual(jobs[0].collectionParentJobIds, ["S25018"]);
  assert.deepEqual(D.projects(collections[0], all).map(row => row.projectNumber), ["25018"]);
  assert.equal(D.openHours(collections[0], all), 16);
  jobs[1].calculation.actualHours = 60; D.recalculateCollections({ jobs, collections });
  assert.equal(collections[0].collectionSummary.remainingHours, 0);
  assert.equal(collections[0].collectionSummary.overrunHours, 18);
});

test("collection write protection preserves signed photo reads and normal project edits", async () => {
  let authChecks = 0;
  const guard = collectionWriteGuard({ reserved: async id => id === "S24177", forMember: async id => id === "24177" ? [{ id: "S24177" }] : [] }, () => { authChecks++; return true; });
  async function request(method, jobId, route) {
    const result = { next: false, status: 200 }, response = { status(value){ result.status = value; return this; }, json(value){ result.body = value; } };
    await guard({ method, params: { jobId }, path: route }, response, () => { result.next = true; }); return result;
  }
  assert.equal((await request("GET", "24177", "/media/share-file")).next, true);
  assert.equal(authChecks, 0, "signed reads continue to their own token verification");
  assert.equal((await request("PUT", "S24177", "/meta")).status, 409);
  assert.equal((await request("PUT", "24177", "/meta")).next, true);
  assert.equal((await request("PUT", "S24177", "/collection")).next, true);
  assert.equal((await request("DELETE", "24177", "/")).status, 409);
});
