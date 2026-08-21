"use strict";
(function(){
  const nativeFetch = window.fetch.bind(window);
  const digits = value => String(value ?? "").replace(/\D/g, "");
  const skuNorm = value => String(value ?? "").trim().toUpperCase();
  const variants = value => {
    const code = digits(value);
    const out = new Set();
    if (!code) return [];
    out.add(code);
    if (code.length === 12) out.add("0" + code);
    if (code.length === 13 && code.startsWith("0")) out.add(code.slice(1));
    return [...out];
  };

  let masterPromise = null;
  async function loadMaster(){
    if (!masterPromise) {
      masterPromise = nativeFetch("/public/lg-ean-master.json", {
        cache: "no-store",
        headers: { "Accept": "application/json" }
      }).then(async response => {
        if (!response.ok) throw new Error("LG-EAN-Master nicht verfügbar");
        return await response.json();
      }).catch(() => ({ items: {} }));
    }
    return masterPromise;
  }

  function jsonResponseLike(response, data, status = response.status){
    const headers = new Headers(response.headers || {});
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(data), {
      status,
      statusText: status === 200 ? "OK" : response.statusText,
      headers,
    });
  }

  async function enrichInventoryResponse(response){
    if (!response.ok) return response;
    const data = await response.clone().json().catch(() => null);
    if (!data || !Array.isArray(data.items)) return response;

    const master = await loadMaster();
    const eanBySku = new Map();
    for (const [ean, sku] of Object.entries(master?.items || {})) {
      const key = skuNorm(sku);
      if (key && digits(ean)) eanBySku.set(key, digits(ean));
    }

    let changed = false;
    for (const item of data.items) {
      const canonical = eanBySku.get(skuNorm(item?.stockCode));
      if (!canonical) continue;
      if (digits(item?.ean) !== canonical) {
        item.ean = canonical;
        changed = true;
      }
    }
    return changed ? jsonResponseLike(response, data) : response;
  }

  async function retryScanVariants(rawUrl, init, original){
    const url = new URL(rawUrl, location.origin);
    for (const alt of variants(original)) {
      if (!alt || alt === original) continue;
      const retry = new URL(url.href);
      retry.searchParams.set("ean", alt);
      const response = await nativeFetch(retry.href, init);
      if (response.ok) return response;
    }
    return null;
  }

  async function resolveScanFromMaster(rawUrl, init, original, fallbackResponse){
    const master = await loadMaster();
    const wanted = new Set(variants(original));
    let canonical = "";
    let sku = "";
    for (const [ean, stockCode] of Object.entries(master?.items || {})) {
      if (variants(ean).some(v => wanted.has(v))) {
        canonical = digits(ean);
        sku = skuNorm(stockCode);
        break;
      }
    }
    if (!canonical || !sku) return fallbackResponse;

    try {
      const source = new URL(rawUrl, location.origin);
      const token = source.searchParams.get("token") || new URLSearchParams(location.search).get("token") || "";
      const inventoryUrl = "/admin/api/paint/inventory" + (token ? "?token=" + encodeURIComponent(token) : "");
      const response = await nativeFetch(inventoryUrl, { headers: { "Accept": "application/json" } });
      const data = await response.json().catch(() => ({}));
      const article = (Array.isArray(data.items) ? data.items : []).find(row => skuNorm(row?.stockCode) === sku);
      if (!article) return fallbackResponse;
      return jsonResponseLike(fallbackResponse, { ok: true, article: { ...article, ean: canonical } }, 200);
    } catch {
      return fallbackResponse;
    }
  }

  // Wichtig: Dieser Patch wird VOR dem Inventur-Scanner geladen. Dadurch bekommt
  // dessen lokale EAN-Liste automatisch die EAN aus dem LG-Master anhand der SKU.
  // So öffnet ein gelesener Barcode direkt die Material/Soll/Ist-Maske, auch wenn
  // articles.json bei einer älteren Übernahme noch keine EAN gespeichert hatte.
  window.fetch = async function(input, init){
    const rawUrl = typeof input === "string" ? input : (input && input.url) || "";
    let response = await nativeFetch(input, init);

    if (/\/admin\/api\/paint\/inventory(?:\?|$)/.test(rawUrl) && !/\/count(?:\?|$)/.test(rawUrl)) {
      response = await enrichInventoryResponse(response);
    }

    if (response.status === 404 && /\/admin\/api\/paint\/scan(?:\?|$)/.test(rawUrl)) {
      try {
        const url = new URL(rawUrl, location.origin);
        const original = digits(url.searchParams.get("ean"));
        const variantHit = await retryScanVariants(rawUrl, init, original);
        if (variantHit) return variantHit;
        return await resolveScanFromMaster(rawUrl, init, original, response);
      } catch {}
    }
    return response;
  };

  // iPhone: html5-qrcode behält nach Drehen manchmal die alte Geometrie.
  // Wenn der Inventur-Scanner läuft, starten wir ihn nach dem Drehen einmal neu.
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
