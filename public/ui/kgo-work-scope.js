"use strict";

(() => {
  const VERSION = "2026-08-26-work-scope-1";
  const token = new URLSearchParams(location.search).get("token") || "";
  let lastJobId = "";
  let loadSerial = 0;

  const esc = value => String(value ?? "").replace(/[&<>\"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[char]));
  function authenticatedUrl(path) {
    const url = new URL(path, location.origin);
    if (token) url.searchParams.set("token", token);
    return url.pathname + url.search;
  }
  async function api(path) {
    const response = await fetch(authenticatedUrl(path), { credentials: "same-origin", headers: { Accept: "application/json" } });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!response.ok || data?.ok === false) throw new Error(data?.error || text || `HTTP ${response.status}`);
    return data || {};
  }
  function installCss() {
    if (document.getElementById("kgWorkScopeCss")) return;
    const style = document.createElement("style");
    style.id = "kgWorkScopeCss";
    style.textContent = `
      .kg-scope-card{margin:14px 0;background:#fff;border:1px solid rgba(16,35,63,.12);border-radius:20px;padding:15px;box-shadow:0 8px 24px rgba(16,35,63,.06)}
      .kg-scope-card.kg-hidden{display:none!important}.kg-scope-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px}.kg-scope-head h2{margin:2px 0 0;font-size:17px}.kg-scope-head small{color:#657387;font-size:11px}.kg-scope-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.kg-scope-group{border:1px solid #e1e5e9;border-radius:14px;padding:10px;background:#f8fafb}.kg-scope-group h3{margin:0 0 7px;font-size:12px;display:flex;align-items:center;gap:6px}.kg-scope-group ul{margin:0;padding-left:17px}.kg-scope-group li{font-size:12px;line-height:1.4;margin:5px 0;color:#28384d}.kg-scope-group li strong{font-size:11px;color:#8a5a16}.kg-scope-group.regie{background:#fff7e7;border-color:#ead2a4}.kg-scope-group.add-order{background:#eef5fb;border-color:#cbdcec}.kg-scope-group.add-regie{background:#f7eff8;border-color:#dfcce1}.kg-scope-empty{font-size:11px;color:#7a8796}.kg-scope-rule{margin-top:10px;padding:9px 10px;border-radius:11px;background:#fff2dd;color:#754d1d;font-size:11px;font-weight:850;line-height:1.4}.kg-scope-loading{font-size:11px;color:#657387}
      @media(max-width:560px){.kg-scope-grid{grid-template-columns:1fr}.kg-scope-card{padding:12px}}
    `;
    document.head.appendChild(style);
  }
  function installCard() {
    if (document.getElementById("kgWorkScopeCard")) return document.getElementById("kgWorkScopeCard");
    const site = document.querySelector(".kg-site-card");
    if (!site) return null;
    const card = document.createElement("section");
    card.id = "kgWorkScopeCard";
    card.className = "kg-scope-card kg-hidden";
    card.innerHTML = '<div class="kg-scope-loading">Auftragsumfang wird geladen …</div>';
    site.insertAdjacentElement("afterend", card);
    return card;
  }
  function jobIdFromSiteTitle() {
    const title = String(document.getElementById("kgSiteTitle")?.textContent || "").trim();
    if (!title || /Keine Baustelle/i.test(title)) return "";
    const match = title.match(/^([A-Za-z0-9_-]+)\s*(?:–|-|$)/);
    return match ? match[1] : "";
  }
  function group(title, klass, rows, icon) {
    return `<div class="kg-scope-group ${klass}"><h3><span>${icon}</span>${esc(title)}</h3>${rows.length ? `<ul>${rows.map(row => `<li>${esc(row.text || row.title || "Position")}${Number(row.plannedHours || 0) > 0 ? ` · <strong>${Number(row.plannedHours).toLocaleString("de-AT", { maximumFractionDigits: 1 })} h</strong>` : ""}</li>`).join("")}</ul>` : '<div class="kg-scope-empty">–</div>'}</div>`;
  }
  function render(data) {
    const card = installCard();
    if (!card) return;
    if (!data?.hasCalculation) {
      card.classList.add("kg-hidden");
      return;
    }
    const scope = data.scope || {};
    const order = Array.isArray(scope.order) ? scope.order : [];
    const regie = Array.isArray(scope.regie) ? scope.regie : [];
    const addOrder = Array.isArray(scope.addOrder) ? scope.addOrder : [];
    const addRegie = Array.isArray(scope.addRegie) ? scope.addRegie : [];
    card.classList.remove("kg-hidden");
    card.innerHTML = `<div class="kg-scope-head"><div><div class="kg-eyebrow">Auftrag kurz & klar</div><h2>Was ist hier beauftragt?</h2></div><small>ohne Preise</small></div><div class="kg-scope-grid">${group("Auftrag", "", order, "✓")}${group("Regie", "regie", regie, "≡")}${group("Nachtrag Auftrag", "add-order", addOrder, "+")}${group("Nachtrag Regie", "add-regie", addRegie, "+≡")}</div>${regie.length || addRegie.length ? '<div class="kg-scope-rule">Regie nur auf den orange/violett markierten Positionen erfassen. Alles andere gehört zum Auftrag.</div>' : ''}`;
  }
  async function loadForCurrentSite(force = false) {
    const jobId = jobIdFromSiteTitle();
    if (!jobId) {
      lastJobId = "";
      document.getElementById("kgWorkScopeCard")?.classList.add("kg-hidden");
      return;
    }
    if (!force && jobId === lastJobId) return;
    lastJobId = jobId;
    const serial = ++loadSerial;
    const card = installCard();
    if (card) { card.classList.remove("kg-hidden"); card.innerHTML = '<div class="kg-scope-loading">Auftragsumfang wird geladen …</div>'; }
    try {
      const data = await api(`/kristine/api/job/${encodeURIComponent(jobId)}/work-scope`);
      if (serial !== loadSerial) return;
      render(data);
    } catch {
      if (serial !== loadSerial) return;
      card?.classList.add("kg-hidden");
    }
  }
  function install() {
    installCss();
    const title = document.getElementById("kgSiteTitle");
    if (!title) return setTimeout(install, 120);
    installCard();
    new MutationObserver(() => setTimeout(() => loadForCurrentSite(), 20)).observe(title, { childList: true, characterData: true, subtree: true });
    const employee = document.getElementById("kgEmployeeName");
    if (employee) new MutationObserver(() => { lastJobId = ""; setTimeout(() => loadForCurrentSite(true), 80); }).observe(employee, { childList: true, characterData: true, subtree: true });
    setTimeout(() => loadForCurrentSite(true), 250);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
  window.KGOOrderScope = { version: VERSION, reload: () => loadForCurrentSite(true) };
})();
