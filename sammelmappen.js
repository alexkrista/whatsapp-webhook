"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const D = require("./public/ui/baustellen-data");
const MIGRATION = "20260913-sammelmappen-v1";
const COLLECTION_STATUSES = ["Angebot", "Angebot – abgelehnt", "Auftrag", "Laufend", "Fertig – nicht abgerechnet", "Geschlossen"];
const validJobId = id => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) && id !== "unknown";
const unique = ids => [...new Set(ids.map(String))];
const fail = (message, status = 409) => Object.assign(new Error(message), { status });

async function readText(file) {
  try { return await fs.readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function readJson(file, fallback) {
  const raw = await readText(file);
  return raw === null ? fallback : JSON.parse(raw);
}
async function atomicText(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temp, text); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
const jsonText = value => JSON.stringify(value, null, 2) + "\n";

function createCollectionStore({ dataDir }) {
  const registryFile = path.join(dataDir, "_system", "sammelmappen.json");
  const repairDir = path.join(dataDir, "_system", "repairs", MIGRATION);
  let pending = Promise.resolve();
  const exclusive = work => {
    const result = pending.then(work);
    pending = result.catch(() => {});
    return result;
  };
  const readRegistry = () => readJson(registryFile, { version: 1, collections: {} });
  const list = async () => Object.values((await readRegistry()).collections).filter(row => row.active !== false);
  const get = async id => (await list()).find(row => row.id === String(id)) || null;
  const forMain = async id => (await list()).find(row => row.mainJobId === String(id)) || null;
  const forMember = async id => (await list()).filter(row => row.memberJobIds.includes(String(id)));
  const reserved = async id => Object.hasOwn((await readRegistry()).collections, String(id));
  const readMeta = async id => readJson(path.join(dataDir, id, ".meta.json"), {});
  async function jobExists(id) {
    return validJobId(id) && (await fs.stat(path.join(dataDir, id)).catch(() => null))?.isDirectory();
  }
  async function validate(mainJobId, memberJobIds, registry, id) {
    if (!validJobId(mainJobId) || mainJobId.startsWith("S") || id !== "S" + mainJobId) throw fail("Bitte eine Hauptakte mit eigener Baustellennummer wählen.", 400);
    if (await jobExists(id)) throw fail(`Die Nummer ${id} wird bereits von einer Einzelakte verwendet.`);
    if (!memberJobIds.length || memberJobIds.length > 50 || !memberJobIds.includes(mainJobId)) throw fail("Eine Sammelmappe enthält ihre Hauptakte und höchstens 50 Einzelakten.", 400);
    for (const memberId of memberJobIds) {
      if (registry.collections[memberId] || !await jobExists(memberId)) throw fail(`Einzelakte #${memberId} nicht gefunden.`, 404);
      const conflict = Object.values(registry.collections).find(row => row.active !== false && row.id !== id && row.memberJobIds.includes(memberId));
      if (conflict) throw fail(`#${memberId} gehört bereits zur Sammelmappe ${conflict.id}.`);
    }
  }

  // Registry changes never create a project directory or copy business records.
  const save = args => exclusive(async () => {
    const registry = await readRegistry();
    const requestedId = String(args.jobId || "").trim();
    const existing = (Object.hasOwn(registry.collections, requestedId) ? registry.collections[requestedId] : null) || Object.values(registry.collections).find(row => row.mainJobId === requestedId);
    const mainJobId = existing?.mainJobId || requestedId;
    const id = "S" + mainJobId;
    if (!Array.isArray(args.memberJobIds)) throw fail("Einzelakten fehlen.", 400);
    const supplied = args.memberJobIds.map(value => String(value).trim());
    if (supplied.some(value => !validJobId(value))) throw fail("Ungültige Einzelakte.", 400);
    if (!supplied.length) {
      if (!existing) throw fail("Sammelmappe nicht gefunden.", 404);
      registry.collections[id] = { ...existing, active: false, updatedAt: new Date().toISOString() };
      await atomicText(registryFile, jsonText(registry));
      return { ...registry.collections[id], memberJobIds: [] };
    }
    const memberJobIds = unique([mainJobId, ...supplied]);
    await validate(mainJobId, memberJobIds, registry, id);
    for (const memberId of memberJobIds) {
      if ((await readMeta(memberId)).collectionMemberJobIds?.length) throw fail(`#${memberId} ist noch eine bisherige Sammelakte und muss zuerst umgestellt werden.`);
    }
    const meta = await readMeta(mainJobId), now = new Date().toISOString();
    const collection = { ...existing, id, mainJobId, memberJobIds, name: existing?.name || meta.name || mainJobId, active: true, createdAt: existing?.createdAt || now, updatedAt: now };
    registry.collections[id] = collection;
    await atomicText(registryFile, jsonText(registry));
    return collection;
  });

  const setStatus = (id, value) => exclusive(async () => {
    if (value !== "" && !COLLECTION_STATUSES.includes(value)) throw fail("Ungültiger Status der Sammelmappe.", 400);
    const registry = await readRegistry(), collection = Object.hasOwn(registry.collections, id) ? registry.collections[id] : null;
    if (!collection || collection.active === false) throw fail("Sammelmappe nicht gefunden.", 404);
    // Status changes must not invalidate the saved hours or alter member records.
    registry.collections[id] = { ...collection, statusOverride: value, statusUpdatedAt: new Date().toISOString() };
    await atomicText(registryFile, jsonText(registry));
    return registry.collections[id];
  });

  // Prepare both conversions before the first write. The journal contains the
  // exact originals; a restart resumes only if every file is still before/after.
  const migrateLegacy = (headIds = ["24177", "25018"]) => exclusive(async () => {
    const completedFile = path.join(repairDir, "completed.json");
    const completed = await readJson(completedFile, null);
    if (completed) return { status: "already_migrated", ...completed };
    const planFile = path.join(repairDir, "plan.json");
    let plan = await readJson(planFile, null);
    if (!plan) {
      const registryBefore = await readText(registryFile);
      const registry = registryBefore === null ? { version: 1, collections: {} } : JSON.parse(registryBefore);
      const changes = new Map(), converted = [], skipped = [], at = new Date().toISOString();
      for (const mainJobId of headIds) {
        const head = await readMeta(mainJobId), id = "S" + mainJobId;
        if (registry.collections[id]) { skipped.push({ id, reason: "already_exists" }); continue; }
        if (!head.collectionMemberJobIds?.length) { skipped.push({ id, reason: "no_legacy_group" }); continue; }
        const memberJobIds = unique([mainJobId, ...head.collectionMemberJobIds]);
        await validate(mainJobId, memberJobIds, registry, id);
        const rows = [];
        for (const jobId of memberJobIds) {
          if (changes.has(jobId)) throw fail(`Einzelakte #${jobId} ist mehrfach zugeordnet.`);
          const file = path.join(dataDir, jobId, ".meta.json"), before = await readText(file);
          const meta = before === null ? {} : JSON.parse(before);
          if (jobId !== mainJobId && meta.collectionMemberJobIds?.length) throw fail(`#${jobId} ist eine verschachtelte Sammelakte.`);
          rows.push({ jobId, before, meta, next: { ...meta, wwProjectLinks: [] } });
        }
        for (const source of rows) {
          for (const link of source.meta.wwProjectLinks || []) {
            const number = String(link.projectNumber || ""), index = Number(link.projectIndex || 0);
            const owners = rows.filter(row => number ? String(row.meta.wwProjectNumber || row.jobId) === number : index > 0 && Number(row.meta.wwProjectIndex) === index);
            if (owners.length > 1) throw fail(`WinWorker-Akte ${number || index} ist nicht eindeutig zugeordnet.`);
            const owner = owners[0] || source;
            if (!owner.next.wwProjectLinks.some(row => number ? String(row.projectNumber || "") === number : Number(row.projectIndex) === index)) owner.next.wwProjectLinks.push(link);
          }
        }
        for (const row of rows) {
          if (row.jobId === mainJobId) row.next.collectionMemberJobIds = [];
          // Preserve inherited reconciliation for members without their own rule.
          if (row.jobId !== mainJobId && !row.meta.hoursOverlapResolvedAt && !row.meta.hoursCutoverDate && (head.hoursOverlapResolvedAt || head.hoursCutoverDate)) {
            for (const key of ["hoursOverlapResolvedAt", "hoursOverlapExcludedWwKeys", "hoursCutoverDate"]) if (Object.hasOwn(head, key)) row.next[key] = head[key];
          }
          if (JSON.stringify(row.meta.wwProjectLinks || []) === JSON.stringify(row.next.wwProjectLinks) && !Object.hasOwn(row.meta, "wwProjectLinks")) delete row.next.wwProjectLinks;
          if (JSON.stringify(row.meta) !== JSON.stringify(row.next)) changes.set(row.jobId, { file: path.join(row.jobId, ".meta.json"), before: row.before, after: jsonText(row.next) });
        }
        registry.collections[id] = { id, mainJobId, memberJobIds, name: head.name || mainJobId, active: true, createdAt: at, updatedAt: at, migration: MIGRATION };
        converted.push({ id, mainJobId, memberCount: memberJobIds.length });
      }
      if (!converted.length) return { status: "skipped", skipped };
      // Also reject memberships owned by another, non-migrated legacy head.
      const owners = new Map(Object.values(registry.collections).filter(row => row.active !== false).flatMap(row => row.memberJobIds.map(id => [id, row.mainJobId])));
      for (const entry of await fs.readdir(dataDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !validJobId(entry.name) || converted.some(row => row.mainJobId === entry.name)) continue;
        const meta = await readMeta(entry.name);
        for (const id of meta.collectionMemberJobIds || []) if (owners.has(String(id))) throw fail(`#${id} gehört auch zur bisherigen Sammelakte #${entry.name}.`);
      }
      plan = { at, converted, skipped, changes: [...changes.values(), { file: path.relative(dataDir, registryFile), before: registryBefore, after: jsonText(registry) }] };
      await atomicText(planFile, jsonText(plan));
    }
    for (const change of plan.changes) {
      const current = await readText(path.join(dataDir, change.file));
      if (current !== change.before && current !== change.after) throw fail(`Umstellung angehalten: ${change.file} wurde inzwischen verändert.`);
    }
    for (const change of plan.changes) {
      const file = path.join(dataDir, change.file);
      if (await readText(file) !== change.after) await atomicText(file, change.after);
    }
    const result = { collections: plan.converted, at: plan.at };
    await atomicText(completedFile, jsonText(result));
    return { status: "migrated", ...result };
  });
  return { list, get, forMain, forMember, reserved, save, setStatus, migrateLegacy };
}

function collectionCatalog(jobs, definitions) {
  const byId = new Map(jobs.map(job => [String(job.jobId), job]));
  const collections = definitions.map(definition => {
    const main = byId.get(definition.mainJobId), rows = definition.memberJobIds.map(id => byId.get(id)).filter(Boolean);
    const automaticStatus = rows.some(row => row.status === "Laufend") ? "Laufend" : rows.some(row => row.status === "Auftrag") ? "Auftrag" : main?.status || "Angebot";
    const statusOverride = COLLECTION_STATUSES.includes(definition.statusOverride) ? definition.statusOverride : "";
    const collection = { jobId: definition.id, kind: "collection", name: definition.name || main?.name || definition.id,
      collectionMainJobId: definition.mainJobId, collectionMemberJobIds: definition.memberJobIds,
      status: statusOverride || automaticStatus, statusOverride, automaticStatus, statusUpdatedAt: definition.statusUpdatedAt || null,
      favorite: !!main?.favorite, latestDay: rows.map(row => row.latestDay || "").sort().at(-1) || null,
      createdAt: definition.createdAt, registryUpdatedAt: definition.updatedAt, calculation: {}, wwProjectLinks: [],
      collectionSummary: { searchText: rows.map(row => [row.jobId, row.name, row.street, row.city].filter(Boolean).join(" ")).join(" "),
        missingMemberJobIds: definition.memberJobIds.filter(id => !byId.has(id)),
        totalStats: Object.fromEntries(["items", "images", "audio", "pdfs"].map(key => [key, rows.reduce((sum, row) => sum + D.num(row.totalStats?.[key]), 0)])),
        regieAmount: rows.reduce((sum, row) => sum + D.num(row.regieSummary?.amount), 0),
        materialPositions: rows.reduce((sum, row) => sum + D.num(row.materialSummary?.positions), 0),
        materialValue: rows.reduce((sum, row) => sum + D.num(row.materialSummary?.value), 0) } };
    for (const row of rows) row.collectionParentJobIds = unique([...(row.collectionParentJobIds || []), definition.id]);
    if (main) main.collectionMainMemberJobIds = definition.memberJobIds.filter(id => id !== definition.mainJobId);
    return collection;
  });
  D.recalculateCollections({ jobs: [...jobs, ...collections] });
  return collections;
}

function collectionWriteGuard(store, requireAdmin) {
  return async (req, res, next) => {
    // Reads retain their existing authentication, including signed photo links.
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
    if (!requireAdmin(req, res)) return;
    try {
      const id = String(req.params.jobId || "");
      if (req.path === "/collection") return next();
      if (await store.reserved(id)) return res.status(409).json({ ok: false, error: "Die Sammelmappe hat keine eigenen Buchungen. Bitte die Einzelakte öffnen." });
      if (req.method === "DELETE" && (req.path === "/" || req.path === "") && (await store.forMember(id)).length) return res.status(409).json({ ok: false, error: "Diese Einzelakte gehört zu einer Sammelmappe. Bitte zuerst die Zuordnung lösen." });
      next();
    } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
  };
}

module.exports = { createCollectionStore, collectionCatalog, collectionWriteGuard, MIGRATION };
