"use strict";

const fsp = require("fs/promises");
const path = require("path");

function registerPaintCatalogSync(app, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || "/var/data";
  const adminToken = process.env.ADMIN_TOKEN || "";
  const root = path.join(dataDir, "_kristine", "paint");
  const catalogFile = path.join(root, "innovatint-catalog.json");
  const candidateFile = path.join(root, "innovatint-catalog-candidate.json");
  const candidateMetaFile = path.join(root, "innovatint-catalog-candidate-meta.json");
  const backupDir = path.join(root, "catalog-backups");

  function requireAdmin(req, res) {
    if (!adminToken) return true;
    const token = req.headers["x-admin-token"] || req.query.token || "";
    if (String(token) !== String(adminToken)) {
      res.status(403).json({ ok:false, error:"Forbidden" });
      return false;
    }
    return true;
  }

  const clean = (value, max = 500) => String(value ?? "").trim().slice(0, max);
  async function ensureDir(dir = root) { await fsp.mkdir(dir, { recursive:true }); }
  async function readJson(file, fallback) { try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; } }
  async function writeJson(file, value) {
    await ensureDir(path.dirname(file));
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(tmp, file);
  }
  async function exists(file) { try { await fsp.access(file); return true; } catch { return false; } }

  function normalizeCatalog(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    return {
      meta: {
        ...(source.meta && typeof source.meta === "object" ? source.meta : {}),
        exportedAt: source.exportedAt || source.meta?.exportedAt || new Date().toISOString(),
        source: clean(source.source || source.meta?.source || "Innovatint", 160),
      },
      colors: Array.isArray(source.colors) ? source.colors : [],
      products: Array.isArray(source.products) ? source.products : [],
      formulas: Array.isArray(source.formulas) ? source.formulas : [],
      colorInProduct: Array.isArray(source.colorInProduct) ? source.colorInProduct : [],
      basePaints: Array.isArray(source.basePaints) ? source.basePaints : [],
      canSizes: Array.isArray(source.canSizes) ? source.canSizes : [],
      cans: Array.isArray(source.cans) ? source.cans : [],
      colorants: Array.isArray(source.colorants) ? source.colorants : [],
    };
  }

  const valueOf = (row, names) => {
    for (const name of names) {
      if (row && row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== "") return row[name];
    }
    return "";
  };
  const norm = value => clean(value, 500).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();

  function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== "object") return value;
    const ignored = /^(exportedAt|importedAt|updatedAt|modifiedAt|createdAt|timestamp|lastModified)$/i;
    return Object.fromEntries(Object.keys(value).filter(key => !ignored.test(key)).sort().map(key => [key, stableValue(value[key])]));
  }
  const signature = row => JSON.stringify(stableValue(row));

  function keyFor(kind, row, index) {
    if (kind === "colors") return String(valueOf(row, ["colourId","COLOURID","colorId","id"]) || `${norm(valueOf(row,["colourCode","COLOURCODE","code"]))}|${index}`);
    if (kind === "products") return String(valueOf(row, ["productId","PRODUCTID","id"]) || `${norm(valueOf(row,["productName","PRODUCTNAME","name"]))}|${index}`);
    if (kind === "formulas") return String(valueOf(row, ["formulaId","FORMULAID","id"]) || `${valueOf(row,["colourId","COLOURID"])}|${valueOf(row,["productId","PRODUCTID"])}|${index}`);
    if (kind === "basePaints") return String(valueOf(row,["baseId","BASEID","id"]) || `${valueOf(row,["productId","PRODUCTID"])}|${valueOf(row,["aBaseId","ABASEID"])}|${index}`);
    if (kind === "canSizes") return String(valueOf(row,["canSizeId","CANSIZEID","id"]) || `${norm(valueOf(row,["canSizeCode","CANSIZECODE","code"]))}|${index}`);
    if (kind === "cans") return String(valueOf(row,["canId","CANID","id"]) || `${valueOf(row,["baseId","BASEID"])}|${valueOf(row,["canSizeId","CANSIZEID"])}|${index}`);
    if (kind === "colorants") return String(valueOf(row,["cntId","CNTID","id"]) || `${norm(valueOf(row,["cntCode","CNTCODE","code"]))}|${index}`);
    if (kind === "colorInProduct") return [valueOf(row,["colourId","COLOURID"]), valueOf(row,["productId","PRODUCTID"]), valueOf(row,["formulaId","FORMULAID"]), valueOf(row,["version","VERSION"])].join("|") || String(index);
    return String(index);
  }

  function labelFor(kind, row) {
    if (!row) return "";
    if (kind === "colors") return clean(valueOf(row,["colourCode","COLOURCODE","code","name"]), 160);
    if (kind === "products") return clean(valueOf(row,["productName","PRODUCTNAME","name","productCode","PRODUCTCODE"]), 160);
    if (kind === "formulas") return `Formel ${clean(valueOf(row,["formulaId","FORMULAID","id"]), 80)}`;
    if (kind === "basePaints") return clean(valueOf(row,["baseCode","BASECODE","name"]), 120);
    if (kind === "canSizes") return clean(valueOf(row,["canSizeCode","CANSIZECODE","code"]), 80);
    if (kind === "colorants") return clean(valueOf(row,["cntCode","CNTCODE","code","description","DESCRIPTION"]), 120);
    return clean(keyFor(kind, row, 0), 120);
  }

  function compareRows(kind, currentRows, nextRows) {
    const current = new Map((Array.isArray(currentRows)?currentRows:[]).map((row,index) => [keyFor(kind,row,index), row]));
    const next = new Map((Array.isArray(nextRows)?nextRows:[]).map((row,index) => [keyFor(kind,row,index), row]));
    const added = [], removed = [], changed = [];
    for (const [key,row] of next) {
      const old = current.get(key);
      if (!old) added.push({ key, label:labelFor(kind,row) });
      else if (signature(old) !== signature(row)) changed.push({ key, label:labelFor(kind,row) || labelFor(kind,old) });
    }
    for (const [key,row] of current) if (!next.has(key)) removed.push({ key, label:labelFor(kind,row) });
    return {
      current: current.size, candidate: next.size,
      added: added.length, removed: removed.length, changed: changed.length,
      examples: { added:added.slice(0,12), removed:removed.slice(0,12), changed:changed.slice(0,12) },
    };
  }

  function compareCatalogs(currentRaw, candidateRaw) {
    const current = normalizeCatalog(currentRaw || {}), candidate = normalizeCatalog(candidateRaw || {});
    const sections = {};
    for (const kind of ["colors","products","formulas","colorInProduct","basePaints","canSizes","cans","colorants"]) {
      sections[kind] = compareRows(kind, current[kind], candidate[kind]);
    }
    const totals = Object.values(sections).reduce((sum,row) => ({
      added:sum.added+row.added, removed:sum.removed+row.removed, changed:sum.changed+row.changed,
    }), { added:0, removed:0, changed:0 });
    return { totals, sections };
  }

  async function stageCandidate(raw, source = "manual") {
    const candidate = normalizeCatalog(raw);
    if (!candidate.colors.length || !candidate.products.length) throw new Error("Innovatint-Export ist leer oder ungültig");
    const current = await readJson(catalogFile, null);
    const comparison = compareCatalogs(current || {}, candidate);
    const stagedAt = new Date().toISOString();
    const meta = {
      stagedAt, source:clean(source,120), comparison,
      currentExportedAt: current?.meta?.exportedAt || null,
      candidateExportedAt: candidate.meta?.exportedAt || null,
    };
    await Promise.all([writeJson(candidateFile,candidate), writeJson(candidateMetaFile,meta)]);
    return { candidate, meta };
  }

  async function backupCurrent() {
    if (!(await exists(catalogFile))) return null;
    const current = await fsp.readFile(catalogFile, "utf8");
    await ensureDir(backupDir);
    const stamp = new Date().toISOString().replace(/[:.]/g,"-");
    const file = path.join(backupDir, `innovatint-catalog-${stamp}.json`);
    await fsp.writeFile(file, current, "utf8");
    return file;
  }

  async function listBackups() {
    const entries = await fsp.readdir(backupDir, { withFileTypes:true }).catch(() => []);
    return entries.filter(entry => entry.isFile() && entry.name.endsWith(".json")).map(entry => entry.name).sort().reverse().slice(0,10);
  }

  // Diese Route steht absichtlich VOR paint-lab.js: Upload prüft/staged nur.
  // Erst /catalog-sync/activate darf den produktiven Katalog ersetzen.
  app.post("/admin/api/paint/import-innovatint", async (req,res) => {
    if (!requireAdmin(req,res)) return;
    try {
      const { candidate, meta } = await stageCandidate(req.body, "manual-upload");
      res.json({
        ok:true, staged:true, message:"Mischdaten geprüft – noch nicht übernommen",
        colors:candidate.colors.length, products:candidate.products.length, formulas:candidate.formulas.length,
        comparison:meta.comparison, stagedAt:meta.stagedAt,
      });
    } catch (error) { res.status(400).json({ ok:false, error:String(error?.message||error) }); }
  });

  app.get("/admin/api/paint/catalog-sync/status", async (req,res) => {
    if (!requireAdmin(req,res)) return;
    try {
      const [current,candidate,meta,backups] = await Promise.all([
        readJson(catalogFile,null), readJson(candidateFile,null), readJson(candidateMetaFile,null), listBackups()
      ]);
      res.json({
        ok:true, candidateReady:!!candidate,
        current: current ? { colors:current.colors?.length||0, products:current.products?.length||0, formulas:current.formulas?.length||0, exportedAt:current.meta?.exportedAt||null } : null,
        candidate: candidate ? { colors:candidate.colors?.length||0, products:candidate.products?.length||0, formulas:candidate.formulas?.length||0, exportedAt:candidate.meta?.exportedAt||null } : null,
        comparison: meta?.comparison || (candidate ? compareCatalogs(current||{},candidate) : null),
        stagedAt: meta?.stagedAt || null, backups,
      });
    } catch (error) { res.status(500).json({ ok:false, error:String(error?.message||error) }); }
  });

  app.post("/admin/api/paint/catalog-sync/activate", async (req,res) => {
    if (!requireAdmin(req,res)) return;
    try {
      if (String(req.body?.confirm||"") !== "APPLY_INNOVATINT_CATALOG") return res.status(400).json({ ok:false,error:"Freigabe fehlt" });
      const candidate = await readJson(candidateFile,null);
      if (!candidate) return res.status(404).json({ ok:false,error:"Kein geprüfter Mischdaten-Stand vorhanden" });
      const backup = await backupCurrent();
      await writeJson(catalogFile,candidate);
      await Promise.all([
        fsp.unlink(candidateFile).catch(()=>{}), fsp.unlink(candidateMetaFile).catch(()=>{})
      ]);
      res.json({ ok:true, activatedAt:new Date().toISOString(), backup:backup?path.basename(backup):null,
        colors:candidate.colors?.length||0, products:candidate.products?.length||0, formulas:candidate.formulas?.length||0 });
    } catch (error) { res.status(500).json({ ok:false,error:String(error?.message||error) }); }
  });

  app.post("/admin/api/paint/catalog-sync/discard", async (req,res) => {
    if (!requireAdmin(req,res)) return;
    await Promise.all([fsp.unlink(candidateFile).catch(()=>{}),fsp.unlink(candidateMetaFile).catch(()=>{})]);
    res.json({ ok:true });
  });
}

module.exports = { registerPaintCatalogSync };
