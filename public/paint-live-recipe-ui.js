(() => {
  "use strict";

  const detail = document.getElementById("detail");
  if (!detail) return;

  const qs = new URLSearchParams(location.search);
  const token = qs.get("token") || "";
  const cache = new Map();
  let busy = false;

  const norm = value => String(value ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "").trim();

  const baseKey = value => {
    const n = norm(value);
    if (["h","hi","hiwhite"].includes(n)) return "hiwhite";
    if (["m","medium"].includes(n)) return "medium";
    if (["d","deep"].includes(n)) return "deep";
    if (["xd","x","extradeep"].includes(n)) return "extradeep";
    if (["t","transparent"].includes(n)) return "transparent";
    if (["y","yellow"].includes(n)) return "yellow";
    if (["p","pastel"].includes(n)) return "pastel";
    if (["w","white","whiteasp"].includes(n)) return "whiteasp";
    return n;
  };

  async function request(url) {
    const join = url.includes("?") ? "&" : "?";
    const response = await fetch(url + (token ? join + "token=" + encodeURIComponent(token) : ""));
    const data = await response.json().catch(() => ({ ok:false, error:"Keine JSON-Antwort" }));
    if (!response.ok || data.ok === false) throw new Error(data.error || ("HTTP " + response.status));
    return data;
  }

  function currentColourId() {
    try {
      if (typeof selected !== "undefined" && selected && Number(selected.id) > 0) return Number(selected.id);
    } catch {}
    return 0;
  }

  async function catalogDetail(colourId) {
    if (cache.has(colourId)) return cache.get(colourId);
    const data = await request(`/admin/api/paint/color/${encodeURIComponent(colourId)}?system=LG`);
    cache.set(colourId, data);
    return data;
  }

  function findCatalogProduct(data, productName, baseName) {
    const pn = norm(productName);
    const bk = baseKey(baseName);
    const candidates = (data?.products || []).filter(p => norm(p.productName) === pn);
    return candidates.find(p => baseKey(p.baseName || p.baseCode) === bk) || candidates[0] || null;
  }

  async function installButtons() {
    if (busy) return;
    const colourId = currentColourId();
    if (!colourId || !detail.querySelector(".mix-live-pill")) return;

    const rows = [...detail.querySelectorAll(".product")];
    if (!rows.length) return;
    busy = true;
    try {
      const data = await catalogDetail(colourId);
      for (const row of rows) {
        if (row.querySelector(".liveRecipeBtn")) continue;
        const name = row.querySelector(".prodname")?.textContent?.trim() || "";
        const base = row.querySelector(".base")?.textContent?.trim() || "";
        if (!name) continue;
        const product = findCatalogProduct(data, name, base);
        const sizes = (product?.sizes || []).filter(s => Number(s.canSizeId) > 0);
        if (!product || !product.recipeAvailable || !sizes.length) continue;

        const head = row.querySelector(".prodhead");
        if (!head) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "recipeBtn liveRecipeBtn";
        button.textContent = "Rezept";
        button.title = "Rezeptur aus dem Innovatint-Katalog anzeigen";
        button.addEventListener("click", event => {
          event.stopPropagation();
          if (typeof window.openRecipe !== "function") return alert("Rezeptanzeige ist noch nicht geladen.");
          window.openRecipe(colourId, Number(product.productId), product.productName || name, sizes);
        });
        head.appendChild(button);
      }
    } catch (error) {
      console.warn("KRISTINE Rezeptbuttons:", error?.message || error);
    } finally {
      busy = false;
    }
  }

  const observer = new MutationObserver(() => setTimeout(installButtons, 0));
  observer.observe(detail, { childList:true, subtree:true });
  installButtons();
})();
