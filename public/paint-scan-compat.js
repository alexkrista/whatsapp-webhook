"use strict";
(function(){
  const nativeFetch = window.fetch.bind(window);
  const digits = value => String(value ?? "").replace(/\D/g, "");
  const variants = value => {
    const code = digits(value);
    const out = new Set();
    if (!code) return [];
    out.add(code);
    if (code.length === 12) out.add("0" + code);
    if (code.length === 13 && code.startsWith("0")) out.add(code.slice(1));
    return [...out];
  };

  // UPC-A (12 Stellen) und EAN-13 mit führender 0 sind derselbe Artikel.
  // Safari/html5-qrcode kann denselben Dosenbarcode je nach Format einmal so,
  // einmal so zurückgeben. Für die Scan-API deshalb bei 404 automatisch die
  // äquivalente Schreibweise probieren.
  window.fetch = async function(input, init){
    const rawUrl = typeof input === "string" ? input : (input && input.url) || "";
    const response = await nativeFetch(input, init);
    if (response.status !== 404 || !/\/admin\/api\/paint\/scan(?:\?|$)/.test(rawUrl)) return response;
    try {
      const url = new URL(rawUrl, location.origin);
      const original = digits(url.searchParams.get("ean"));
      for (const alt of variants(original)) {
        if (!alt || alt === original) continue;
        const retry = new URL(url.href);
        retry.searchParams.set("ean", alt);
        const r = await nativeFetch(retry.href, init);
        if (r.ok) return r;
      }
    } catch {}
    return response;
  };

  // Der Inventur-Scanner arbeitet lokal mit der geladenen EAN-Liste. Wenn er
  // einen 12/13-stelligen UPC/EAN-Zwilling meldet, setzen wir automatisch die
  // im Lagerstamm gespeicherte Schreibweise ins Handscanner-Feld. Dadurch muss
  // die Inventur-Logik selbst nicht doppelte Barcodes pflegen.
  let resolving = false;
  async function resolveInventoryUnknown(){
    if (resolving) return;
    const status = document.getElementById("inventoryScanStatus");
    const manual = document.getElementById("inventoryScanEan");
    if (!status || !manual) return;
    const match = String(status.textContent || "").match(/EAN\s+(\d{8,14})\s+ist keinem Inventurartikel/i);
    if (!match) return;
    resolving = true;
    try {
      const token = new URLSearchParams(location.search).get("token") || "";
      const url = "/admin/api/paint/inventory" + (token ? "?token=" + encodeURIComponent(token) : "");
      const response = await nativeFetch(url, {headers:{"Accept":"application/json"}});
      const data = await response.json().catch(()=>({}));
      const wanted = new Set(variants(match[1]));
      const item = (Array.isArray(data.items) ? data.items : []).find(row => variants(row?.ean).some(v => wanted.has(v)));
      if (!item?.ean) return;
      manual.value = digits(item.ean);
      manual.dispatchEvent(new Event("input", {bubbles:true}));
      status.textContent = "Barcode erkannt · Artikel wird zugeordnet …";
    } catch {} finally {
      setTimeout(()=>{ resolving = false; }, 350);
    }
  }

  function installStatusObserver(){
    const status = document.getElementById("inventoryScanStatus");
    if (!status || status.dataset.eanCompat === "1") return;
    status.dataset.eanCompat = "1";
    new MutationObserver(resolveInventoryUnknown).observe(status, {childList:true, subtree:true, characterData:true});
  }
  installStatusObserver();
  new MutationObserver(installStatusObserver).observe(document.body, {childList:true, subtree:true});

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
