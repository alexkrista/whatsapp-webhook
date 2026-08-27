"use strict";

(() => {
  function load(src, key) {
    if (document.querySelector(`script[${key}]`)) return;
    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.setAttribute(key, "1");
    document.head.appendChild(script);
  }

  function retireStandaloneServicesButton() {
    document.getElementById("kristaServicesButton")?.remove();
  }

  load("/public/ui/krisadmin-services-core.js?v=20260827-services-home1", "data-krista-services-core");

  // Dienste leben jetzt als eigenes Feld in KRISADMIN. Der alte Einzelbutton
  // auf der Baustellen-/Admin-Oberfläche wird nachgeladenen Zuständen sicher entfernt.
  retireStandaloneServicesButton();
  [50, 200, 600, 1400, 3000].forEach(ms => setTimeout(retireStandaloneServicesButton, ms));
  const observer = new MutationObserver(retireStandaloneServicesButton);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 5000);

  if (location.pathname.toLowerCase().includes("baustellen.html")) {
    load("/public/ui/baustellen-calculation-v2.js?v=20260826-kalk1", "data-krista-kalkulation-v1");
    load("/public/ui/baustellen-calculation-parser-fix.js?v=20260826-flatpos1", "data-krista-kalkulation-parser-fix");
    load("/public/ui/baustellen-calculation-grid-v2.js?v=20260826-grid2", "data-krista-kalkulation-grid-v2");
  }
  if (location.pathname.toLowerCase().includes("access-admin.html")) {
    load("/public/ui/access-learn-multi.js?v=20260827-multi2m", "data-krista-access-learn-multi");
  }
})();
