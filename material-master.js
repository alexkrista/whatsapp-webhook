"use strict";

/**
 * KRISTINE Materialsystem · BUILD 0025.1
 *
 * Führende Wahrheit: KRISTINE Materialdatenbank.
 * Excel: Import, Export und Massenpflege.
 *
 * Benötigt:
 *   npm install xlsx
 *
 * Registrierung in server.js:
 *   const { registerMaterialMaster } = require("./material-master");
 *
 *   registerMaterialMaster(app, {
 *     dataDir: DATA_DIR,
 *     requireAdmin,
 *     publicDir: path.join(process.cwd(), "public"),
 *   });
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

let XLSX = null;
try {
  XLSX = require("xlsx");
} catch {
  // Die übrigen Material-APIs funktionieren auch ohne xlsx.
}

function registerMaterialMaster(app, { dataDir, requireAdmin, publicDir }) {
  if (!app) throw new Error("registerMaterialMaster: app fehlt");
  if (!dataDir) throw new Error("registerMaterialMaster: dataDir fehlt");

  const ROOT = path.join(dataDir, "_kristine", "materials");
  const MATERIALS_FILE = path.join(ROOT, "materials.json");
  const SUPPLIERS_FILE = path.join(ROOT, "suppliers.json");
  const INBOX_FILE = path.join(ROOT, "material-inbox.json");
  const IMPORTS_FILE = path.join(ROOT, "material-imports.json");
  const SETTINGS_FILE = path.join(ROOT, "material-settings.json");
  const PAINT_ARTICLES_FILE = path.join(dataDir, "_kristine", "paint", "articles.json");
  const LG_RETAIL_FILE = path.join(publicDir || path.join(process.cwd(), "public"), "lg-retail-preisliste-2025.html");

  async function ensureRoot() {
    await fsp.mkdir(ROOT, { recursive: true });
  }

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await fsp.readFile(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  async function writeJson(file, value) {
    await ensureRoot();
    const temp = `${file}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(temp, file);
  }

  function clean(value, max = 500) {
    return String(value ?? "").trim().slice(0, max);
  }

  function bool(value, fallback = false) {
    if (typeof value === "boolean") return value;
    const normalized = clean(value).toLowerCase();
    if (["ja", "yes", "true", "1", "x"].includes(normalized)) return true;
    if (["nein", "no", "false", "0"].includes(normalized)) return false;
    return fallback;
  }

  function number(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const raw = clean(value).replace(/\s/g, "");
    if (!raw) return 0;
    const normalized = raw.includes(",")
      ? raw.replace(/\./g, "").replace(",", ".")
      : raw;
    const result = Number(normalized);
    return Number.isFinite(result) ? result : 0;
  }

  function isNumericValue(value) {
    const raw = clean(value).replace(/\s/g, "");
    if (!raw) return false;
    const normalized = raw.includes(",")
      ? raw.replace(/\./g, "").replace(",", ".")
      : raw;
    return /^-?\d+(?:\.\d+)?$/.test(normalized);
  }

  function normalizePackage(rawContainer, rawUnit) {
    const containerText = clean(rawContainer, 50);
    const unitText = clean(rawUnit, 50);

    // KRISTA-Excel: Gebinde = Sack/kg/Rolle, Einheit = 1,0
    if (containerText && !isNumericValue(containerText) && isNumericValue(unitText)) {
      return { containerSize: number(unitText), unit: containerText };
    }

    // Klassisch: Gebinde = 5, Einheit = L
    if (isNumericValue(containerText)) {
      return { containerSize: number(containerText), unit: unitText };
    }

    // Nur eine textliche Einheit vorhanden
    return {
      containerSize: isNumericValue(unitText) ? number(unitText) : 1,
      unit: containerText || unitText
    };
  }

  function dateISO(value) {
    if (!value) return "";
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString().slice(0, 10);
    }
    if (typeof value === "number" && XLSX?.SSF) {
      const parsed = XLSX.SSF.parse_date_code(value);
      if (parsed) {
        return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
      }
    }
    const raw = clean(value);
    let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
    match = raw.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
    if (match) return `${match[3]}-${String(match[2]).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`;
    return "";
  }

  function slug(value) {
    return clean(value, 200)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  }

  function normalizeHeader(value) {
    return clean(value, 100)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[€()]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  const headerAliases = {
    importAction: ["status b n l", "status", "aktion", "b n l"],
    materialId: ["material id", "artikelnummer", "artikel nr", "kurzel", "kürzel", "code"],
    group: ["gruppe", "materialgruppe"],
    subgroup: ["untergruppe", "materialuntergruppe"],
    manufacturer: ["hersteller", "hersteller handler", "hersteller händler", "marke"],
    articleNumber: ["artikel nummer", "artikelnummer", "artikel nr"],
    product: ["produkt", "produktname", "material", "artikel", "artikelbezeichnung"],
    productLine: ["produktlinie", "linie", "variante basis", "variante"],
    colorNumber: ["farbnummer", "farb nr", "farbtonnummer", "nummer"],
    colorName: ["farbname", "farbton", "farbbezeichnung"],
    containerSize: ["gebinde", "gebindegroße", "gebindegroesse", "inhalt"],
    unit: ["einheit", "mengeneinheit"],
    purchasePrice: ["ek", "ek netto", "einkaufspreis", "einkaufspreis netto"],
    markup: ["aufschlag"],
    overhead: ["gemeinkosten"],
    salePrice: ["vk", "vk netto", "vk netto netto", "verkaufspreis", "verkaufspreis netto"],
    fixedSalePrice: ["fix vk", "fixpreis", "vk fix", "fester vk", "festpreis vk"],
    priceValidFrom: ["preis gultig ab", "preisstand", "datenstand", "preisdatum"],
    priceCheckedAt: ["zuletzt gepruft", "preis gepruft am", "gepruft am", "preisstand"],
    stock: ["lagerbestand", "aktueller bestand", "bestand"],
    minimumStock: ["mindestbestand", "minimum"],
    storageLocation: ["lagerplatz", "lagerort"],
    supplier: ["lieferant"],
    supplierArticleNumber: ["lieferanten artikelnummer", "lieferantenartikelnummer"],
    wwSupplierAddressId: ["ww stammindex", "ww lieferanten stammindex"],
    wwSupplierNumber: ["ww lieferantennummer", "lieferantennummer ww"],
    ourCustomerNumberAtSupplier: ["unsere kundennummer", "unsere kundennummer beim lieferanten"],
    manufacturerArticleNumber: ["hersteller artikelnummer", "herstellerartikelnummer"],
    regieItem: ["regieartikel", "regiepflicht", "regie"],
    designRelevant: ["gestaltungsauftrag", "materialprotokoll", "dokumentationsrelevant", "projektrelevant"],
    extraQuestion: ["zusatzfrage"],
    alias: ["alias", "aliase", "suchbegriffe"],
    labelPhotoRequired: ["foto etikett", "mischetikett", "dokumentationsfoto"],
    locationMode: ["ort abfrage", "wo erforderlich", "zuordnung"],
    roomRequired: ["raum erforderlich"],
    componentRequired: ["bauteil erforderlich"],
    areaRequired: ["bereich erforderlich"],
    photoRequired: ["foto pflicht", "foto erforderlich"],
    active: ["aktiv"],
    note: ["bemerkung", "notiz"],
  };

  function findValue(row, field) {
    const aliases = headerAliases[field] || [];
    for (const [rawKey, value] of Object.entries(row || {})) {
      const key = normalizeHeader(rawKey);
      if (aliases.includes(key)) return value;
    }
    return "";
  }

  function hasField(row, field) {
    const aliases = headerAliases[field] || [];
    return Object.keys(row || {}).some(rawKey => aliases.includes(normalizeHeader(rawKey)));
  }

  function inferLocationMode({ group, subgroup, product, roomRequired, componentRequired, areaRequired }) {
    if (roomRequired) return "room";
    if (componentRequired) return "component";
    if (areaRequired) return "area";
    const haystack = `${group} ${subgroup} ${product}`.toLowerCase();
    if (/innenfarbe|innendispersion|tapete/.test(haystack)) return "room";
    if (/lack|lasur/.test(haystack)) return "component";
    if (/außen|aussen|fassade/.test(haystack)) return "area";
    return "none";
  }

  function materialKey(material) {
    return [
      clean(material.manufacturer).toLowerCase(),
      clean(material.product).toLowerCase(),
      clean(material.productLine).toLowerCase(),
      clean(material.colorNumber).toLowerCase(),
      clean(material.colorName).toLowerCase(),
      number(material.containerSize),
      clean(material.unit).toLowerCase(),
    ].join("|");
  }

  function supplierFingerprint(value) {
    const fingerprint = clean(value, 200)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/&/g, " und ")
      .replace(/gesellschaft\s+mit\s+beschrankter\s+haftung/g, " gmbh ")
      .replace(/ges\.?\s*m\.?\s*b\.?\s*h\.?/g, " gmbh ")
      .replace(/\b(gmbh|mbh|ag|kg|og|e\.u|eu)\b/g, " ")
      .replace(/\b(?:und\s+co|co)\b/g, " ")
      .replace(/[^a-z0-9]+/g, "") || "ohne-lieferant";
    return fingerprint === "lg" ? "littlegreene" : fingerprint;
  }

  function matchesSupplierFilter(item, filter) {
    const selected = clean(filter, 120);
    if (!selected) return true;
    if (supplierFingerprint(selected) === supplierFingerprint("Ohne Lieferant")) {
      return !clean(item?.supplier, 120);
    }
    return supplierFingerprint(item?.supplier) === supplierFingerprint(selected);
  }

  function supplierLinkForName(links, name) {
    const fingerprint = supplierFingerprint(name);
    return (links || []).find(link =>
      supplierFingerprint(link.name) === fingerprint ||
      (link.aliases || []).some(alias => supplierFingerprint(alias) === fingerprint)
    ) || null;
  }

  function applySupplierLink(raw, links) {
    const supplierName = clean(raw?.supplier, 120);
    const link = supplierLinkForName(links, supplierName);
    if (!link) return raw;
    return {
      ...raw,
      supplier: link.name,
      supplierId: link.id,
      wwSupplierAddressId: link.wwAddressId,
      wwSupplierNumber: link.wwSupplierNumber,
      ourCustomerNumberAtSupplier: link.ourCustomerNumber,
      supplierAliases: [...new Set([...(raw?.supplierAliases || []), ...(link.aliases || []), supplierName].map(value => clean(value, 120)).filter(Boolean))],
    };
  }

  function supplierGroups(materials) {
    const groups = new Map();
    for (const item of materials.filter(material => material.active !== false && clean(material.supplier, 120))) {
      const key = clean(item.supplierId, 160) || `local:${supplierFingerprint(item.supplier)}`;
      const current = groups.get(key) || {
        key,
        name: clean(item.supplier, 120),
        aliases: new Set(),
        materialCount: 0,
        linked: false,
        wwAddressId: "",
        wwSupplierNumber: "",
        ourCustomerNumber: "",
      };
      current.materialCount += 1;
      current.aliases.add(clean(item.supplier, 120));
      if (!current.linked && clean(item.supplier, 120).length > current.name.length) current.name = clean(item.supplier, 120);
      for (const alias of item.supplierAliases || []) if (clean(alias, 120)) current.aliases.add(clean(alias, 120));
      if (item.wwSupplierAddressId) {
        current.linked = true;
        current.name = clean(item.supplier, 120) || current.name;
        current.wwAddressId = clean(item.wwSupplierAddressId, 120);
        current.wwSupplierNumber = clean(item.wwSupplierNumber, 80);
        current.ourCustomerNumber = clean(item.ourCustomerNumberAtSupplier, 80);
      }
      groups.set(key, current);
    }
    return [...groups.values()].map(group => ({ ...group, aliases: [...group.aliases].sort((a, b) => a.localeCompare(b, "de")) }))
      .sort((a, b) => a.name.localeCompare(b.name, "de"));
  }

  function withCanonicalSupplierNames(materials) {
    const names = new Map(supplierGroups(materials).map(group => [group.key, group]));
    return materials.map(item => {
      if (!clean(item.supplier, 120)) return item;
      const key = clean(item.supplierId, 160) || `local:${supplierFingerprint(item.supplier)}`;
      const group = names.get(key);
      return group ? { ...item, supplier: group.name, supplierAliases: group.aliases } : item;
    });
  }

  function compactArticleCode(value) {
    return clean(value, 160).toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  function lgSize(value, containerSize = 0) {
    let raw = `${containerSize || ""}${value || ""}`.toLowerCase().replace(/,/g, ".").replace(/litre|liter|ltr/g, "l").replace(/\s+/g, "");
    const fromText = raw.match(/(?:^|[^0-9])((?:0\.)?25|0\.5|0\.75|1|2|2\.5|4|5|10)l(?:$|[^a-z])/);
    if (fromText) return `${Number(fromText[1])}l`;
    const ml = raw.match(/(?:^|[^0-9])(60|250|500|750)ml(?:$|[^a-z])/);
    return ml ? `${Number(ml[1])}ml` : "";
  }

  function lgProductKey(value) {
    return clean(value, 240).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/\b(little\s*greene|lg|hi\s*white|medium|deep|extra\s*deep|transparent|yellow|pastel|white\s*asp)\b/g, " ")
      .replace(/\bemulsion\b/g, " ")
      .replace(/\b(60|250|500|750)\s*ml\b|\b(?:0[.,])?(?:25|5|75)\s*l\b|\b(?:1|2|2[.,]5|4|5|10)\s*l\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ").trim();
  }

  function lgBaseKey(value) {
    return clean(value, 120).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
  }

  async function lgRetailPriceRows() {
    try {
      const html = await fsp.readFile(LG_RETAIL_FILE, "utf8");
      return [...html.matchAll(/<tr><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/gi)].map(match => ({
        product: clean(match[1].replace(/<[^>]+>/g, ""), 180),
        productKey: lgProductKey(match[1].replace(/<[^>]+>/g, "")),
        size: lgSize(match[2].replace(/<[^>]+>/g, "")),
        gross: number(match[3].replace(/<[^>]+>/g, "").replace(/[^0-9,.]/g, "")),
      })).filter(row => row.productKey && row.size && row.gross > 0);
    } catch {
      return [];
    }
  }

  function findLgArticle(material, articles) {
    const wantedCodes = new Set([
      material.supplierArticleNumber, material.articleNumber, material.materialId, material.sourceId,
    ].map(compactArticleCode).filter(Boolean));
    const byCode = articles.find(article => [article.stockCode, article.ean, article.id].map(compactArticleCode).some(code => code && wantedCodes.has(code)));
    if (byCode) return byCode;
    const wantedProduct = lgProductKey(material.product);
    const wantedSize = lgSize(`${material.product || ""} ${material.unit || ""}`, material.containerSize);
    if (!wantedProduct || !wantedSize) return null;
    const candidates = articles.filter(article => {
      const articleProduct = lgProductKey(article.product);
      return articleProduct && (wantedProduct.includes(articleProduct) || articleProduct.includes(wantedProduct)) && lgSize(article.size) === wantedSize;
    });
    if (candidates.length === 1) return candidates[0];
    const wantedText = lgBaseKey(`${material.product} ${material.colorName || ""}`);
    const withBase = candidates.filter(article => {
      const base = lgBaseKey(article.baseName || article.baseCode);
      return base && wantedText.includes(base);
    });
    if (withBase.length === 1) return withBase[0];
    const prices = new Set(candidates.map(article => number(article.purchasePrice)).filter(price => price > 0));
    return prices.size === 1 ? candidates[0] : null;
  }

  async function syncLittleGreenePrices() {
    const [materials, articles, retailRows] = await Promise.all([
      readJson(MATERIALS_FILE, []),
      readJson(PAINT_ARTICLES_FILE, []),
      lgRetailPriceRows(),
    ]);
    if (!materials.length || !articles.length) return { matched: 0, changed: 0 };
    let matched = 0, changed = 0;
    const now = new Date().toISOString();
    for (let index = 0; index < materials.length; index += 1) {
      const item = materials[index];
      const isLittleGreene = [item.supplier, item.manufacturer, ...(item.supplierAliases || [])]
        .some(value => supplierFingerprint(value) === "littlegreene");
      if (!isLittleGreene) continue;
      const article = findLgArticle(item, articles.filter(row => row && row.active !== false));
      if (!article) continue;
      matched += 1;
      const purchasePrice = number(article.purchasePrice) || number(item.purchasePrice);
      const productKey = lgProductKey(article.product || item.product);
      const size = lgSize(article.size || `${item.product} ${item.unit}`, item.containerSize);
      const retail = retailRows.find(row => row.productKey === productKey && row.size === size);
      const salePrice = retail?.gross ? Math.round((retail.gross / 1.2 + Number.EPSILON) * 100) / 100 : (number(article.salePrice) || number(item.salePrice));
      const sourceDate = retail?.gross ? "2025-05-01" : (clean(article.updatedAt, 10) || item.priceCheckedAt);
      if (purchasePrice === number(item.purchasePrice) && salePrice === number(item.salePrice) && item.priceSource === "Little Greene" && item.fixedSalePrice === true) continue;
      materials[index] = normalizeMaterial({
        ...item,
        supplier: item.wwSupplierAddressId ? item.supplier : "Little Greene",
        purchasePrice,
        salePrice,
        fixedSalePrice: true,
        priceCheckedAt: sourceDate,
        priceValidFrom: sourceDate,
        priceSource: "Little Greene",
        priceSourceId: clean(article.id || article.stockCode, 160),
        supplierAliases: [...new Set([...(item.supplierAliases || []), item.supplier, "LG", "Little Greene"].filter(Boolean))],
        createdAt: item.createdAt,
      });
      changed += 1;
    }
    if (changed) await writeJson(MATERIALS_FILE, materials);
    return { matched, changed, syncedAt: now };
  }

  async function rebuildLittleGreeneMaterials() {
    const [materials, articles, retailRows, supplierLinks] = await Promise.all([
      readJson(MATERIALS_FILE, []),
      readJson(PAINT_ARTICLES_FILE, []),
      lgRetailPriceRows(),
      readJson(SUPPLIERS_FILE, []),
    ]);
    const lgArticles = articles.filter(article => {
      if (!article || article.active === false || !clean(article.product, 180) || !clean(article.stockCode, 100)) return false;
      return supplierFingerprint(article.manufacturer) === "littlegreene" || /^lg[-_]/i.test(clean(article.id, 160));
    });
    if (!retailRows.length) throw new Error("Die LG-VK-Liste enthält keine verwendbaren Positionen.");
    if (!lgArticles.length) throw new Error("Im LG-Lagerstamm wurden keine nummerierten Artikel gefunden.");

    const rebuiltAt = new Date().toISOString();
    const backupName = `materials.before-lg-rebuild.${rebuiltAt.replace(/[:.]/g, "-")}.json`;
    await writeJson(path.join(ROOT, backupName), materials);

    let deactivated = 0;
    for (let index = 0; index < materials.length; index += 1) {
      const item = materials[index];
      const isLittleGreene = [item.supplier, item.manufacturer, ...(item.supplierAliases || [])]
        .some(value => supplierFingerprint(value) === "littlegreene") || String(item.sourceSystem || "").toLowerCase() === "littlegreene";
      if (!isLittleGreene || item.active === false || String(item.sourceSystem || "").toLowerCase() === "littlegreene") continue;
      materials[index] = normalizeMaterial({ ...item, active: false, mergedAt: rebuiltAt, createdAt: item.createdAt });
      deactivated += 1;
    }

    const directBySource = new Map();
    const directById = new Map();
    materials.forEach((item, index) => {
      if (String(item.sourceSystem || "").toLowerCase() === "littlegreene" && item.sourceId) directBySource.set(String(item.sourceId), index);
      directById.set(String(item.materialId || item.id).toLowerCase(), index);
    });

    const preferredBaseRank = article => {
      const key = lgBaseKey(article?.baseName || article?.baseCode);
      if (["h", "hi", "hiwhite", "highwhite"].includes(key) || /HHHHH$/i.test(clean(article?.stockCode, 100))) return 0;
      if (["w", "white", "whiteasp"].includes(key)) return 1;
      if (["p", "pastel"].includes(key)) return 2;
      return 3;
    };
    const displaySize = value => {
      const key = lgSize(value);
      if (key.endsWith("ml")) return `${Number(key.slice(0, -2))} ml`;
      if (key.endsWith("l")) return `${String(Number(key.slice(0, -1))).replace(".", ",")} L`;
      return clean(value, 40);
    };

    let added = 0, updated = 0, missingEk = 0, fallbackBasis = 0;
    for (const retail of retailRows) {
      const candidates = lgArticles
        .filter(article => lgProductKey(article.product) === retail.productKey && lgSize(article.size) === retail.size)
        .sort((a, b) => preferredBaseRank(a) - preferredBaseRank(b));
      const article = candidates[0] || null;
      if (article && preferredBaseRank(article) > 0) fallbackBasis += 1;
      if (!article || number(article.purchasePrice) <= 0) missingEk += 1;
      const size = displaySize(retail.size);
      const base = clean(article?.baseName || article?.baseCode, 100);
      const generatedCode = `LG-${slug(retail.product)}-${String(retail.size).replace(/[^a-z0-9]/gi, "")}`.toUpperCase();
      const stockCode = clean(article?.stockCode, 100).toUpperCase() || generatedCode;
      const sourceId = clean(article?.id || stockCode, 160);
      const salePrice = Math.round((retail.gross / 1.2 + Number.EPSILON) * 100) / 100;
      const sourceDate = clean(article?.updatedAt, 10) || "2025-05-01";
      const linked = applySupplierLink({ supplier: "Little Greene", supplierAliases: ["LG", "Little Greene"] }, supplierLinks);
      let materialId = stockCode;
      let index = directBySource.get(sourceId);
      if (index === undefined) {
        const idIndex = directById.get(materialId.toLowerCase());
        if (idIndex !== undefined && String(materials[idIndex].sourceSystem || "").toLowerCase() === "littlegreene") index = idIndex;
        else if (idIndex !== undefined) materialId = `LG-${stockCode}`;
      }
      const existing = index === undefined ? null : materials[index];
      const rebuilt = normalizeMaterial({
        ...(existing || {}),
        materialId,
        id: materialId,
        group: "Little Greene",
        manufacturer: "Little Greene",
        product: [retail.product, size].filter(Boolean).join(" · "),
        productLine: retail.product,
        unit: "Stk",
        purchasePrice: number(article?.purchasePrice),
        salePrice,
        fixedSalePrice: true,
        priceValidFrom: sourceDate,
        priceCheckedAt: sourceDate,
        priceSource: `Little Greene · EK Basis ${base || "fehlt"}`,
        priceSourceId: stockCode,
        supplier: linked.supplier || "Little Greene",
        supplierId: linked.supplierId,
        wwSupplierAddressId: linked.wwSupplierAddressId,
        wwSupplierNumber: linked.wwSupplierNumber,
        ourCustomerNumberAtSupplier: linked.ourCustomerNumberAtSupplier,
        supplierAliases: linked.supplierAliases || ["LG", "Little Greene"],
        supplierArticleNumber: stockCode,
        manufacturerArticleNumber: clean(article?.ean, 100),
        articleNumber: stockCode,
        alias: [existing?.alias, article?.ean, base, article?.baseCode, size, "Hi White", "High White"].filter(Boolean).join(" "),
        active: true,
        regieItem: true,
        sourceSystem: "LittleGreene",
        sourceId,
        sourceLinks: normalizeSourceLinks([...(existing?.sourceLinks || []), { system: "LittleGreene", id: sourceId }]),
        sourceUpdatedAt: article?.updatedAt || rebuiltAt,
        sourceSheet: "LG-VK-Liste · EK Hi White",
        status: "approved",
        mergedInto: "",
        mergedAt: "",
        createdAt: existing?.createdAt || rebuiltAt,
      }, { sheetName: "LG-Lagerstamm", importedAt: rebuiltAt });
      if (index === undefined) {
        materials.push(rebuilt);
        directById.set(materialId.toLowerCase(), materials.length - 1);
        directBySource.set(sourceId, materials.length - 1);
        added += 1;
      } else {
        materials[index] = rebuilt;
        updated += 1;
      }
    }

    await writeJson(MATERIALS_FILE, materials);
    return { ok: true, total: retailRows.length, added, updated, deactivated, missingEk, fallbackBasis, backupName, rebuiltAt };
  }

  function createMaterialId(material, index = 0) {
    const prefix = slug(material.manufacturer || material.group || "MAT").slice(0, 4).toUpperCase() || "MAT";
    const product = slug(material.product || material.subgroup || "artikel").slice(0, 16).toUpperCase() || "ARTIKEL";
    const color = slug(material.colorNumber || material.colorName || "").slice(0, 10).toUpperCase();
    const size = String(material.containerSize || "").replace(/[^0-9a-z]/gi, "").slice(0, 8);
    return [prefix, product, color, size, index ? String(index) : ""].filter(Boolean).join("-");
  }

  function normalizeSourceLinks(value) {
    const links = Array.isArray(value) ? value : [];
    const unique = new Map();
    for (const raw of links) {
      const system = clean(raw?.system || raw?.sourceSystem, 40);
      const id = clean(raw?.id || raw?.sourceId, 120);
      if (!system || !id) continue;
      unique.set(`${system.toLowerCase()}:${id.toLowerCase()}`, { system, id });
    }
    return [...unique.values()];
  }

  function normalizeMaterial(raw, context = {}) {
    const now = new Date().toISOString();
    const group = clean(raw.group || context.sheetName || "Sonstiges", 100);
    const subgroup = clean(raw.subgroup, 100);
    const product = clean(raw.product, 180);
    const roomRequired = bool(raw.roomRequired);
    const componentRequired = bool(raw.componentRequired);
    const areaRequired = bool(raw.areaRequired);
    const locationMode = clean(raw.locationMode, 30) || inferLocationMode({
      group, subgroup, product, roomRequired, componentRequired, areaRequired,
    });

    const packageInfo = normalizePackage(raw.containerSize, raw.unit);

    const normalized = {
      id: clean(raw.id || raw.materialId, 120),
      materialId: clean(raw.materialId || raw.id, 120),
      group,
      subgroup,
      manufacturer: clean(raw.manufacturer, 120),
      articleNumber: clean(raw.articleNumber, 100),
      product,
      productLine: clean(raw.productLine, 120),
      colorNumber: clean(raw.colorNumber, 50),
      colorName: clean(raw.colorName, 140),
      containerSize: packageInfo.containerSize,
      unit: clean(packageInfo.unit, 30),
      purchasePrice: number(raw.purchasePrice),
      markup: number(raw.markup),
      overhead: number(raw.overhead),
      salePrice: number(raw.salePrice),
      fixedSalePrice: bool(raw.fixedSalePrice),
      priceValidFrom: dateISO(raw.priceValidFrom),
      priceCheckedAt: dateISO(raw.priceCheckedAt),
      priceSource: clean(raw.priceSource, 80),
      priceSourceId: clean(raw.priceSourceId, 160),
      stock: number(raw.stock),
      minimumStock: number(raw.minimumStock),
      storageLocation: clean(raw.storageLocation, 120),
      supplier: clean(raw.supplier, 120),
      supplierArticleNumber: clean(raw.supplierArticleNumber, 100),
      supplierId: clean(raw.supplierId, 160),
      wwSupplierAddressId: clean(raw.wwSupplierAddressId, 120),
      wwSupplierNumber: clean(raw.wwSupplierNumber, 80),
      ourCustomerNumberAtSupplier: clean(raw.ourCustomerNumberAtSupplier, 80),
      supplierAliases: [...new Set((Array.isArray(raw.supplierAliases) ? raw.supplierAliases : []).map(value => clean(value, 120)).filter(Boolean))],
      manufacturerArticleNumber: clean(raw.manufacturerArticleNumber, 100),
      regieItem: bool(raw.regieItem, true),
      designRelevant: bool(raw.designRelevant),
      locationMode,
      roomRequired: locationMode === "room" || roomRequired,
      componentRequired: locationMode === "component" || componentRequired,
      areaRequired: locationMode === "area" || areaRequired,
      photoRequired: bool(raw.photoRequired),
      labelPhotoRequired: bool(raw.labelPhotoRequired),
      extraQuestion: clean(raw.extraQuestion, 250),
      alias: clean(raw.alias, 1000),
      active: bool(raw.active, true),
      note: clean(raw.note, 1000),
      sourceSystem: clean(raw.sourceSystem, 40),
      sourceId: clean(raw.sourceId, 120),
      sourceLinks: normalizeSourceLinks(raw.sourceLinks),
      mergedInto: clean(raw.mergedInto, 120),
      mergedAt: raw.mergedAt || "",
      sourceUpdatedAt: raw.sourceUpdatedAt || "",
      sourceSheet: clean(raw.sourceSheet || context.sheetName, 100),
      status: clean(raw.status, 30) || "approved",
      createdAt: raw.createdAt || now,
      updatedAt: now,
      lastImportedAt: context.importedAt || raw.lastImportedAt || "",
    };

    if (!normalized.materialId) normalized.materialId = createMaterialId(normalized, context.index);
    normalized.id = normalized.materialId;
    normalized.searchText = [
      normalized.materialId,
      normalized.group,
      normalized.subgroup,
      normalized.manufacturer,
      normalized.product,
      normalized.productLine,
      normalized.colorNumber,
      normalized.colorName,
      normalized.supplier,
      normalized.supplierArticleNumber,
      normalized.wwSupplierNumber,
      normalized.ourCustomerNumberAtSupplier,
      normalized.manufacturerArticleNumber,
      normalized.articleNumber,
      normalized.alias,
    ].join(" ").toLowerCase();
    normalized.searchTextCompact = normalized.searchText.replace(/[^a-z0-9]/g, "");

    return normalized;
  }

  function matchesMaterialQuery(item, rawQuery) {
    const query = clean(rawQuery, 200).toLowerCase();
    if (!query) return true;
    const haystack = [
      item.searchText,
      item.materialId,
      item.articleNumber,
      item.product,
      item.supplier,
      item.supplierArticleNumber,
      item.alias,
    ].join(" ").toLowerCase();
    const compactQuery = query.replace(/[^a-z0-9]/g, "");
    const compactHaystack = String(item.searchTextCompact || haystack.replace(/[^a-z0-9]/g, ""));
    return haystack.includes(query) || Boolean(compactQuery && compactHaystack.includes(compactQuery));
  }

  function rowToMaterial(row, context) {
    const raw = {
      materialId: findValue(row, "materialId"),
      group: findValue(row, "group") || context.sheetName,
      subgroup: findValue(row, "subgroup"),
      manufacturer: findValue(row, "manufacturer"),
      articleNumber: findValue(row, "articleNumber"),
      product: findValue(row, "product"),
      productLine: findValue(row, "productLine"),
      colorNumber: findValue(row, "colorNumber"),
      colorName: findValue(row, "colorName"),
      containerSize: findValue(row, "containerSize"),
      unit: findValue(row, "unit"),
      purchasePrice: findValue(row, "purchasePrice"),
      markup: findValue(row, "markup"),
      overhead: findValue(row, "overhead"),
      salePrice: findValue(row, "salePrice"),
      fixedSalePrice: findValue(row, "fixedSalePrice"),
      priceValidFrom: findValue(row, "priceValidFrom"),
      priceCheckedAt: findValue(row, "priceCheckedAt"),
      stock: findValue(row, "stock"),
      minimumStock: findValue(row, "minimumStock"),
      storageLocation: findValue(row, "storageLocation"),
      supplier: findValue(row, "supplier"),
      supplierArticleNumber: findValue(row, "supplierArticleNumber"),
      wwSupplierAddressId: findValue(row, "wwSupplierAddressId"),
      wwSupplierNumber: findValue(row, "wwSupplierNumber"),
      ourCustomerNumberAtSupplier: findValue(row, "ourCustomerNumberAtSupplier"),
      manufacturerArticleNumber: findValue(row, "manufacturerArticleNumber"),
      regieItem: findValue(row, "regieItem"),
      designRelevant: findValue(row, "designRelevant"),
      locationMode: findValue(row, "locationMode"),
      roomRequired: findValue(row, "roomRequired"),
      componentRequired: findValue(row, "componentRequired"),
      areaRequired: findValue(row, "areaRequired"),
      photoRequired: findValue(row, "photoRequired"),
      labelPhotoRequired: findValue(row, "labelPhotoRequired"),
      extraQuestion: findValue(row, "extraQuestion"),
      alias: findValue(row, "alias"),
      active: findValue(row, "active"),
      note: findValue(row, "note"),
      sourceSheet: context.sheetName,
    };
    const material = normalizeMaterial(raw, context);
    material.importAction = clean(findValue(row, "importAction"), 1).toUpperCase();
    material._importFields = Object.keys(raw).filter(field => field !== "sourceSheet" && hasField(row, field));
    return material;
  }

  function hasUsableContent(material) {
    return Boolean(
      material.product ||
      material.materialId ||
      material.colorNumber ||
      material.colorName
    );
  }

  function priceAgeDays(material, today = new Date()) {
    const date = material.priceCheckedAt || material.priceValidFrom;
    if (!date) return null;
    const parsed = new Date(`${date}T12:00:00`);
    if (Number.isNaN(parsed.getTime())) return null;
    return Math.floor((today.getTime() - parsed.getTime()) / 86400000);
  }

  function decorate(material) {
    const age = priceAgeDays(material);
    const staleLevel = age === null ? "unknown" : age > 730 ? "red" : age > 365 ? "yellow" : "green";
    const margin = Number(material.salePrice || 0) - Number(material.purchasePrice || 0);
    const markupPercent = material.purchasePrice > 0 ? (margin / material.purchasePrice) * 100 : null;
    return {
      ...material,
      priceAgeDays: age,
      priceStale: age === null || age > 365,
      priceStaleLevel: staleLevel,
      materialYield: Math.round((margin + Number.EPSILON) * 100) / 100,
      markupPercent: markupPercent === null ? null : Math.round(markupPercent * 10) / 10,
    };
  }

  function buildSummary(materials, inbox) {
    const active = materials.filter(item => item.active !== false);
    const stale = active.filter(item => decorate(item).priceStale);
    const byGroup = {};
    const bySupplier = {};
    for (const item of active) {
      byGroup[item.group || "Sonstiges"] = (byGroup[item.group || "Sonstiges"] || 0) + 1;
    }
    for (const supplier of supplierGroups(active)) {
      bySupplier[supplier.name] = supplier.materialCount;
    }
    const withoutSupplier = active.filter(item => !clean(item.supplier, 120)).length;
    if (withoutSupplier) bySupplier["Ohne Lieferant"] = withoutSupplier;
    return {
      count: materials.length,
      activeCount: active.length,
      inactiveCount: materials.length - active.length,
      stalePriceCount: stale.length,
      unknownPriceCount: active.filter(item => priceAgeDays(item) === null).length,
      inboxOpenCount: inbox.filter(item => item.status === "open").length,
      byGroup,
      bySupplier,
      dataStatus: active
        .map(item => item.priceCheckedAt || item.priceValidFrom)
        .filter(Boolean)
        .sort()
        .at(-1) || "",
    };
  }

  async function importWorkbook(buffer, filename = "Material.xlsx") {
    if (!XLSX) {
      throw new Error('Excel-Import benötigt das Paket "xlsx". Bitte einmal "npm install xlsx" ausführen.');
    }

    const importedAt = new Date().toISOString();
    const workbook = XLSX.read(buffer, {
      type: "buffer",
      cellDates: true,
      raw: false,
    });

    const incoming = [];
    const supplierLinks = await readJson(SUPPLIERS_FILE, []);
    const skippedSheets = [];
    for (const sheetName of workbook.SheetNames) {
      if (/hinweis|warn|legende|kategorie|einstellung/i.test(sheetName)) {
        skippedSheets.push(sheetName);
        continue;
      }
      const sheet = workbook.Sheets[sheetName];
      const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
      const headerIndex = matrix.findIndex(row => Array.isArray(row) && row.some(cell => normalizeHeader(cell) === "material id"));
      if (headerIndex < 0) { skippedSheets.push(sheetName); continue; }
      const headers = matrix[headerIndex].map(value => clean(value, 120));
      const rows = matrix.slice(headerIndex + 1).map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
      rows.forEach((row, index) => {
        const material = applySupplierLink(rowToMaterial(row, {
          sheetName,
          index: index + 1,
          importedAt,
        }), supplierLinks);
        if (hasUsableContent(material)) incoming.push(material);
      });
    }

    const current = await readJson(MATERIALS_FILE, []);
    const currentById = new Map(current.map(item => [String(item.materialId || item.id), item]));
    const currentByKey = new Map(current.map(item => [materialKey(item), item]));

    let added = 0;
    let changed = 0;
    let unchanged = 0;
    let deactivated = 0;
    const duplicates = [];
    const seenIncoming = new Set();
    const merged = [...current];

    for (const material of incoming) {
      const duplicateKey = `${material.materialId}|${materialKey(material)}`;
      if (seenIncoming.has(duplicateKey)) {
        duplicates.push({
          sheet: material.sourceSheet,
          materialId: material.materialId,
          product: material.product,
          colorNumber: material.colorNumber,
        });
        continue;
      }
      seenIncoming.add(duplicateKey);

      const existing =
        currentById.get(material.materialId) ||
        currentByKey.get(materialKey(material));

      if (!existing) {
        if (material.importAction === "L") continue;
        const created = normalizeMaterial({ ...material, active: true }, { sheetName: material.sourceSheet, importedAt });
        delete created.importAction;
        delete created._importFields;
        merged.push(created);
        currentById.set(created.materialId, created);
        currentByKey.set(materialKey(created), created);
        added += 1;
        continue;
      }

      const index = merged.findIndex(item =>
        String(item.materialId || item.id) === String(existing.materialId || existing.id)
      );
      const importedFields = new Set(material._importFields || []);
      const importedValues = {};
      for (const field of importedFields) importedValues[field] = material[field];
      if (["B", "N", "L"].includes(material.importAction)) importedValues.active = material.importAction !== "L";
      const updated = normalizeMaterial({
        ...existing,
        ...importedValues,
        materialId: existing.materialId || material.materialId,
        id: existing.materialId || material.materialId,
        createdAt: existing.createdAt || material.createdAt,
      }, {
        sheetName: material.sourceSheet,
        importedAt,
      });

      const before = JSON.stringify({
        ...existing,
        updatedAt: undefined,
        lastImportedAt: undefined,
        searchText: undefined,
      });
      const after = JSON.stringify({
        ...updated,
        updatedAt: undefined,
        lastImportedAt: undefined,
        searchText: undefined,
      });

      if (before === after) {
        unchanged += 1;
      } else {
        merged[index] = updated;
        if (existing.active !== false && updated.active === false) deactivated += 1;
        changed += 1;
      }
    }

    await writeJson(MATERIALS_FILE, merged);

    const imports = await readJson(IMPORTS_FILE, []);
    const report = {
      id: `import_${Date.now()}`,
      filename,
      importedAt,
      sheets: workbook.SheetNames,
      skippedSheets,
      rowsRead: incoming.length,
      added,
      changed,
      unchanged,
      duplicateCount: duplicates.length,
      deactivated,
      duplicates: duplicates.slice(0, 100),
      materialCountAfterImport: merged.length,
    };
    imports.push(report);
    await writeJson(IMPORTS_FILE, imports.slice(-100));

    return report;
  }

  async function exportWorkbook(filters = {}) {
    if (!XLSX) {
      throw new Error('Excel-Export benötigt das Paket "xlsx". Bitte einmal "npm install xlsx" ausführen.');
    }

    await syncLittleGreenePrices();
    const allMaterials = withCanonicalSupplierNames(await readJson(MATERIALS_FILE, []));
    const query = clean(filters.q, 200).toLowerCase();
    const group = clean(filters.group, 100);
    const supplier = clean(filters.supplier, 120);
    const materials = allMaterials
      .filter(material => material.active !== false)
      .filter(material => !group || material.group === group)
      .filter(material => matchesSupplierFilter(material, supplier))
      .filter(material => !query || matchesMaterialQuery(material, query));

    const workbook = XLSX.utils.book_new();
    const headers = [
      "Status B/N/L", "Material-ID", "Lieferant", "Lieferanten-Artikelnummer", "Artikel",
      "Einheit", "EK netto (€)", "VK netto (€)", "VK brutto (€)", "Fix-VK", "Preisstand",
      "WW-Stammindex", "WW-Lieferantennummer", "Unsere Kundennummer",
    ];
    const data = materials
      .sort((a, b) => String(a.supplier || "").localeCompare(String(b.supplier || ""), "de") || String(a.product || "").localeCompare(String(b.product || ""), "de"))
      .map(item => ({
        "Status B/N/L": "B",
        "Material-ID": item.materialId,
        "Lieferant": item.supplier,
        "Lieferanten-Artikelnummer": item.supplierArticleNumber,
        "Artikel": item.product,
        "Einheit": item.unit,
        "EK netto (€)": item.purchasePrice || "",
        "VK netto (€)": item.salePrice || "",
        "VK brutto (€)": item.salePrice ? Math.round(item.salePrice * 120) / 100 : "",
        "Fix-VK": item.fixedSalePrice === true ? "Ja" : "Nein",
        "Preisstand": item.priceCheckedAt || item.priceValidFrom,
        "WW-Stammindex": item.wwSupplierAddressId || "",
        "WW-Lieferantennummer": item.wwSupplierNumber || "",
        "Unsere Kundennummer": item.ourCustomerNumberAtSupplier || "",
      }));
    for (let i = 0; i < 30; i += 1) data.push({ "Status B/N/L": "N", "Lieferant": supplier === "Ohne Lieferant" ? "" : supplier });
    const worksheet = XLSX.utils.json_to_sheet(data, { header: headers });
    worksheet["!freeze"] = { xSplit: 0, ySplit: 1 };
    worksheet["!autofilter"] = { ref: worksheet["!ref"] };
    worksheet["!cols"] = [12, 22, 22, 25, 42, 12, 15, 15, 15, 11, 15, 18, 22, 22].map(wch => ({ wch }));
    XLSX.utils.book_append_sheet(workbook, worksheet, "Materialpreisliste");

    const warningRows = materials.map(decorate).filter(item => item.priceStale).map(item => ({
      "Material-ID": item.materialId,
      "Artikel": item.product,
      "Lieferant": item.supplier,
      "Preisstand": item.priceCheckedAt || item.priceValidFrom || "fehlt",
      "Warnung": item.priceAgeDays === null ? "Kein Preisstand" : `Preis ${item.priceAgeDays} Tage alt`,
    }));
    const warningSheet = XLSX.utils.json_to_sheet(warningRows.length ? warningRows : [{ Warnung: "Keine Preiswarnungen" }]);
    warningSheet["!autofilter"] = { ref: warningSheet["!ref"] };
    warningSheet["!cols"] = [22, 42, 22, 15, 24].map(wch => ({ wch }));
    XLSX.utils.book_append_sheet(workbook, warningSheet, "Warnliste");

    const info = [
      ["KRISTINE Materialdatenbank"],
      ["Exportiert am", new Date().toISOString()],
      ["Aktive Materialien", materials.length],
      ["Lieferant", supplier || "Alle Lieferanten"],
      ["Gruppe", group || "Alle Gruppen"],
      ["Suche", query || "Keine"],
      ["Hinweis", "B = Bestand, N = neu, L = stilllegen. Material-ID bestehender Artikel nie ändern."],
      ["Preise", "Preise in bereits gespeicherten Dokumenten bleiben unverändert; der Stamm wird nur beim Einfügen kopiert."],
    ];
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(info), "Hinweise");

    return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  }

  async function syncWinWorkerMaterials(rawRows = [], options = {}) {
    if (!Array.isArray(rawRows)) throw new Error("WW-Materialliste fehlt");
    if (!rawRows.length) throw new Error("WW-Materialliste ist leer; Abgleich abgebrochen");
    if (rawRows.length > 50000) throw new Error("WW-Materialliste ist unerwartet groß");

    const importedAt = new Date().toISOString();
    const [current, supplierLinks] = await Promise.all([
      readJson(MATERIALS_FILE, []),
      readJson(SUPPLIERS_FILE, []),
    ]);
    const merged = [...current];
    const currentBySource = new Map();
    const currentById = new Map();
    for (const item of current) {
      currentById.set(String(item.materialId || item.id), item);
      if (String(item.sourceSystem || "").toLowerCase() === "winworker" && item.sourceId) {
        currentBySource.set(String(item.sourceId), item);
      }
    }
    for (const item of current) {
      for (const link of normalizeSourceLinks(item.sourceLinks)) {
        if (link.system.toLowerCase() === "winworker") currentBySource.set(link.id, item);
      }
    }

    let added = 0;
    let changed = 0;
    let unchanged = 0;
    let deactivated = 0;
    const seen = new Set();

    for (const raw of rawRows) {
      const sourceId = clean(raw?.sourceId || raw?.number || raw?.materialId, 120);
      const requestedMaterialId = clean(raw?.materialId, 120);
      const product = clean(raw?.product || raw?.shortText || raw?.name, 180);
      if (!sourceId || !product || seen.has(sourceId)) continue;
      seen.add(sourceId);

      const existing = currentBySource.get(sourceId) || currentById.get(requestedMaterialId) || currentById.get(sourceId);
      const purchasePrice = number(raw?.purchasePrice ?? raw?.ek);
      const salePrice = number(raw?.salePrice ?? raw?.vk);
      const calculatedMarkup = purchasePrice > 0 && salePrice > 0
        ? Math.round((((salePrice / purchasePrice) - 1) * 100 + Number.EPSILON) * 100) / 100
        : number(existing?.markup);
      const aliases = [...new Set([
        raw?.matchCode,
        raw?.orderNumber,
        raw?.supplierArticleNumber,
        raw?.directory,
        String(existing?.sourceSystem || "").toLowerCase() === "winworker" ? "" : existing?.alias,
      ].map(value => clean(value, 250)).filter(Boolean))].join(" ");

      const linkedRaw = applySupplierLink({
        supplier: clean(raw?.supplier, 120) || existing?.supplier,
        supplierAliases: existing?.supplierAliases,
      }, supplierLinks);
      const keepPrimarySource = existing?.sourceSystem && String(existing.sourceSystem).toLowerCase() !== "winworker";
      const sourceLinks = normalizeSourceLinks([
        ...(existing?.sourceLinks || []),
        { system: "WinWorker", id: sourceId },
      ]);
      const updated = normalizeMaterial({
        ...(existing || {}),
        materialId: existing?.materialId || requestedMaterialId || sourceId,
        id: existing?.materialId || requestedMaterialId || sourceId,
        articleNumber: sourceId,
        group: clean(raw?.group || raw?.directory, 100) || existing?.group || "WinWorker",
        manufacturer: clean(raw?.manufacturer, 120) || existing?.manufacturer,
        product,
        unit: clean(raw?.unit, 30) || existing?.unit || "Stk",
        purchasePrice,
        salePrice,
        markup: calculatedMarkup,
        supplier: linkedRaw.supplier,
        supplierId: linkedRaw.supplierId || existing?.supplierId,
        wwSupplierAddressId: linkedRaw.wwSupplierAddressId || existing?.wwSupplierAddressId,
        wwSupplierNumber: linkedRaw.wwSupplierNumber || existing?.wwSupplierNumber,
        ourCustomerNumberAtSupplier: linkedRaw.ourCustomerNumberAtSupplier || existing?.ourCustomerNumberAtSupplier,
        supplierAliases: linkedRaw.supplierAliases || existing?.supplierAliases,
        supplierArticleNumber: clean(raw?.supplierArticleNumber || raw?.orderNumber, 100),
        priceValidFrom: raw?.priceCheckedAt || raw?.priceValidFrom,
        priceCheckedAt: raw?.priceCheckedAt || raw?.priceValidFrom,
        alias: aliases,
        active: raw?.active === false ? false : existing ? existing.active !== false : true,
        regieItem: existing?.regieItem ?? true,
        sourceSystem: keepPrimarySource ? existing.sourceSystem : "WinWorker",
        sourceId: keepPrimarySource ? existing.sourceId : sourceId,
        sourceLinks,
        sourceUpdatedAt: raw?.sourceUpdatedAt || raw?.priceCheckedAt || importedAt,
        sourceSheet: "WinWorker",
        status: "approved",
        createdAt: existing?.createdAt || importedAt,
      }, { sheetName: "WinWorker", importedAt });

      if (!existing) {
        merged.push(updated);
        currentById.set(updated.materialId, updated);
        currentBySource.set(sourceId, updated);
        added += 1;
        continue;
      }

      const index = merged.findIndex(item => String(item.materialId || item.id) === String(existing.materialId || existing.id));
      const before = JSON.stringify({ ...existing, updatedAt: undefined, lastImportedAt: undefined, searchText: undefined, searchTextCompact: undefined });
      const after = JSON.stringify({ ...updated, updatedAt: undefined, lastImportedAt: undefined, searchText: undefined, searchTextCompact: undefined });
      if (before === after) unchanged += 1;
      else {
        merged[index] = updated;
        changed += 1;
      }
    }

    if (options.deactivateMissing !== false) {
      for (let index = 0; index < merged.length; index += 1) {
        const item = merged[index];
        if (String(item.sourceSystem || "").toLowerCase() !== "winworker" || !item.sourceId || seen.has(String(item.sourceId)) || item.active === false) continue;
        merged[index] = normalizeMaterial({ ...item, active: false, createdAt: item.createdAt });
        deactivated += 1;
      }
    }

    await writeJson(MATERIALS_FILE, merged);
    const report = {
      id: `winworker_${Date.now()}`,
      filename: "Direktabgleich WinWorker",
      importedAt,
      rowsRead: rawRows.length,
      added,
      changed,
      unchanged,
      deactivated,
      materialCountAfterImport: merged.length,
      source: "WinWorker_Stammdaten_Standard",
    };
    const imports = await readJson(IMPORTS_FILE, []);
    imports.push(report);
    await writeJson(IMPORTS_FILE, imports.slice(-100));
    return report;
  }

  // ---------- Oberfläche ----------
  app.get("/admin/material", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const file = path.join(publicDir || path.join(process.cwd(), "public"), "material-admin.html");
    if (!fs.existsSync(file)) return res.status(404).send("material-admin.html fehlt");
    res.sendFile(file);
  });

  // ---------- Datenbank ----------
  app.get("/admin/api/materials", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      await syncLittleGreenePrices();
      const [materials, inbox] = await Promise.all([
        readJson(MATERIALS_FILE, []),
        readJson(INBOX_FILE, []),
      ]);
      const query = clean(req.query.q, 200).toLowerCase();
      const group = clean(req.query.group, 100);
      const subgroup = clean(req.query.subgroup, 100);
      const supplier = clean(req.query.supplier, 120);
      const activeOnly = String(req.query.activeOnly || "1") !== "0";
      const staleOnly = String(req.query.staleOnly || "0") === "1";
      const mode = clean(req.query.mode, 30);

      let rows = withCanonicalSupplierNames(materials);
      if (activeOnly) rows = rows.filter(item => item.active !== false);
      if (group) rows = rows.filter(item => item.group === group);
      if (subgroup) rows = rows.filter(item => item.subgroup === subgroup);
      if (supplier) rows = rows.filter(item => matchesSupplierFilter(item, supplier));
      if (query) {
        rows = rows.filter(item => matchesMaterialQuery(item, query));
      }
      if (mode === "project") rows = rows.filter(item => item.designRelevant === true);
      // Regie zeigt bewusst den gesamten aktiven Materialstamm.
      if (mode === "regie") rows = rows.filter(item => item.active !== false);
      rows = rows.map(decorate);
      if (staleOnly) rows = rows.filter(item => item.priceStale);

      res.json({
        ok: true,
        materials: rows.slice(0, Math.min(5000, Math.max(1, Number(req.query.limit || 500)))),
        summary: buildSummary(materials, inbox),
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/admin/api/material-suppliers", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const materials = await readJson(MATERIALS_FILE, []);
      res.json({ ok: true, suppliers: supplierGroups(materials) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/admin/api/material-suppliers/link-winworker", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const localKey = clean(req.body?.localKey, 220);
      const localName = clean(req.body?.localName, 120);
      const ww = req.body?.wwSupplier || {};
      const wwAddressId = clean(ww.addressId, 120);
      const canonicalName = clean(ww.name, 120);
      if ((!localKey && !localName) || !wwAddressId || !canonicalName) {
        return res.status(400).json({ ok: false, error: "Lieferant und WinWorker-Zuordnung fehlen." });
      }

      const [materials, storedLinks] = await Promise.all([
        readJson(MATERIALS_FILE, []),
        readJson(SUPPLIERS_FILE, []),
      ]);
      const targetFingerprint = localKey.startsWith("local:") ? localKey.slice(6) : supplierFingerprint(localName);
      const supplierId = `ww:${wwAddressId}`;
      const targetIndexes = [];
      const aliases = new Set([canonicalName, localName]);
      materials.forEach((item, index) => {
        const sameLocalGroup = supplierFingerprint(item.supplier) === targetFingerprint;
        const sameStoredGroup = clean(item.supplierId, 160) === localKey;
        const sameWwSupplier = clean(item.wwSupplierAddressId, 120) === wwAddressId;
        if (!sameLocalGroup && !sameStoredGroup && !sameWwSupplier) return;
        targetIndexes.push(index);
        if (item.supplier) aliases.add(clean(item.supplier, 120));
        for (const alias of item.supplierAliases || []) if (alias) aliases.add(clean(alias, 120));
      });
      if (!targetIndexes.length) return res.status(404).json({ ok: false, error: "Lokaler Lieferant wurde nicht gefunden." });

      const existingLink = storedLinks.find(link => clean(link.wwAddressId, 120) === wwAddressId);
      for (const alias of existingLink?.aliases || []) if (alias) aliases.add(clean(alias, 120));
      const aliasList = [...aliases].filter(Boolean).sort((a, b) => a.localeCompare(b, "de"));
      const link = {
        id: supplierId,
        name: canonicalName,
        aliases: aliasList,
        wwAddressId,
        wwSupplierNumber: clean(ww.supplierNumber, 80),
        ourCustomerNumber: clean(ww.ourCustomerNumber, 80),
        address: clean(ww.address, 300),
        updatedAt: new Date().toISOString(),
      };
      for (const index of targetIndexes) {
        materials[index] = normalizeMaterial({
          ...materials[index],
          supplier: canonicalName,
          supplierId,
          wwSupplierAddressId: wwAddressId,
          wwSupplierNumber: link.wwSupplierNumber,
          ourCustomerNumberAtSupplier: link.ourCustomerNumber,
          supplierAliases: aliasList,
          createdAt: materials[index].createdAt,
        });
      }
      const links = storedLinks.filter(item => clean(item.wwAddressId, 120) !== wwAddressId && clean(item.id, 160) !== localKey);
      links.push(link);
      await Promise.all([writeJson(MATERIALS_FILE, materials), writeJson(SUPPLIERS_FILE, links)]);
      res.json({ ok: true, supplier: link, updatedMaterials: targetIndexes.length });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  // ---------- KRISTINE Regie: Materialstamm nur lesend ----------
app.get("/api/regie/materials", async (req, res) => {
  try {
    await syncLittleGreenePrices();
    const materials = await readJson(MATERIALS_FILE, []);

    let rows = withCanonicalSupplierNames(materials).filter((item) => item.active !== false);
    rows = rows.map(decorate);

    res.json({
      ok: true,
      materials: rows.slice(0, 5000),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error?.message || error),
    });
  }
});

  // Statische Unterseiten müssen vor /:materialId stehen, sonst liest Express
  // z. B. "export-excel" fälschlich als Material-ID.
  app.get("/admin/api/materials/export-excel", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const supplier = clean(req.query.supplier, 120);
      const buffer = await exportWorkbook({
        q: req.query.q,
        group: req.query.group,
        supplier,
      });
      const date = new Date().toISOString().slice(0, 10);
      const suffix = supplier ? `_${slug(supplier) || "ohne-lieferant"}` : "";
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="KRISTINE_Materialstamm${suffix}_${date}.xlsx"`);
      res.send(buffer);
    } catch (error) {
      res.status(500).send(String(error?.message || error));
    }
  });

  app.get("/admin/api/materials/imports", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ ok: true, imports: await readJson(IMPORTS_FILE, []) });
  });

  app.post("/admin/api/materials/sync-winworker", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const report = await syncWinWorkerMaterials(req.body?.materials || []);
      res.json({ ok: true, report });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/admin/api/materials/import-winworker", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const report = await syncWinWorkerMaterials([req.body?.material], { deactivateMissing: false });
      res.json({ ok: true, report });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/admin/api/materials/rebuild-little-greene", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      res.json(await rebuildLittleGreeneMaterials());
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/admin/api/materials/:materialId/merge", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const rows = await readJson(MATERIALS_FILE, []);
      const sourceIndex = rows.findIndex(item => String(item.materialId) === String(req.params.materialId));
      const targetId = clean(req.body?.targetMaterialId, 120);
      const targetIndex = rows.findIndex(item => String(item.materialId) === targetId);
      if (sourceIndex < 0) return res.status(404).json({ ok: false, error: "Ausgangsmaterial nicht gefunden." });
      if (targetIndex < 0 || rows[targetIndex].active === false) return res.status(404).json({ ok: false, error: "Zielmaterial nicht gefunden." });
      if (sourceIndex === targetIndex) return res.status(400).json({ ok: false, error: "Ein Material kann nicht mit sich selbst zusammengeführt werden." });

      const source = rows[sourceIndex];
      const target = rows[targetIndex];
      const sourceLinks = normalizeSourceLinks([
        ...(target.sourceLinks || []),
        ...(source.sourceLinks || []),
        source.sourceSystem && source.sourceId ? { system: source.sourceSystem, id: source.sourceId } : null,
        { system: "WinWorker", id: source.materialId },
      ]);
      const aliases = [...new Set([
        target.alias, source.materialId, source.product, source.alias, source.articleNumber, source.supplierArticleNumber,
      ].map(value => clean(value, 250)).filter(Boolean))].join(" ");
      const mergedAt = new Date().toISOString();
      rows[targetIndex] = normalizeMaterial({
        ...target,
        purchasePrice: number(target.purchasePrice) || number(source.purchasePrice),
        salePrice: number(target.salePrice) || number(source.salePrice),
        fixedSalePrice: target.fixedSalePrice === true || source.fixedSalePrice === true,
        priceCheckedAt: target.priceCheckedAt || source.priceCheckedAt,
        priceValidFrom: target.priceValidFrom || source.priceValidFrom,
        alias: aliases,
        sourceLinks,
        active: true,
        createdAt: target.createdAt,
      });
      rows[sourceIndex] = normalizeMaterial({
        ...source,
        active: false,
        mergedInto: target.materialId,
        mergedAt,
        createdAt: source.createdAt,
      });
      await writeJson(MATERIALS_FILE, rows);
      res.json({ ok: true, sourceMaterialId: source.materialId, material: decorate(rows[targetIndex]) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.get("/admin/api/materials/:materialId", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const rows = await readJson(MATERIALS_FILE, []);
    const material = rows.find(item => String(item.materialId) === String(req.params.materialId));
    if (!material) return res.status(404).json({ ok: false, error: "Material nicht gefunden" });
    res.json({ ok: true, material: decorate(material) });
  });

  app.post("/admin/api/materials/auto", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const product = clean(req.body?.name || req.body?.product, 180);
      if (!product) return res.status(400).json({ ok: false, error: "Materialname fehlt" });
      const rows = await readJson(MATERIALS_FILE, []);
      const requestedMaterialId = clean(req.body?.materialId, 120);
      if (requestedMaterialId && rows.some(item => String(item.materialId).toLocaleLowerCase("de") === requestedMaterialId.toLocaleLowerCase("de"))) {
        return res.status(409).json({ ok: false, error: `ID / Kürzel ${requestedMaterialId} ist bereits vergeben.` });
      }
      const normalizedName = product.toLocaleLowerCase("de");
      const existing = rows.find(item =>
        clean(item.product, 180).toLocaleLowerCase("de") === normalizedName ||
        clean(item.materialId, 120).toLocaleLowerCase("de") === normalizedName
      );
      if (existing) return res.json({ ok: true, created: false, material: decorate(existing) });
      const supplierLinks = await readJson(SUPPLIERS_FILE, []);
      const material = normalizeMaterial(applySupplierLink({
        materialId: requestedMaterialId,
        id: requestedMaterialId,
        group: req.body?.group || "Regie",
        product,
        unit: req.body?.unit,
        purchasePrice: req.body?.purchasePrice ?? req.body?.unitPrice,
        markup: req.body?.markup,
        salePrice: req.body?.salePrice,
        fixedSalePrice: req.body?.fixedSalePrice,
        supplier: req.body?.supplier,
        supplierArticleNumber: req.body?.supplierArticleNumber,
        priceValidFrom: req.body?.priceValidFrom,
        priceCheckedAt: req.body?.priceCheckedAt || new Date().toISOString().slice(0, 10),
        active: true,
        regieItem: true,
        note: req.body?.note || "Direkt bei einer Regiebericht-Erfassung angelegt",
        sourceSheet: req.body?.sourceSheet || "KRISTINE Regie",
      }, supplierLinks), { index: rows.length + 1 });
      while (!requestedMaterialId && rows.some(item => String(item.materialId) === String(material.materialId))) {
        material.materialId = createMaterialId(material, rows.length + Math.floor(Math.random() * 10000));
        material.id = material.materialId;
      }
      rows.push(material);
      await writeJson(MATERIALS_FILE, rows);
      res.json({ ok: true, created: true, material: decorate(material) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.put("/admin/api/materials/:materialId", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const rows = await readJson(MATERIALS_FILE, []);
      const index = rows.findIndex(item => String(item.materialId) === String(req.params.materialId));
      if (index < 0) return res.status(404).json({ ok: false, error: "Material nicht gefunden" });

      const current = rows[index];
      const requestedMaterialId = clean(req.body?.materialId || current.materialId, 120);
      if (!requestedMaterialId) return res.status(400).json({ ok: false, error: "ID / Kürzel fehlt" });
      if (rows.some((item, rowIndex) => rowIndex !== index && String(item.materialId).toLocaleLowerCase("de") === requestedMaterialId.toLocaleLowerCase("de"))) {
        return res.status(409).json({ ok: false, error: `ID / Kürzel ${requestedMaterialId} ist bereits vergeben.` });
      }
      const supplierLinks = await readJson(SUPPLIERS_FILE, []);
      const material = normalizeMaterial(applySupplierLink({
        ...current,
        ...req.body,
        materialId: requestedMaterialId,
        id: requestedMaterialId,
        createdAt: current.createdAt,
      }, supplierLinks));
      rows[index] = material;
      await writeJson(MATERIALS_FILE, rows);
      res.json({ ok: true, material: decorate(material) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/admin/api/materials/:materialId/check-price", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const rows = await readJson(MATERIALS_FILE, []);
      const index = rows.findIndex(item => String(item.materialId) === String(req.params.materialId));
      if (index < 0) return res.status(404).json({ ok: false, error: "Material nicht gefunden" });

      rows[index] = normalizeMaterial({
        ...rows[index],
        purchasePrice: req.body?.purchasePrice ?? rows[index].purchasePrice,
        salePrice: req.body?.salePrice ?? rows[index].salePrice,
        priceValidFrom: req.body?.priceValidFrom ?? rows[index].priceValidFrom,
        priceCheckedAt: dateISO(req.body?.priceCheckedAt) || new Date().toISOString().slice(0, 10),
      });
      await writeJson(MATERIALS_FILE, rows);
      res.json({ ok: true, material: decorate(rows[index]) });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  // ---------- Excel ----------
  app.post("/admin/api/materials/import-excel", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const filename = clean(req.body?.filename || "Material.xlsx", 200);
      const base64 = String(req.body?.base64 || "").replace(/^data:.*?;base64,/, "");
      if (!base64) return res.status(400).json({ ok: false, error: "Excel-Datei fehlt" });
      const buffer = Buffer.from(base64, "base64");
      const report = await importWorkbook(buffer, filename);
      res.json({ ok: true, report });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  // ---------- Lernsystem / unbekannte Materialien ----------
  app.get("/admin/api/material-inbox", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const rows = await readJson(INBOX_FILE, []);
      const status = clean(req.query.status || "open", 30);
      res.json({
        ok: true,
        items: rows
          .filter(item => !status || item.status === status)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/kristine/api/material-unknown", async (req, res) => {
    // Mitarbeiter darf unbekanntes Material erfassen.
    // Kein requireAdmin: Der bestehende KRISTINE-Endpunkt authentifiziert
    // den Mitarbeiter bereits über seinen eigenen Ablauf.
    try {
      const rows = await readJson(INBOX_FILE, []);
      const now = new Date().toISOString();
      const item = {
        id: `unknown_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        status: "open",
        description: clean(req.body?.description, 500),
        quantity: number(req.body?.quantity),
        unit: clean(req.body?.unit, 30),
        groupSuggestion: clean(req.body?.groupSuggestion, 100),
        subgroupSuggestion: clean(req.body?.subgroupSuggestion, 100),
        manufacturerSuggestion: clean(req.body?.manufacturerSuggestion, 120),
        productSuggestion: clean(req.body?.productSuggestion, 180),
        colorNumberSuggestion: clean(req.body?.colorNumberSuggestion, 50),
        colorNameSuggestion: clean(req.body?.colorNameSuggestion, 140),
        jobId: clean(req.body?.jobId, 100),
        jobName: clean(req.body?.jobName, 180),
        employeeId: clean(req.body?.employeeId, 100),
        employeeName: clean(req.body?.employeeName, 180),
        date: clean(req.body?.date, 10),
        photoFile: clean(req.body?.photoFile, 500),
        regieEntryId: clean(req.body?.regieEntryId, 150),
        createdAt: now,
        updatedAt: now,
      };
      if (!item.description && !item.productSuggestion && !item.photoFile) {
        return res.status(400).json({ ok: false, error: "Beschreibung oder Foto fehlt" });
      }
      rows.push(item);
      await writeJson(INBOX_FILE, rows.slice(-5000));
      res.json({
        ok: true,
        item,
        message: "Material vorgemerkt. Bettina kann es später einmal sauber anlegen.",
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/admin/api/material-inbox/:itemId/approve", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const [inbox, materials] = await Promise.all([
        readJson(INBOX_FILE, []),
        readJson(MATERIALS_FILE, []),
      ]);
      const index = inbox.findIndex(item => String(item.id) === String(req.params.itemId));
      if (index < 0) return res.status(404).json({ ok: false, error: "Vormerkung nicht gefunden" });
      if (inbox[index].status !== "open") {
        return res.status(409).json({ ok: false, error: "Vormerkung wurde bereits bearbeitet" });
      }

      const source = inbox[index];
      const supplierLinks = await readJson(SUPPLIERS_FILE, []);
      const material = normalizeMaterial(applySupplierLink({
        group: req.body?.group || source.groupSuggestion,
        subgroup: req.body?.subgroup || source.subgroupSuggestion,
        manufacturer: req.body?.manufacturer || source.manufacturerSuggestion,
        product: req.body?.product || source.productSuggestion || source.description,
        productLine: req.body?.productLine,
        colorNumber: req.body?.colorNumber || source.colorNumberSuggestion,
        colorName: req.body?.colorName || source.colorNameSuggestion,
        containerSize: req.body?.containerSize,
        unit: req.body?.unit || source.unit,
        purchasePrice: req.body?.purchasePrice,
        salePrice: req.body?.salePrice,
        fixedSalePrice: req.body?.fixedSalePrice,
        priceValidFrom: req.body?.priceValidFrom,
        priceCheckedAt: req.body?.priceCheckedAt,
        stock: req.body?.stock,
        minimumStock: req.body?.minimumStock,
        storageLocation: req.body?.storageLocation,
        supplier: req.body?.supplier,
        regieItem: req.body?.regieItem ?? true,
        designRelevant: req.body?.designRelevant,
        locationMode: req.body?.locationMode,
        photoRequired: req.body?.photoRequired,
        active: true,
        note: req.body?.note,
        sourceSheet: req.body?.sourceSheet || req.body?.group || source.groupSuggestion || "Sonstiges",
        status: "approved",
      }, supplierLinks));

      const existing = materials.find(item =>
        String(item.materialId) === String(material.materialId) ||
        materialKey(item) === materialKey(material)
      );
      if (existing) {
        return res.status(409).json({
          ok: false,
          error: "Mögliches Duplikat",
          existing: decorate(existing),
        });
      }

      materials.push(material);
      source.status = "approved";
      source.materialId = material.materialId;
      source.approvedAt = new Date().toISOString();
      source.approvedBy = clean(req.body?.approvedBy || "Bettina / Büro", 120);
      source.updatedAt = source.approvedAt;

      await Promise.all([
        writeJson(MATERIALS_FILE, materials),
        writeJson(INBOX_FILE, inbox),
      ]);

      res.json({
        ok: true,
        material: decorate(material),
        inboxItem: source,
        message: "Gelernt. Dieses Material steht ab jetzt überall zur Verfügung.",
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/admin/api/material-inbox/:itemId/reject", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const rows = await readJson(INBOX_FILE, []);
      const item = rows.find(entry => String(entry.id) === String(req.params.itemId));
      if (!item) return res.status(404).json({ ok: false, error: "Vormerkung nicht gefunden" });
      item.status = "rejected";
      item.rejectionReason = clean(req.body?.reason, 500);
      item.updatedAt = new Date().toISOString();
      await writeJson(INBOX_FILE, rows);
      res.json({ ok: true, item });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  // ---------- Suchassistent ----------
  app.get("/kristine/api/material-search", async (req, res) => {
    try {
      await syncLittleGreenePrices();
      const materials = withCanonicalSupplierNames(await readJson(MATERIALS_FILE, []));
      const query = clean(req.query.q, 100).toLowerCase();
      const group = clean(req.query.group, 100);
      const rows = materials
        .filter(item => item.active !== false)
        .filter(item => !group || item.group === group)
        .filter(item => matchesMaterialQuery(item, query))
        .map(decorate)
        .sort((a, b) => {
          const aExactColor = query && String(a.colorNumber).toLowerCase() === query ? 1 : 0;
          const bExactColor = query && String(b.colorNumber).toLowerCase() === query ? 1 : 0;
          return bExactColor - aExactColor ||
            String(a.product).localeCompare(String(b.product), "de");
        })
        .slice(0, 30);

      res.json({ ok: true, materials: rows });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  return {
    readMaterials: () => readJson(MATERIALS_FILE, []),
    readMaterialInbox: () => readJson(INBOX_FILE, []),
    importWorkbook,
    exportWorkbook,
    syncWinWorkerMaterials,
    syncLittleGreenePrices,
    rebuildLittleGreeneMaterials,
  };
}

module.exports = { registerMaterialMaster };
