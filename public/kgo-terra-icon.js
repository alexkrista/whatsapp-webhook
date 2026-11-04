"use strict";
(function () {
  const recipes = Object.freeze({
    fein: { title: "Terra Icon Fein", a: 4.4, b: 8, c: 1.02, area: 27.02 },
    mittel: { title: "Terra Icon Mittel", a: 3.52, b: 8, c: 0.80, area: 18.92 }
  });
  function calculate(kind, dimension, amount) {
    const r = recipes[kind];
    if (!r || !["m2", "total", "a", "b", "c"].includes(dimension) || !(Number.isFinite(amount) && amount > 0)) return null;
    const total = r.a + r.b + r.c;
    const scale = amount / (dimension === "m2" ? r.area : dimension === "total" ? total : r[dimension]);
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
  const output = root.querySelector("#kgTerraOutput");
  const note = root.querySelector("#kgTerraNote");
  const caption = root.querySelector("#kgTerraReference");
  function update() {
    const r=recipes[type.value];
    if (!r) return;
    const total=r.a+r.b+r.c;
    caption.textContent = "Referenzsatz: "+fmt(r.a)+" kg A + "+fmt(r.b)+" kg B + "+fmt(r.c)+" kg C = "+fmt(total)+" kg für "+fmt(r.area)+" m²";
    const input = Number(String(amount.value).trim().replace(",","."));
    const calc=calculate(type.value,basis.value,input);
    if (!calc) {
      output.hidden=true;
      note.textContent="Bitte eine positive Menge eingeben.";
      return;
    }
    output.hidden=false;
    note.textContent="Berechnung im konstanten Mischverhältnis A:B:C. Werte auf der Waage entsprechend ihrer Genauigkeit runden.";
    for(const key of ["a","b","c","total","m2"]) {
      const element = root.querySelector("[data-terra-result='"+key+"']");
      if(element) element.textContent = fmt(calc[key]) + (key==="m2"?" m²":" kg");
    }
  }
  for(const element of [type,basis,amount]) element.addEventListener(element===amount?"input":"change", update);
  root.querySelector("#kgTerraToggle")?.addEventListener("click", () => {
    const contents=root.querySelector("#kgTerraContents");
    const open = contents.hidden;
    contents.hidden=!open;
    root.querySelector("#kgTerraToggle").setAttribute("aria-expanded",String(open));
  });
  update();
})();
