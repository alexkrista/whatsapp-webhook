"use strict";

const LEGACY = "before-2026-09";
function validateCatalog(catalog) {
  for (const [kind, key] of [["colors","colourId"],["products","productId"],["formulas","formulaId"],["basePaints","baseId"],["canSizes","canSizeId"],["cans","canId"],["colorants","cntId"]]) {
    if (!Array.isArray(catalog?.[kind]) || !catalog[kind].length) throw new Error(`Katalogbereich fehlt: ${kind}`);
    const keys = catalog[kind].map(r => String(r[key]));
    if (keys.some(k => k === "undefined") || new Set(keys).size !== keys.length) throw new Error(`Ungültige IDs: ${kind}`);
  }
  const ids = kind => new Set(catalog[kind].map(r => String(r[{colors:"colourId",products:"productId",formulas:"formulaId",basePaints:"baseId",canSizes:"canSizeId"}[kind]])));
  const colors=ids("colors"), products=ids("products"), formulas=ids("formulas"), bases=ids("basePaints"), sizes=ids("canSizes");
  if (!Array.isArray(catalog.colorInProduct) || !catalog.colorInProduct.length) throw new Error("Rezeptzuordnungen fehlen");
  for (const r of catalog.colorInProduct) if (!colors.has(String(r.colourId)) || !products.has(String(r.productId)) || !formulas.has(String(r.formulaId))) throw new Error("Rezeptzuordnung verweist auf fehlende Daten");
  for (const r of catalog.cans) if (!bases.has(String(r.baseId)) || !sizes.has(String(r.canSizeId))) throw new Error("Gebinde verweist auf fehlende Basis oder Größe");
}
function activateCatalog(current, candidate) {
  validateCatalog(candidate);
  // One atomic catalog write keeps the old formulas and all their lookup tables together.
  return {...candidate, previousCatalog: current?.previousCatalog || current || null};
}
function selectCatalog(catalog, req) {
  const legacy = req.query?.catalogVersion === LEGACY || String(req.params?.id || "").startsWith("old:") || String(req.query?.colourId || "").startsWith("old:");
  return legacy ? catalog?.previousCatalog || null : catalog;
}
function searchColors(catalog) {
  const currentIds = new Set((catalog.colors || []).map(c => String(c.colourId)));
  const oldColors = new Map((catalog.previousCatalog?.colors || []).map(c => [String(c.colourId),c]));
  return [...(catalog.colors || []).map(c => ({...c, previousName:oldColors.get(String(c.colourId))?.colourCode || "", legacy: String(c.colourCode).includes("*")})),
    ...(catalog.previousCatalog?.colors || []).filter(c => !currentIds.has(String(c.colourId))).map(c => ({...c, legacy:true, archiveOnly:true}))];
}
function formulaChanged(a, b) {
  if (!a || !b) return !!a !== !!b;
  const contents = f => { try {const [ids,values]=JSON.parse(f.cntInFormula);return ids.map((id,i)=>[Number(id),Number(values[i])]).sort((x,y)=>x[0]-y[0]);} catch {return f.cntInFormula;} };
  return String(a.aBaseId)!==String(b.aBaseId) || JSON.stringify(contents(a))!==JSON.stringify(contents(b));
}
module.exports={LEGACY,validateCatalog,activateCatalog,selectCatalog,searchColors,formulaChanged};
