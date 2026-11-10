"use strict";
(function () {
  const recipes = Object.freeze({
    fein: { title: "Terra Icon Fein", a: 4.4, b: 8, c: 1.02, area: 27.02 },
    mittel: { title: "Terra Icon Mittel", a: 3.52, b: 8, c: 0.80, area: 18.92 },
    power: { title: "Terra POWER", perLayer: 0.110, a: 0.88, b: 0.22, c: 0, area: 10 }
  });
  function calculate(kind, dimension, amount, layers = 1) {
    const r = recipes[kind];
    if (!r || !["m2", "ab", "total", "a", "b", "c"].includes(dimension) || !(Number.isFinite(amount) && amount > 0)) return null;
    if (kind === "power") {
      if (dimension === "c" || ![1,2,3].includes(Number(layers))) return null;
      const rate = r.perLayer * Number(layers);
      const total = dimension === "m2" ? amount * rate : dimension === "total" || dimension === "ab" ? amount : dimension === "a" ? amount * 1.25 : amount * 5;
      return { a:total*0.8, b:total*0.2, c:0, total, m2:total/rate };
    }
    const total = r.a + r.b + r.c;
    const scale = amount / (dimension === "m2" ? r.area : dimension === "total" ? total : dimension === "ab" ? r.a + r.b : r[dimension]);
    return { a:r.a*scale, b:r.b*scale, c:r.c*scale, total:total*scale, m2:r.area*scale };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { recipes, calculate };
  if (typeof document === "undefined") return;

  const fmt = n => new Intl.NumberFormat("de-AT",{minimumFractionDigits:2,maximumFractionDigits:3}).format(n);
  const root = document.getElementById("kgTerraMix");
  if (!root) return;
  const type = root.querySelector("#kgTerraType");
  const basis = root.querySelector("#kgTerraBasis");
  const amount = root.querySelector("#kgTerraInput");
  const layers = root.querySelector("#kgTerraLayers");
  const layersField = root.querySelector("#kgTerraLayersField");
  const output = root.querySelector("#kgTerraOutput");
  const note = root.querySelector("#kgTerraNote");
  const caption = root.querySelector("#kgTerraReference");
  function update() {
    const r=recipes[type.value];
    if (!r) return;
    const isPower=type.value==="power";
    layersField.hidden=!isPower;
    const cChoice=basis.querySelector('option[value="c"]');
    if(cChoice)cChoice.hidden=isPower;
    const abChoice=basis.querySelector('option[value="ab"]');
    if(abChoice)abChoice.hidden=isPower;
    const totalChoice=basis.querySelector('option[value="total"]');
    if(totalChoice)totalChoice.textContent=isPower?"Gesamtmenge A+B (kg)":"Gesamtmenge A+B+C (kg)";
    root.querySelector("#kgTerraMark").textContent=isPower?"A+B":"A+B+C";
    root.querySelector("#kgTerraTotalLabel").textContent=isPower?"Gesamt A+B":"Gesamt A+B+C";
    root.querySelector("#kgTerraCResult").hidden=isPower;
    if(isPower && (basis.value==="c" || basis.value==="ab"))basis.value="m2";
    const total=r.a+r.b+r.c;
    caption.textContent = isPower ? "Verbrauch: 110 g/m² pro Lage · A:B = 4:1 (80 % : 20 %)" : "Referenzsatz: "+fmt(r.a)+" kg A + "+fmt(r.b)+" kg B + "+fmt(r.c)+" kg C = "+fmt(total)+" kg für "+fmt(r.area)+" m²";
    const input = Number(String(amount.value).trim().replace(",","."));
    const calc=calculate(type.value,basis.value,input,Number(layers.value));
    if (!calc) {
      output.hidden=true;
      note.textContent="Bitte eine positive Menge eingeben.";
      return;
    }
    output.hidden=false;
    note.textContent=isPower ? "Terra POWER: "+(110*Number(layers.value))+" g/m² für "+layers.value+" Lage(n) · A:B 4:1." : basis.value==="ab"?"A+B ist bereits gemischt. C (Härter) zusätzlich zugeben; die Gesamtmenge und Reichweite gelten nach Zugabe von C.":"Berechnung im konstanten Mischverhältnis A:B:C. Werte auf der Waage entsprechend ihrer Genauigkeit runden.";
    for(const key of ["a","b","c","total","m2"]) {
      const element = root.querySelector("[data-terra-result='"+key+"']");
      if(element) element.textContent = fmt(calc[key]) + (key==="m2"?" m²":" kg");
    }
  }
  for(const element of [type,basis,amount,layers]) element.addEventListener(element===amount?"input":"change", update);
  type.addEventListener("change",()=>{if(type.value==="power" && basis.value==="m2")amount.value="10";update();});
  root.querySelector("#kgTerraToggle")?.addEventListener("click", () => {
    const contents=root.querySelector("#kgTerraContents");
    const open = contents.hidden;
    contents.hidden=!open;
    root.querySelector("#kgTerraToggle").setAttribute("aria-expanded",String(open));
  });
  update();
})();
