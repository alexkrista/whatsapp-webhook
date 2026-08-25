"use strict";
(function(){
  function prepareTone(input, button){
    if(!input || input.dataset.kristaUnmixed === "1") return;
    input.dataset.kristaUnmixed = "1";
    input.placeholder = "optional · leer = ungemischt";
    const label = input.closest("div")?.querySelector("label");
    if(label) label.textContent = "Farbton (optional)";
    button?.addEventListener("click", () => {
      setTimeout(() => {
        if(!String(input.value || "").trim()) {
          input.value = "ungemischt";
          try { input.select(); } catch {}
        }
      }, 80);
    });
  }

  function install(){
    prepareTone(document.getElementById("scanColourTone"), document.getElementById("projectBtn"));
    prepareTone(document.getElementById("manualOutTone"), document.getElementById("manualProjectBtn"));
  }

  install();
  new MutationObserver(install).observe(document.body, { childList:true, subtree:true });
})();
