"use strict";
(function(){
  const qs = new URLSearchParams(location.search);
  const token = qs.get("token") || "";
  let lastSignature = "";
  let previousStock = 0;
  let syncing = false;

  const eanNorm = value => String(value ?? "").replace(/\D/g, "");
  const displayNumber = value => {
    const n = Number(value || 0);
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000).replace(".", ",");
  };

  async function api(url){
    const join = url.includes("?") ? "&" : "?";
    const response = await fetch(url + (token ? join + "token=" + encodeURIComponent(token) : ""), {
      headers: { "Accept": "application/json" }
    });
    const data = await response.json().catch(() => ({ ok:false, error:"Keine JSON-Antwort" }));
    if (!response.ok || data.ok === false) throw new Error(data.error || ("HTTP " + response.status));
    return data;
  }

  function ensureStyle(){
    if (document.getElementById("kristaInventoryIstHardFixStyle")) return;
    const style = document.createElement("style");
    style.id = "kristaInventoryIstHardFixStyle";
    style.textContent = `
      #inventoryCountTarget{display:none!important}
      .inventory-count-value.krista-hide-count-value{display:none!important}
      .inventory-count-value.krista-ist-value{grid-column:1/-1!important;background:#fff!important;border:2px solid #2f7d4a!important;padding:14px!important}
      .inventory-count-value.krista-ist-value b{font-size:13px!important;color:#285d39!important;margin-bottom:8px!important}
      #inventoryActualStock{display:block!important;width:100%!important;min-height:68px!important;box-sizing:border-box!important;background:#fff!important;color:#111!important;-webkit-text-fill-color:#111!important;border:3px solid #2f7d4a!important;border-radius:12px!important;font-size:38px!important;font-weight:950!important;text-align:center!important;opacity:1!important;pointer-events:auto!important;touch-action:manipulation!important;-webkit-user-select:text!important;user-select:text!important;caret-color:#111!important}
      #inventoryActualStock:focus{outline:4px solid rgba(47,125,74,.18)!important;outline-offset:2px!important}
    `;
    document.head.appendChild(style);
  }

  function currentSignature(){
    const box = document.getElementById("inventoryCountBox");
    const article = document.getElementById("inventoryCountArticle");
    if (!box || box.hidden || !article) return "";
    return String(article.textContent || "").trim();
  }

  function findCurrentItem(items, articleText){
    const text = String(articleText || "").toLowerCase();
    const withSku = (items || []).find(item => item?.stockCode && text.includes(String(item.stockCode).toLowerCase()));
    if (withSku) return withSku;
    return (items || []).find(item => {
      const product = String(item?.product || "").toLowerCase();
      const sizeA = String(item?.size || "").toLowerCase();
      const sizeB = sizeA.replace(".", ",");
      const base = String(item?.baseName || item?.baseCode || "").toLowerCase();
      return product && text.includes(product) && (!sizeA || text.includes(sizeA) || text.includes(sizeB)) && (!base || text.includes(base));
    }) || null;
  }

  function configureInput(){
    ensureStyle();
    let input = document.getElementById("inventoryActualStock");
    if (!input) return null;

    const target = document.getElementById("inventoryCountTarget");
    const targetBox = target?.closest(".inventory-count-value");
    if (targetBox) targetBox.classList.add("krista-hide-count-value");

    const diff = document.getElementById("inventoryCountDiff");
    const diffBox = diff?.closest(".inventory-count-value");
    if (diffBox) diffBox.classList.add("krista-hide-count-value");

    const inputBox = input.closest(".inventory-count-value");
    if (inputBox) {
      inputBox.classList.add("krista-ist-value");
      const label = inputBox.querySelector("b");
      if (label) label.textContent = "NEU GEZÄHLT · ANTIPPEN ZUM ÄNDERN";
    }

    if (input.dataset.kristaNativeInput !== "1") {
      // Alle alten Fokus-/Touch-Handler entfernen. Der Scanner greift beim Speichern
      // ohnehin immer per ID auf das aktuelle Feld zu.
      const fresh = input.cloneNode(true);
      input.replaceWith(fresh);
      input = fresh;
      input.dataset.kristaNativeInput = "1";

      input.addEventListener("input", () => {
        input.dataset.userEdited = "1";
      });
      input.addEventListener("focus", () => {
        // Nur echter Benutzer-Tap: Safari öffnet jetzt die native Zahlentastatur.
        setTimeout(() => {
          try { input.setSelectionRange(0, input.value.length); } catch {}
        }, 0);
      });
    }

    input.type = "text";
    input.inputMode = "numeric";
    input.setAttribute("inputmode", "numeric");
    input.setAttribute("pattern", "[0-9]*");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("enterkeyhint", "done");
    input.removeAttribute("readonly");
    input.disabled = false;

    const confirm = document.getElementById("inventoryCountConfirm");
    if (confirm && confirm.dataset.kristaEmptyGuard !== "1") {
      confirm.dataset.kristaEmptyGuard = "1";
      confirm.addEventListener("click", event => {
        const field = document.getElementById("inventoryActualStock");
        if (!field || String(field.value || "").trim() !== "") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        alert("Bitte den gezählten Ist-Stand eingeben.");
        field.focus();
      }, true);
    }

    return input;
  }

  async function syncVisibleCard(){
    const input = configureInput();
    const signature = currentSignature();
    if (!input || !signature || signature === lastSignature || syncing) return;

    lastSignature = signature;
    input.dataset.userEdited = "0";
    syncing = true;

    // Der alte Scanner fokussiert das Feld programmatisch nach dem Scan. Auf iOS
    // entsteht dadurch ein schwarzer Cursor ohne Tastatur. Fokus bewusst lösen.
    setTimeout(() => {
      try { document.getElementById("inventoryActualStock")?.blur(); } catch {}
    }, 80);

    try {
      const data = await api("/admin/api/paint/inventory");
      if (currentSignature() !== signature) return;
      const item = findCurrentItem(Array.isArray(data.items) ? data.items : [], signature);
      if (!item) return;

      previousStock = Math.max(0, Number(item.stock || 0));
      const field = configureInput();
      if (!field || field.dataset.userEdited === "1") return;

      // WICHTIG: Inventur startet mit dem echten bisherigen Lagerbestand – NICHT Soll.
      field.value = displayNumber(previousStock);
      field.placeholder = displayNumber(previousStock);

      const note = document.getElementById("inventoryCountNote");
      if (note) {
        note.classList.remove("zero");
        note.textContent = `Lager bisher: ${displayNumber(previousStock)}. Passt der Bestand, nur bestätigen. Sonst das Feld oben antippen und die gezählte Menge eingeben.`;
      }

      setTimeout(() => {
        try { field.blur(); } catch {}
      }, 30);
    } catch (error) {
      const status = document.getElementById("inventoryScanStatus");
      if (status) status.textContent = String(error?.message || error);
    } finally {
      syncing = false;
    }
  }

  function install(){
    configureInput();
    syncVisibleCard();
    if (!currentSignature()) lastSignature = "";
  }

  install();
  new MutationObserver(install).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["hidden"]
  });
})();
