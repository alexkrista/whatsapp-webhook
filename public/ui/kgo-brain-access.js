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
  load("/public/ui/kgo-brain-access-core.js?v=20260826-brain-core", "data-kgo-brain-core");
  load("/public/ui/kgo-work-scope.js?v=20260826-scope1", "data-kgo-work-scope");
})();
