"use strict";

const fsp = require("fs/promises");
const path = require("path");

const clean = (value, max = 500) => String(value ?? "").trim().slice(0, max);
const norm = value => clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();

function baseKey(value) {
  const n = norm(value);
  if (["h", "hi", "hiwhite"].includes(n)) return "hiwhite";
  if (["m", "medium"].includes(n)) return "medium";
  if (["d", "deep"].includes(n)) return "deep";
  if (["xd", "x", "extradeep"].includes(n)) return "extradeep";
  if (["t", "transparent"].includes(n)) return "transparent";
  if (["y", "yellow"].includes(n)) return "yellow";
  if (["p", "pastel"].includes(n)) return "pastel";
  if (["w", "white", "whiteasp"].includes(n)) return "whiteasp";
  if (["bc", "bluebc"].includes(n)) return "bluebc";
  if (["tc", "bluetc"].includes(n)) return "bluetc";
  return n;
}

function sizeKey(value) {
  const raw = clean(value, 50).toLowerCase().replace(/litre|liter|ltr/g, "l").replace(/\s+/g, "").replace(",", ".");
  if (/^250ml$|^0\.25l$/.test(raw)) return "0.25l";
  if (/^500ml$|^0\.5l$/.test(raw)) return "0.5l";
  if (/^750ml$|^0\.75l$/.test(raw)) return "0.75l";
  if (/^1l$/.test(raw)) return "1l";
  if (/^2l$/.test(raw)) return "2l";
  if (/^2\.5l$/.test(raw)) return "2.5l";
  if (/^4l$/.test(raw)) return "4l";
  if (/^5l$/.test(raw)) return "5l";
  if (/^10l$/.test(raw)) return "10l";
  return raw;
}

function identityKey(row) {
  return `${norm(row?.product)}|${baseKey(row?.baseCode || row?.baseName)}|${sizeKey(row?.size)}`;
}

async function readLatestStockMap(rootOrMovementsFile) {
  const movementsFile = String(rootOrMovementsFile || "").endsWith(".jsonl")
    ? rootOrMovementsFile
    : path.join(rootOrMovementsFile, "movements.jsonl");
  const map = new Map();
  try {
    const text = await fsp.readFile(movementsFile, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const after = Number(row?.after);
      if (!Number.isFinite(after) || after < 0) continue;
      const key = identityKey(row);
      if (!key || key.startsWith("||")) continue;
      map.set(key, {
        stock: Math.max(0, after),
        at: clean(row?.at, 80),
        reason: clean(row?.reason || row?.direction, 80),
        articleId: clean(row?.articleId, 220),
      });
    }
  } catch {}
  return map;
}

function stockForArticle(article, latestMap) {
  const hit = latestMap?.get(identityKey(article));
  if (hit && Number.isFinite(Number(hit.stock))) {
    return { stock: Math.max(0, Number(hit.stock)), source: "ledger", movement: hit };
  }
  const fallback = Number(article?.stock || 0);
  return { stock: Number.isFinite(fallback) ? Math.max(0, fallback) : 0, source: "article", movement: null };
}

function sameIdentity(a, b) {
  return identityKey(a) === identityKey(b);
}

module.exports = { baseKey, sizeKey, identityKey, readLatestStockMap, stockForArticle, sameIdentity };
