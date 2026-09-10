(() => {
  "use strict";
  const style=document.createElement("style");
  style.textContent=".legacy-label{display:inline-block;color:#a12626;background:#fff0ef;border:1px solid #eab8b3;border-radius:7px;padding:4px 7px;margin:4px;font-size:12px}.prodhead{flex-wrap:wrap}";
  document.head.append(style);
  let recipeRequest=0;
  window.openRecipe=async(colourId,productId,productName,sizes,catalogVersion="")=>{
    const valid=(sizes||[]).filter(s=>s.canSizeId);
    if(!valid.length)return alert("Für diese Basis ist kein mischbares Gebinde hinterlegt.");
    const title=document.getElementById("recipeTitle"),body=document.getElementById("recipeBody"),modal=document.getElementById("recipeModal");
    title.textContent=productName;
    body.replaceChildren();
    const label=document.createElement("label");label.textContent="Gebinde ";
    const select=document.createElement("select");select.setAttribute("aria-label","Rezeptgebinde");
    for(const size of valid){const option=document.createElement("option");option.value=size.canSizeId;option.textContent=size.size;select.append(option);}
    label.append(select);body.append(label);
    const content=document.createElement("div");body.append(content);modal.classList.add("show");
    async function load(){
      const requestId=++recipeRequest;content.textContent="Rezept wird geladen …";
      try{
        const d=await api(`/admin/api/paint/recipe?colourId=${encodeURIComponent(colourId)}&productId=${productId}&canSizeId=${encodeURIComponent(select.value)}&catalogVersion=${encodeURIComponent(catalogVersion)}`);
        if(requestId!==recipeRequest)return;
        title.textContent=`${selected?.name||""} · ${productName} · ${d.baseName} · ${d.canSize}${d.legacy?" · ALT vor 09/2026":""}`;
        content.innerHTML=`<table class="rtable"><thead><tr><th>Paste</th><th>Einheiten</th><th>ml</th></tr></thead><tbody>${d.recipe.map(r=>`<tr><td>${esc(r.code)} ${esc(r.description)}</td><td>${Number(r.machineUnits).toFixed(2)}</td><td>${Number(r.ml).toFixed(2)}</td></tr>`).join("")}</tbody></table><p class="muted">${esc(d.calibrationNote||"")}</p>`;
      }catch(e){if(requestId===recipeRequest)content.textContent=e.message;}
    }
    select.onchange=load;await load();
  };
  document.addEventListener("click",async event=>{
    const button=event.target.closest("[data-old-colour]");
    if (!button) return;
    const colour=button.dataset.oldColour, product=Number(button.dataset.oldProduct);
    button.disabled=true;
    try {
      const d=await api(`/admin/api/paint/color/${encodeURIComponent(colour)}?catalogVersion=before-2026-09`);
      const p=d.products.find(p=>p.productId===product);
      if (!p) throw new Error("Alte Rezeptur nicht vorhanden");
      await window.openRecipe(colour,product,p.productName,p.sizes,"before-2026-09");
    } catch(e) { alert(e.message); } finally { button.disabled=false; }
  });
})();
