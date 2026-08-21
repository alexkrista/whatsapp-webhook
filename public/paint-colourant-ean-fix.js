"use strict";
(function(){
  // Korrektur nur für Colourants: der alte EAN-Master nennt 2.5 L,
  // der aktuelle LG-Lagerstamm führt die 15 Colourants als 1 L.
  // Pro Colourant-Code gibt es genau eine Lagerposition, daher ist Code die Identität.
  const previousFetch = window.fetch.bind(window);
  const digits = value => String(value ?? "").replace(/\D/g, "");
  const norm = value => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const baseKey = value => String(value ?? "").trim().toUpperCase();

  let identityPromise = null;
  async function colourantMap(){
    if (!identityPromise) {
      identityPromise = previousFetch("/public/lg-ean-identity.json", { cache:"no-store" })
        .then(r => r.ok ? r.json() : ({items:{}}))
        .then(data => {
          const byCode = new Map();
          const byEan = new Map();
          for (const [eanRaw, entry] of Object.entries(data?.items || {})) {
            const product = norm(entry?.product);
            if (product !== "colourants" && product !== "colourant") continue;
            const code = baseKey(entry?.baseCode);
            const ean = digits(eanRaw);
            if (!code || !ean) continue;
            byCode.set(code, ean);
            byEan.set(ean, code);
          }
          return { byCode, byEan };
        })
        .catch(() => ({byCode:new Map(),byEan:new Map()}));
    }
    return identityPromise;
  }

  function responseLike(response, data){
    const headers = new Headers(response.headers || {});
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(data), { status:response.status, statusText:response.statusText, headers });
  }

  window.fetch = async function(input, init){
    const rawUrl = typeof input === "string" ? input : (input && input.url) || "";
    let response = await previousFetch(input, init);

    if (/\/admin\/api\/paint\/inventory(?:\?|$)/.test(rawUrl)
        && !/\/count(?:\?|$)/.test(rawUrl)
        && !/\/usage(?:\?|$)/.test(rawUrl)
        && !/\/session-count(?:\?|$)/.test(rawUrl)) {
      const data = await response.clone().json().catch(() => null);
      if (response.ok && data && Array.isArray(data.items)) {
        const maps = await colourantMap();
        let changed = false;
        for (const item of data.items) {
          if (norm(item?.product) !== "colourants" && norm(item?.product) !== "colourant") continue;
          const ean = maps.byCode.get(baseKey(item?.baseCode || item?.baseName));
          if (ean && digits(item.ean) !== ean) {
            item.ean = ean;
            changed = true;
          }
        }
        if (changed) response = responseLike(response, data);
      }
    }

    if (/\/admin\/api\/paint\/scan(?:\?|$)/.test(rawUrl)) {
      let url;
      try { url = new URL(rawUrl, location.origin); } catch { return response; }
      const ean = digits(url.searchParams.get("ean"));
      const maps = await colourantMap();
      const code = maps.byEan.get(ean);
      if (code) {
        try {
          const token = url.searchParams.get("token") || new URLSearchParams(location.search).get("token") || "";
          const invUrl = "/admin/api/paint/inventory" + (token ? "?token=" + encodeURIComponent(token) : "");
          const invResponse = await previousFetch(invUrl, { headers:{"Accept":"application/json"} });
          const inv = await invResponse.json().catch(() => ({}));
          const article = (Array.isArray(inv.items) ? inv.items : []).find(item =>
            (norm(item?.product) === "colourants" || norm(item?.product) === "colourant")
            && baseKey(item?.baseCode || item?.baseName) === code
          );
          if (article) {
            return new Response(JSON.stringify({ok:true,article:{...article,ean},resolvedBy:"colourant-code"}), {
              status:200,
              headers:{"Content-Type":"application/json; charset=utf-8"}
            });
          }
        } catch {}
      }
    }

    return response;
  };
})();
