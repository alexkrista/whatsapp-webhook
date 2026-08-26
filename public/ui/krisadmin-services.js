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
  load("/public/ui/krisadmin-services-core.js?v=20260826-services4", "data-krista-services-core");
  if (location.pathname.toLowerCase().includes("baustellen.html")) {
    load("/public/ui/baustellen-calculation-v2.js?v=20260826-kalk1", "data-krista-kalkulation-v1");
    load("/public/ui/baustellen-calculation-parser-fix.js?v=20260826-flatpos1", "data-krista-kalkulation-parser-fix");
  }
})();