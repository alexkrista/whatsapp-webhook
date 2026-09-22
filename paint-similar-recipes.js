"use strict";

const value = (row, key) => row[key] ?? row[key.toUpperCase()];
const canonical = text => String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^NCSS(?=\d)/, 'NCS');
const EPSILON = 1e-10;

function normalizedRecipe(formula, colorants, nominalMl) {
  let parsed = value(formula, 'cntInFormula');
  try { if (!Array.isArray(parsed)) parsed = JSON.parse(parsed); } catch { return null; }
  if (!Array.isArray(parsed?.[0]) || !Array.isArray(parsed[1]) || parsed[0].length !== parsed[1].length || !(nominalMl > 0)) return null;
  const quantities = new Map();
  for (let i = 0; i < parsed[0].length; i++) {
    const id = Number(parsed[0][i]), amount = Number(parsed[1][i]);
    if (parsed[1][i] === null || parsed[1][i] === '' || !Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(id) || !colorants.has(id)) return null;
    if (amount > 0) quantities.set(id, (quantities.get(id) || 0) + amount);
  }
  const total = [...quantities.values()].reduce((a, b) => a + b, 0);
  if (!(total > 0) || !Number.isFinite(total)) return null;
  return [...quantities].map(([cntId, amount]) => ({cntId, code: value(colorants.get(cntId), 'cntCode') || String(cntId), ml: amount * nominalMl / 1000, share: amount / total}));
}

function compareRecipes(reference, candidate) {
  const a = new Map(reference.map(r => [r.cntId, r]));
  const b = new Map(candidate.map(r => [r.cntId, r]));
  const rows = [...new Set([...a.keys(), ...b.keys()])].sort((x,y) => x-y).map(cntId => {
    const left = a.get(cntId), right = b.get(cntId);
    return {cntId, code: (left || right).code, referenceMl: left?.ml || 0, candidateMl: right?.ml || 0,
      referencePercent: (left?.share || 0) * 100, candidatePercent: (right?.share || 0) * 100,
      deltaPercent: ((right?.share || 0) - (left?.share || 0)) * 100,
      change: !left ? 'added' : !right ? 'removed' : 'same'};
  });
  const added = rows.filter(r => r.change === 'added'), removed = rows.filter(r => r.change === 'removed');
  const deviation = rows.reduce((sum,r) => sum + Math.abs(r.deltaPercent), 0) / 2;
  const minor = Math.max(0, ...added.map(r=>r.candidatePercent), ...removed.map(r=>r.referencePercent));
  let matchClass = null;
  if (!added.length && !removed.length && deviation <= 1 + EPSILON) matchClass = 1;
  else if (added.length <= 1 && !removed.length && minor <= 3 + EPSILON && deviation <= 3 + EPSILON) matchClass = 3;
  else if (added.length <= 1 && removed.length <= 1 && minor <= 5 + EPSILON && deviation <= 5 + EPSILON) matchClass = 5;
  return {deviation, matchClass, rows, changedColorants: rows.filter(r=>Math.abs(r.deltaPercent) > EPSILON || r.change !== 'same')};
}

