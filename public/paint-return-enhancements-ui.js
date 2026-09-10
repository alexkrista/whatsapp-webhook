"use strict";
(function () {
  if (window.__kristineReturnEnhancementsLoaded) return;
  window.__kristineReturnEnhancementsLoaded = true;

  const qs = new URLSearchParams(location.search);
  const token = qs.get("token") || "";
  const tokenized = (url) => url + (url.includes("?") ? "&" : "?") + (token ? "token=" + encodeURIComponent(token) : "").replace(/[?&]$/, "");
  const el = (id) => document.getElementById(id);
  let colourTimer = null;
  let colourRequest = 0;

  async function api(url) {
    const response = await fetch(tokenized(url), { cache: "no-store" });
    const data = await response.json().catch(() => ({ ok: false, error: "Keine JSON-Antwort" }));
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function isLittleGreeneMaterial() {
    return /little\s*greene/i.test(String(el("returnMaterialNameView")?.textContent || ""));
  }

  function mergeColourOptions(results) {
    const list = el("returnColourList");
    if (!list) return;
    const values = new Set(Array.from(list.options || []).map((option) => option.value).filter(Boolean));
    for (const row of results || []) {
      const code = String(row?.code || row?.name || "").trim();
      const alt = String(row?.altCode || "").trim();
      if (code) values.add(code);
      if (alt && alt !== code) values.add(alt);
    }
    list.innerHTML = [...values]
      .sort((a, b) => a.localeCompare(b, "de", { numeric: true }))
      .slice(0, 180)
      .map((value) => `<option value="${value.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}"></option>`)
      .join("");
  }

  async function searchLgColours(value) {
    const q = String(value || "").trim();
    if (!isLittleGreeneMaterial() || q.length < 1) return;
    const request = ++colourRequest;
    try {
      const data = await api(`/admin/api/paint/search?system=LG&q=${encodeURIComponent(q)}`);
      if (request !== colourRequest) return;
      mergeColourOptions(Array.isArray(data.results) ? data.results : []);
    } catch {}
  }

  function attachColourSearch() {
    const colour = el("returnColour");
    if (!colour || colour.dataset.lgLookupAttached === "1") return;
    colour.dataset.lgLookupAttached = "1";
    colour.addEventListener("input", () => {
      clearTimeout(colourTimer);
      colourTimer = setTimeout(() => searchLgColours(colour.value), 130);
    });
    colour.addEventListener("focus", () => {
      if (colour.value) searchLgColours(colour.value);
    });
  }

  async function reprint(no, button) {
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = "drucke …";
    try {
      if (typeof window.kristinePrintReturnLabel !== "function") throw new Error("Lokaler Zebra-Dienst nicht bereit");
      const data = await api(`/admin/api/paint/returns?includeUsed=1&q=${encodeURIComponent(String(no))}`);
      const item = (Array.isArray(data.items) ? data.items : []).find((row) => Number(row.returnNo) === Number(no));
      if (!item) throw new Error(`Restfarbe ${no} nicht gefunden`);
      await window.kristinePrintReturnLabel(item);
      button.textContent = "gedruckt ✓";
      setTimeout(() => { button.textContent = oldText; button.disabled = false; }, 1200);
    } catch (error) {
      button.textContent = "Fehler";
      button.title = String(error?.message || error);
      setTimeout(() => { button.textContent = oldText; button.disabled = false; }, 1800);
    }
  }

  function enhanceRows() {
    const root = el("returnResults");
    if (!root) return;
    root.querySelectorAll(".return-row").forEach((row) => {
      if (row.dataset.returnEnhanced === "1") return;
      row.dataset.returnEnhanced = "1";
      const noNode = row.querySelector(".return-no");
      const side = row.querySelector(".return-side");
      const no = Number(String(noNode?.textContent || "").replace(/\D/g, ""));
      if (!no || !side) return;

      const sub = String(row.querySelector(".return-sub")?.textContent || "");
      if (/little\s*greene/i.test(sub) && noNode && !/^LG\s/i.test(noNode.textContent)) {
        noNode.textContent = `LG ${no}`;
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn return-reprint-btn";
      button.textContent = "Etikett nochmal";
      button.title = "Etikett nochmals auf Zebra drucken";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        reprint(no, button);
      });
      side.appendChild(button);
    });
  }

  function augment() {
    attachColourSearch();
    enhanceRows();

    if (!document.getElementById("returnEnhancementStyles")) {
      const style = document.createElement("style");
      style.id = "returnEnhancementStyles";
      style.textContent = `
        .return-reprint-btn{display:block;margin-top:7px;min-height:30px;padding:5px 8px;font-size:11px;font-weight:800}
        @media(max-width:760px){.return-reprint-btn{display:inline-block;margin-top:0;margin-left:8px}}
      `;
      document.head.appendChild(style);
    }
  }

  augment();
  const observer = new MutationObserver(augment);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
