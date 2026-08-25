"use strict";
(function(){
  const detail = document.getElementById("detail");
  if (!detail) return;

  const norm = value => String(value ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  const preferred = [
    "Absolute Matt Emulsion",
    "Intelligent Matt Emulsion",
    "Intelligent Eggshell",
    "Intelligent Satin",
    "Intelligent Gloss",
    "Intelligent Floor Paint",
    "Intelligent Exterior Eggshell",
    "Intelligent Masonry Paint",
  ];

  const rank = new Map();
  preferred.forEach((name, index) => rank.set(norm(name), index));
  // Lager-/Altbezeichnung ebenfalls sauber einsortieren.
  rank.set(norm("Absolute Matt"), 0);

  let busy = false;
  function reorder(){
    if (busy) return;
    const products = [...detail.querySelectorAll(".product")];
    if (products.length < 2) return;

    const parent = products[0].parentElement;
    if (!parent || !products.every(node => node.parentElement === parent)) return;

    const sorted = [...products].sort((a,b) => {
      const an = norm(a.querySelector(".prodname")?.textContent || "");
      const bn = norm(b.querySelector(".prodname")?.textContent || "");
      const ar = rank.has(an) ? rank.get(an) : 999;
      const br = rank.has(bn) ? rank.get(bn) : 999;
      if (ar !== br) return ar - br;
      return an.localeCompare(bn, "de");
    });

    if (sorted.every((node,index) => node === products[index])) return;
    busy = true;
    try {
      for (const node of sorted) parent.appendChild(node);
    } finally {
      busy = false;
    }
  }

  const observer = new MutationObserver(() => setTimeout(reorder, 0));
  observer.observe(detail, { childList:true, subtree:true });
  reorder();
})();
