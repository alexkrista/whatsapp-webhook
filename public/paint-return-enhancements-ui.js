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

  function attachColourSearch() {
    const colour = el("returnColour");
    if (!colour || colour.dataset.colourLookupAttached === "1") return;
    colour.dataset.colourLookupAttached = "1";
    colour.removeAttribute("list");
    colour.setAttribute("role", "combobox");
    colour.setAttribute("aria-autocomplete", "list");
    colour.setAttribute("aria-controls", "returnColourResults");
    colour.setAttribute("aria-expanded", "false");
    const list = document.createElement("div");
    list.id = "returnColourResults";
    list.className = "return-colour-results";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Farbvorschläge");
    list.hidden = true;
    colour.insertAdjacentElement("afterend", list);
    let hits = [];
    let active = -1;

    function close() {
      ++colourRequest;
      clearTimeout(colourTimer);
      list.hidden = true;
      hits = [];
      active = -1;
      colour.setAttribute("aria-expanded", "false");
      colour.removeAttribute("aria-activedescendant");
    }

    function select(row) {
      // altCode is a search alias, never the saved colour identifier.
      colour.value = String(row.code || row.name || "").trim();
      close();
      colour.dispatchEvent(new Event("change", { bubbles: true }));
    }

    async function search(q, request) {
      // Reuse the main search endpoint and its name/number/altCode scoring.
      const systems = ["LG", "RAL", "NCS"];
      const responses = await Promise.allSettled(systems.map((system) =>
        api(`/admin/api/paint/search?system=${system}&q=${encodeURIComponent(q)}`)));
      if (request !== colourRequest || colour.value.trim() !== q) return;
      hits = responses.flatMap((result, i) => result.status === "fulfilled" && Array.isArray(result.value.results)
        ? result.value.results.map((row) => ({ ...row, system: systems[i] })) : [])
        .filter((row) => String(row.code || row.name || "").trim())
        .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
      list.replaceChildren();
      active = -1;
      for (const [i, row] of hits.entries()) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "return-colour-hit";
        button.id = `returnColourHit-${i}`;
        button.setAttribute("role", "option");
        button.setAttribute("aria-selected", "false");
        button.tabIndex = -1;
        const title = document.createElement("b");
        title.textContent = row.name || row.code;
        const detail = document.createElement("span");
        detail.textContent = [row.system, row.code !== row.name ? row.code : "", row.altCode,
          ...(Array.isArray(row.aliases) ? row.aliases.slice(0, 2) : [])].filter(Boolean).join(" · ");
        button.append(title, detail);
        button.addEventListener("pointerdown", (event) => event.preventDefault());
        button.addEventListener("click", () => select(row));
        list.appendChild(button);
      }
      const failed = responses.flatMap((result, i) => result.status === "rejected" ? [systems[i]] : []);
      if (!hits.length || failed.length) {
        const message = document.createElement("div");
        message.className = "return-colour-message";
        message.setAttribute("role", "status");
        message.textContent = failed.length
          ? `Farbsuche für ${failed.join(", ")} nicht verfügbar. Bitte erneut versuchen oder Farbton frei eingeben.`
          : "Keine passende Farbe gefunden. Freie Eingabe ist möglich.";
        list.appendChild(message);
      }
      list.hidden = false;
      colour.setAttribute("aria-expanded", "true");
    }

    function schedule() {
      close(); // Invalidate in-flight answers immediately, including during debounce.
      const q = colour.value.trim();
      if (!q) return;
      const request = colourRequest;
      colourTimer = setTimeout(() => search(q, request), 130);
    }
    colour.addEventListener("input", schedule);
    colour.addEventListener("focus", schedule);
    colour.addEventListener("blur", close);
    colour.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { close(); return; }
      if (list.hidden || !hits.length) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        active = (active + (event.key === "ArrowDown" ? 1 : active < 0 ? 0 : -1) + hits.length) % hits.length;
        list.querySelectorAll('[role="option"]').forEach((node, i) => node.setAttribute("aria-selected", String(i === active)));
        colour.setAttribute("aria-activedescendant", `returnColourHit-${active}`);
        el(`returnColourHit-${active}`)?.scrollIntoView?.({ block: "nearest" });
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopImmediatePropagation(); // Do not start weighing before the colour is selected.
        select(hits[active < 0 ? 0 : active]);
      }
    }, true);
    const card = el("returnMaterialCard");
    if (card) new MutationObserver(close).observe(card, { attributes: true, attributeFilter: ["hidden"] });
    const material = el("returnMaterialNameView");
    if (material) new MutationObserver(close).observe(material, { childList: true, subtree: true, characterData: true });
    document.addEventListener("pointerdown", (event) => {
      if (event.target !== colour && !list.contains(event.target)) close();
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
        .return-colour-results{max-height:300px;overflow:auto;border:1px solid var(--line,#ccd2c9);border-radius:8px;background:#fff;margin-top:5px}
        .return-colour-results[hidden]{display:none}
        .return-colour-hit{display:block;width:100%;text-align:left;background:#fff;color:inherit;border:0;border-bottom:1px solid var(--line,#ccd2c9);padding:10px 12px;min-height:48px;cursor:pointer;font:inherit}
        .return-colour-hit:hover,.return-colour-hit[aria-selected="true"]{background:#edf3e9}
        .return-colour-hit span{display:block;font-size:12px;color:#596058;margin-top:3px}
        .return-colour-message{padding:10px 12px;font-size:13px;color:#596058}
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
