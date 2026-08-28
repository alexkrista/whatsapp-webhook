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

  function suppressMorningPunishment() {
    if (!document.getElementById("kgoMorningPunishmentOff")) {
      const style = document.createElement("style");
      style.id = "kgoMorningPunishmentOff";
      // Vorläufig komplett still: Die Morgenprüfung darf intern weiter Daten prüfen,
      // aber bis Tagesabschluss/Scheduler stabil sind erscheint kein Liegestütz-Schirm.
      style.textContent = "#kgMorningOverlay{display:none!important}";
      document.head.appendChild(style);
    }
    const remove = () => document.getElementById("kgMorningOverlay")?.remove();
    remove();
    const observer = new MutationObserver(remove);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 15000);
  }

  suppressMorningPunishment();
  load("/public/ui/kgo-brain-access-core.js?v=20260826-brain-core", "data-kgo-brain-core");
  load("/public/ui/kgo-work-scope.js?v=20260826-scope1", "data-kgo-work-scope");
})();
