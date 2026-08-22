"use strict";
(function () {
  const styleId = "lgOrderOverlayZFix";
  if (!document.getElementById(styleId)) {
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = ".lg-order-modal{z-index:1000!important}";
    document.head.appendChild(style);
  }

  const script = document.createElement("script");
  script.src = "/public/paint-lg-order-excel-ui-core.js?v=20260822-2012";
  script.async = false;
  (document.body || document.documentElement).appendChild(script);
})();
