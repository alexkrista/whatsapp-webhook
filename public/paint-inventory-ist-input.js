"use strict";
(function(){
  function prepare(input){
    if (!input || input.dataset.kristaIstInput === "1") return;
    input.dataset.kristaIstInput = "1";

    input.addEventListener("focus", () => {
      // Bei 0 soll man nicht zuerst löschen müssen. Leer bedeutet beim Speichern
      // weiterhin 0; sobald eine Zahl getippt wird, steht sie direkt richtig drin.
      if (String(input.value || "").trim() === "0") {
        input.value = "";
        input.placeholder = "0";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
      // Vorbelegte Werte (z.B. Sollstand) komplett markieren: erste Ziffer ersetzt
      // den Wert auf iPhone/Handscanner sofort statt ihn anzuhängen.
      setTimeout(() => {
        try { input.select(); } catch {}
      }, 0);
    });
  }

  function install(){
    prepare(document.getElementById("inventoryActualStock"));
  }

  install();
  new MutationObserver(install).observe(document.body, { childList: true, subtree: true });
})();
