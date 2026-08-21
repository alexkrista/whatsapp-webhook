"use strict";
(function(){
  let lastUserTouchAt = 0;

  function markUserTouch(){
    lastUserTouchAt = Date.now();
  }

  function prepare(input){
    if (!input) return;

    // iPhone/Safari: type=number + programmatischer focus() kann dazu führen,
    // dass das Feld zwar aktiv aussieht, aber keine Bildschirmtastatur öffnet.
    // Text + inputmode=numeric ist deutlich zuverlässiger.
    input.type = "text";
    input.inputMode = "numeric";
    input.setAttribute("inputmode", "numeric");
    input.setAttribute("pattern", "[0-9]*");
    input.setAttribute("autocomplete", "off");
    input.removeAttribute("readonly");
    input.disabled = false;
    input.style.pointerEvents = "auto";
    input.style.touchAction = "manipulation";
    input.style.webkitUserSelect = "text";
    input.style.userSelect = "text";
    input.style.opacity = "1";
    input.style.color = "#111";
    input.style.webkitTextFillColor = "#111";

    if (input.dataset.kristaIstInput === "2") return;
    input.dataset.kristaIstInput = "2";

    input.addEventListener("touchstart", markUserTouch, { passive: true });
    input.addEventListener("pointerdown", markUserTouch, { passive: true });
    input.addEventListener("mousedown", markUserTouch, { passive: true });

    input.addEventListener("focus", () => {
      const userTriggered = Date.now() - lastUserTouchAt < 1200;

      // Der Scanner setzt nach dem Scan selbst focus(). Auf iOS ist das kein echter
      // Bedienvorgang und öffnet keine Tastatur. Diesen künstlichen Focus sofort
      // wieder lösen; beim nächsten echten Antippen kommt die Zahlentastatur.
      if (!userTriggered) {
        setTimeout(() => {
          if (document.activeElement === input && Date.now() - lastUserTouchAt >= 1200) {
            try { input.blur(); } catch {}
          }
        }, 80);
        return;
      }

      // Bei 0 soll man nicht zuerst löschen müssen.
      if (String(input.value || "").trim() === "0") {
        input.value = "";
        input.placeholder = "0";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }

      // Bestehenden Wert komplett markieren: erste Ziffer ersetzt ihn direkt.
      setTimeout(() => {
        try { input.select(); } catch {}
      }, 0);
    });

    // Nochmals explizit aus echter Touch-Geste fokussieren. Das ist für Safari
    // entscheidend, damit die Bildschirmtastatur wirklich erscheint.
    input.addEventListener("touchend", () => {
      try { input.focus({ preventScroll: true }); } catch { try { input.focus(); } catch {} }
    }, { passive: true });
  }

  function install(){
    const input = document.getElementById("inventoryActualStock");
    prepare(input);
  }

  install();
  new MutationObserver(install).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden"]
  });
})();