function registerSimilarRecipes(app, helpers) {
  const {requireAdmin, loadCatalog, buildCatalogIndex, resolveFormulaForProduct} = helpers;
  app.get('/admin/api/paint/similar-recipes', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.set('Cache-Control', 'no-store');
    try {
      const catalog = await loadCatalog();
      if (!catalog) return res.status(503).json({ok:false,error:'Innovatint-Katalog noch nicht importiert'});
      const idx = buildCatalogIndex(catalog);
      const resolve = (colour, productId, canSizeId) => {
        const colourId = Number(value(colour, 'colourId'));
        const resolved = resolveFormulaForProduct(colourId, productId, idx);
        if (!resolved || Number(value(resolved.link, 'version') || 0) !== 0) return null;
        const aid = Number(value(resolved.formula, 'aBaseId'));
        const base = idx.baseByProductAbstract.get(`${productId}|${aid}`) || idx.baseByProductAbstract.get(`${resolved.inheritedFromProductId}|${aid}`);
        if (!base) return null;
        const baseId = Number(value(base,'baseId'));
        if (!(idx.cansByBaseId.get(baseId) || []).some(c=>Number(value(c,'canSizeId')) === canSizeId)) return null;
        const size = idx.canSizeById.get(canSizeId);
        const recipe = normalizedRecipe(resolved.formula, idx.colorantById, Number(value(size || {},'nominalAmount')));
        if (!recipe) return null;
        return {colourId, name:value(colour,'colourCode'), productId, productName:value(idx.productById.get(productId),'productName'),
          baseId, baseCode:value(base,'baseCode'), canSizeId, canSize:value(size,'canSizeCode'), formulaId:Number(value(resolved.formula,'formulaId')), recipe};
      };
      // Keep historical catalogues and explicitly retired colours/products out of current matches.
      const colors = catalog.colors.filter(c=>!String(value(c,'colourCode')).includes('*'));
      const products = catalog.products.filter(p=>! /\bOLD\b/i.test(value(p,'productName')));
      if (!req.query.colourId) {
        const q = canonical(String(req.query.q || '').slice(0,120));
        if (!q) return res.status(400).json({ok:false,error:'Bitte einen Farbcode eingeben.'});
        const exact = colors.filter(c=>[value(c,'colourCode'),value(c,'altColourCode')].some(s=>canonical(s) === q));
        const found = exact.length ? exact : colors.filter(c=>[value(c,'colourCode'),value(c,'altColourCode')].some(s=>canonical(s).includes(q)));
        if (found.length > 50) return res.status(400).json({ok:false,error:'Bitte den Farbcode genauer eingeben (mehr als 50 Farben).'});
        const references = [];
        for (const color of found) for (const product of products) for (const canSizeId of idx.canSizeById.keys()) {
          const r = resolve(color, Number(value(product,'productId')), canSizeId);
          if (r) references.push(r);
        }
        return res.json({ok:true,references});
      }
      const colourId = Number(req.query.colourId), productId = Number(req.query.productId), canSizeId = Number(req.query.canSizeId), threshold = Number(req.query.threshold || 5);
      if (![colourId,productId,canSizeId].every(Number.isSafeInteger) || ![1,3,5].includes(threshold)) return res.status(400).json({ok:false,error:'Ungültige Referenz oder Trefferklasse.'});
      const color = colors.find(c=>Number(value(c,'colourId')) === colourId);
      if (!color || !products.some(p=>Number(value(p,'productId'))===productId)) return res.status(404).json({ok:false,error:'Aktuelle Referenz nicht gefunden.'});
      const reference = resolve(color, productId, canSizeId);
      if (!reference) return res.status(400).json({ok:false,error:'Keine gültige Rezeptur für diese Produkt-/Gebindekombination.'});
      const results = [];
      let skippedInvalid = 0;
      for (const candidateColor of colors) {
        if (Number(value(candidateColor,'colourId')) === colourId) continue;
        const candidate = resolve(candidateColor, productId, canSizeId);
        if (!candidate) { skippedInvalid++; continue; }
        if (candidate.baseId !== reference.baseId) continue;
        const comparison = compareRecipes(reference.recipe, candidate.recipe);
        if (comparison.matchClass && comparison.matchClass <= threshold) results.push({...candidate,...comparison});
      }
      results.sort((a,b)=>a.deviation-b.deviation || a.matchClass-b.matchClass || String(a.name).localeCompare(String(b.name),'de') || a.colourId-b.colourId);
      res.json({ok:true,reference,results,skippedInvalid});
    } catch (error) { res.status(500).json({ok:false,error:'Rezeptvergleich konnte nicht geladen werden.'}); }
  });
}
module.exports = {normalizedRecipe, compareRecipes, registerSimilarRecipes};
