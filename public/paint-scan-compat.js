"use strict";
(function(){
  const nativeFetch = window.fetch.bind(window);
  const digits = value => String(value ?? "").replace(/\D/g, "");
  const skuNorm = value => String(value ?? "").trim().toUpperCase();
  const norm = value => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  const variants = value => {
    const code = digits(value);
    const out = new Set();
    if (!code) return [];
    out.add(code);
    if (code.length === 12) out.add("0" + code);
    if (code.length === 13 && code.startsWith("0")) out.add(code.slice(1));
    return [...out];
  };

  function productKey(value){
    return norm(value)
      .replace(/\bemulsion\b/g, "")
      .replace(/\bpaint\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function baseKey(value){
    const n = norm(value).replace(/\s+/g, "");
    if (["h","hi","hiwhite"].includes(n)) return "HI";
    if (["xd","x","extradeep"].includes(n)) return "XD";
    if (["m","medium"].includes(n)) return "M";
    if (["d","deep"].includes(n)) return "D";
    if (["t","transparent"].includes(n)) return "T";
    if (["y","yellow"].includes(n)) return "Y";
    if (["p","pastel"].includes(n)) return "P";
    if (["w","whiteasp","white"].includes(n)) return "W";
    return String(value ?? "").trim().toUpperCase();
  }

  function sizeKey(value){
    let raw = String(value ?? "").toLowerCase().replace(/,/g, ".").replace(/litre|liter|ltr/g, "l").replace(/\s+/g, "");
    if (raw === "250ml") return "0.25l";
    if (raw === "500ml") return "0.5l";
    if (raw === "750ml") return "0.75l";
    return raw;
  }

  let identityPromise = null;
  async function loadIdentity(){
    if (!identityPromise) {
      identityPromise = nativeFetch("/public/lg-ean-identity.json", {
        cache: "no-store",
        headers: { "Accept": "application/json" }
      }).then(async response => {
        if (!response.ok) throw new Error("LG-EAN-Identität nicht verfügbar");
        return await response.json();
      }).catch(() => ({ items: {} }));
    }
    return identityPromise;
  }

  let legacyPromise = null;
  async function loadLegacy(){
    if (!legacyPromise) {
      legacyPromise = nativeFetch("/public/lg-ean-master.json", {
        cache: "no-store",
        headers: { "Accept": "application/json" }
      }).then(async response => response.ok ? await response.json() : ({items:{}})).catch(() => ({ items: {} }));
    }
    return legacyPromise;
  }

  function identityMatches(item, entry){
    if (!item || !entry) return false;
    const itemBase = item.baseCode || item.baseName || "";
    return productKey(item.product) === productKey(entry.product)
      && sizeKey(item.size) === sizeKey(entry.size)
      && baseKey(itemBase) === baseKey(entry.baseCode);
  }

  function findArticleByIdentity(items, entry){
    const rows = Array.isArray(items) ? items : [];
    const exact = rows.find(row => identityMatches(row, entry));
    if (exact) return exact;

    // SKU nur noch als Fallback, nie mehr als alleinige Identität.
    const sku = skuNorm(entry?.stockCode);
    if (sku) {
      const skuRows = rows.filter(row => skuNorm(row?.stockCode) === sku);
      const compatible = skuRows.find(row => {
        const productOk = !entry.product || productKey(row?.product) === productKey(entry.product);
        const sizeOk = !entry.size || sizeKey(row?.size) === sizeKey(entry.size);
        const baseOk = !entry.baseCode || baseKey(row?.baseCode || row?.baseName) === baseKey(entry.baseCode);
        return productOk && sizeOk && baseOk;
      });
      if (compatible) return compatible;
    }
    return null;
  }

  function masterHit(master, code){
    const wanted = new Set(variants(code));
    for (const [ean, entry] of Object.entries(master?.items || {})) {
      if (variants(ean).some(v => wanted.has(v))) return { ean: digits(ean), entry };
    }
    return null;
  }

  function jsonResponseLike(response, data, status = 200){
    const headers = new Headers(response?.headers || {});
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(data), {
      status,
      statusText: status === 200 ? "OK" : (response?.statusText || ""),
      headers,
    });
  }

  async function enrichInventoryResponse(response){
    if (!response.ok) return response;
    const data = await response.clone().json().catch(() => null);
    if (!data || !Array.isArray(data.items)) return response;

    const master = await loadIdentity();
    const knownByEan = new Map();
    for (const [ean, entry] of Object.entries(master?.items || {})) knownByEan.set(digits(ean), entry);

    let changed = false;

    // Falsch gespeicherte/zugeordnete EAN im Browser nicht übernehmen.
    // Beispiel: EAN von Intelligent Gloss darf niemals auf Intelligent Satin bleiben.
    for (const item of data.items) {
      const current = digits(item?.ean);
      const expected = knownByEan.get(current);
      if (current && expected && !identityMatches(item, expected)) {
        item.ean = "";
        changed = true;
      }
    }

    // Die 13-stellige EAN wird direkt Material + Gebinde + Basis zugeordnet.
    for (const [ean, entry] of Object.entries(master?.items || {})) {
      const article = findArticleByIdentity(data.items, entry);
      if (!article) continue;
      const canonical = digits(ean);
      if (digits(article.ean) !== canonical) {
        article.ean = canonical;
        changed = true;
      }
    }

    return changed ? jsonResponseLike(response, data, response.status) : response;
  }

  async function correctScanResponse(rawUrl, init, response){
    let source;
    try { source = new URL(rawUrl, location.origin); } catch { return response; }
    const original = digits(source.searchParams.get("ean"));
    if (!original) return response;

    const identity = await loadIdentity();
    const hit = masterHit(identity, original);
    if (hit?.entry) {
      try {
        const token = source.searchParams.get("token") || new URLSearchParams(location.search).get("token") || "";
        const inventoryUrl = "/admin/api/paint/inventory" + (token ? "?token=" + encodeURIComponent(token) : "");
        const invResponse = await nativeFetch(inventoryUrl, { headers: { "Accept": "application/json" } });
        const inv = await invResponse.json().catch(() => ({}));
        const article = findArticleByIdentity(inv.items, hit.entry);
        if (article) {
          return jsonResponseLike(response, {
            ok: true,
            article: { ...article, ean: hit.ean },
            resolvedBy: "exact-ean-identity"
          }, 200);
        }
      } catch {}
    }

    // Für alte UPC-A/EAN-13-Zwillinge weiterhin den bisherigen Fallback behalten.
    if (response.status === 404) {
      for (const alt of variants(original)) {
        if (!alt || alt === original) continue;
        const retry = new URL(source.href);
        retry.searchParams.set("ean", alt);
        const r = await nativeFetch(retry.href, init);
        if (r.ok) return r;
      }

      // Letzte Rückfallebene: alter EAN→SKU-Master, aber nur wenn eindeutig.
      try {
        const legacy = await loadLegacy();
        const legacyHit = masterHit({items:Object.fromEntries(Object.entries(legacy?.items || {}).map(([ean,sku])=>[ean,{stockCode:sku}]))}, original);
        if (legacyHit?.entry?.stockCode) {
          const token = source.searchParams.get("token") || new URLSearchParams(location.search).get("token") || "";
          const inventoryUrl = "/admin/api/paint/inventory" + (token ? "?token=" + encodeURIComponent(token) : "");
          const invResponse = await nativeFetch(inventoryUrl, { headers: { "Accept": "application/json" } });
          const inv = await invResponse.json().catch(() => ({}));
          const matches = (Array.isArray(inv.items) ? inv.items : []).filter(row => skuNorm(row?.stockCode) === skuNorm(legacyHit.entry.stockCode));
          if (matches.length === 1) return jsonResponseLike(response, {ok:true,article:{...matches[0],ean:legacyHit.ean},resolvedBy:"legacy-unique-sku"}, 200);
        }
      } catch {}
    }

    return response;
  }

  // Der Scanner bekommt seine Liste über /inventory. Deshalb korrigieren wir dort
  // die EAN bereits VOR dem Aufbau der lokalen byEan-Map. /scan wird zusätzlich
  // immer validiert – auch wenn der Server fälschlich bereits HTTP 200 liefert.
  window.fetch = async function(input, init){
    const rawUrl = typeof input === "string" ? input : (input && input.url) || "";
    let response = await nativeFetch(input, init);

    if (/\/admin\/api\/paint\/inventory(?:\?|$)/.test(rawUrl)
        && !/\/count(?:\?|$)/.test(rawUrl)
        && !/\/usage(?:\?|$)/.test(rawUrl)
        && !/\/session-count(?:\?|$)/.test(rawUrl)) {
      response = await enrichInventoryResponse(response);
    }

    if (/\/admin\/api\/paint\/scan(?:\?|$)/.test(rawUrl)) {
      response = await correctScanResponse(rawUrl, init, response);
    }
    return response;
  };

  // iPhone: html5-qrcode behält nach Drehen manchmal die alte Geometrie.
  let rotateTimer = null;
  let lastOrientation = window.innerWidth > window.innerHeight ? "landscape" : "portrait";
  function refreshInventoryScannerAfterRotate(){
    const now = window.innerWidth > window.innerHeight ? "landscape" : "portrait";
    if (now === lastOrientation) return;
    lastOrientation = now;
    clearTimeout(rotateTimer);
    rotateTimer = setTimeout(()=>{
      const button = document.getElementById("inventoryCameraBtn");
      const panel = document.getElementById("inventoryCameraPanel");
      if (!button || !panel || panel.hidden) return;
      if (!/Scanner schließen/i.test(button.textContent || "")) return;
      button.click();
      setTimeout(()=>button.click(), 450);
    }, 300);
  }
  window.addEventListener("resize", refreshInventoryScannerAfterRotate, {passive:true});
  window.addEventListener("orientationchange", refreshInventoryScannerAfterRotate, {passive:true});

  const style = document.createElement("style");
  style.textContent = `
    @media (orientation:landscape) and (max-height:650px){
      #inventoryCameraReader,#cameraReader{min-height:150px!important;max-height:68vh!important}
      #inventoryCameraReader video,#cameraReader video{max-height:68vh!important;object-fit:contain!important}
    }
  `;
  document.head.appendChild(style);
})();
