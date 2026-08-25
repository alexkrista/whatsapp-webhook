"use strict";
(function () {
  const qs = new URLSearchParams(location.search);
  const token = qs.get("token") || "";
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  const fmtDate = value => {
    if (!value) return "";
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat("de-AT", { dateStyle:"short", timeStyle:"short" }).format(d);
  };
  const fmtNum = value => new Intl.NumberFormat("de-AT", { maximumFractionDigits: 2 }).format(Number(value || 0));
  const money = value => new Intl.NumberFormat("de-AT", { style:"currency", currency:"EUR" }).format(Number(value || 0));

  async function api(url, opt = {}) {
    const join = url.includes("?") ? "&" : "?";
    const response = await fetch(url + (token ? join + "token=" + encodeURIComponent(token) : ""), {
      ...opt,
      headers: { "Content-Type":"application/json", ...(opt.headers || {}) },
    });
    const data = await response.json().catch(() => ({ ok:false, error:"Keine JSON-Antwort" }));
    if (!response.ok || data.ok === false) throw new Error(data.error || ("HTTP " + response.status));
    return data;
  }

  function installStyle() {
    if (document.getElementById("paintMixHistoryStyle")) return;
    const style = document.createElement("style");
    style.id = "paintMixHistoryStyle";
    style.textContent = `
      .mixhist-card{border:1px solid #d9dfd9;background:#fbfcfa;margin-top:14px}.mixhist-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}.mixhist-head h2{margin:0}.mixhist-status{font-size:12px;color:#667068;margin-top:4px}.mixhist-list{display:grid;gap:10px;margin-top:12px}.mixhist-row{border:1px solid #e0e4df;border-radius:12px;background:white;padding:11px}.mixhist-title{font-weight:950;font-size:15px}.mixhist-meta{font-size:12px;color:#667068;margin-top:3px}.mixhist-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}.mixhist-project{display:grid;grid-template-columns:minmax(220px,1fr) auto;gap:7px;margin-top:8px}.mixhist-project[hidden]{display:none!important}.mixhist-empty{padding:12px;border-radius:10px;background:#f1f5f1;color:#536056}.mixhist-stats{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.mixhist-kpi{border:1px solid #dde2dd;border-radius:10px;padding:8px 10px;background:white;font-size:12px}.mixhist-kpi b{display:block;font-size:18px}.mixhist-note{font-size:11px;color:#788078;margin-top:8px}
      @media(max-width:750px){.mixhist-actions .btn{flex:1 1 45%;min-height:48px}.mixhist-project{grid-template-columns:1fr}.mixhist-project .btn{min-height:48px}}
    `;
    document.head.appendChild(style);
  }

  function installCard() {
    const tab = document.getElementById("tab-scan");
    if (!tab || document.getElementById("mixHistoryCard")) return false;
    const card = document.createElement("div");
    card.id = "mixHistoryCard";
    card.className = "card mixhist-card";
    card.innerHTML = `
      <div class="mixhist-head">
        <div><h2>Mischmaschinen-History</h2><div id="mixHistoryStatus" class="mixhist-status">Wird geladen …</div></div>
        <button id="mixHistoryReload" class="btn" type="button">Neu laden</button>
      </div>
      <div id="mixHistoryStats" class="mixhist-stats"></div>
      <div id="mixHistoryList" class="mixhist-list"></div>
      <div class="mixhist-note">Neue Mischungen erzeugen eine KRISTINE-Aufgabe. Erst mit Verkauf/Baustelle/Lager/Fehlmischung wird der Lagerabgang gebucht.</div>`;
    const grid = tab.querySelector(".grid2");
    if (grid) grid.insertAdjacentElement("afterend", card); else tab.prepend(card);
    document.getElementById("mixHistoryReload")?.addEventListener("click", loadAll);
    return true;
  }

  let jobs = null;
  async function loadJobs() {
    if (jobs) return jobs;
    const data = await api("/admin/api/paint/jobs");
    jobs = Array.isArray(data.jobs) ? data.jobs : [];
    return jobs;
  }

  function projectPicker(row) {
    const wrap = document.createElement("div");
    wrap.className = "mixhist-project"; wrap.hidden = true;
    const select = document.createElement("select"); select.className = "field";
    const save = document.createElement("button"); save.className = "btn primary"; save.type = "button"; save.textContent = "Baustelle buchen";
    wrap.append(select, save); row.appendChild(wrap);
    return { wrap, select, save };
  }

  async function resolve(id, resolution, extra = {}, button = null) {
    const old = button?.textContent || "";
    if (button) { button.disabled = true; button.textContent = "…"; }
    try {
      await api(`/admin/api/paint/mix-history/${encodeURIComponent(id)}/resolve`, {
        method: "POST", body: JSON.stringify({ resolution, user:"Farben / Lager", ...extra }),
      });
      document.dispatchEvent(new CustomEvent("kristine:paint-stock-changed", { detail:{ source:"mix-history" } }));
      await loadAll();
    } catch (error) {
      alert(String(error?.message || error));
      if (button) button.textContent = old;
    } finally { if (button) button.disabled = false; }
  }

  function renderRows(items) {
    const list = document.getElementById("mixHistoryList");
    if (!list) return;
    list.innerHTML = "";
    if (!items.length) {
      list.innerHTML = '<div class="mixhist-empty">Keine offene Mischung zum Zuordnen.</div>';
      return;
    }
    for (const item of items) {
      const row = document.createElement("div"); row.className = "mixhist-row";
      const tone = item.colourCode || item.colourName || "Farbton unbekannt";
      row.innerHTML = `
        <div class="mixhist-title">${esc(tone)} · ${esc(item.productName || "Produkt unbekannt")}</div>
        <div class="mixhist-meta">${esc(item.baseName || item.baseCode || "Basis ?")} · ${esc(item.size || "Gebinde ?")} · ${fmtDate(item.mixedAt)}${item.machine ? ` · ${esc(item.machine)}` : ""}</div>
        <div class="mixhist-actions">
          <button class="btn primary" data-resolution="sale" type="button">Verkauf</button>
          <button class="btn" data-resolution="project" type="button">Baustelle</button>
          <button class="btn" data-resolution="stock" type="button">Lager</button>
          <button class="btn" data-resolution="waste" type="button">Fehlmischung</button>
        </div>`;
      const picker = projectPicker(row);
      row.querySelector('[data-resolution="sale"]')?.addEventListener("click", event => resolve(item.id, "sale", {}, event.currentTarget));
      row.querySelector('[data-resolution="stock"]')?.addEventListener("click", event => resolve(item.id, "stock", {}, event.currentTarget));
      row.querySelector('[data-resolution="waste"]')?.addEventListener("click", event => resolve(item.id, "waste", {}, event.currentTarget));
      row.querySelector('[data-resolution="project"]')?.addEventListener("click", async event => {
        const button = event.currentTarget; button.disabled = true;
        try {
          const rows = await loadJobs();
          picker.select.innerHTML = rows.map(job => `<option value="${esc(job.id)}" data-name="${esc(job.name || "")}">${esc(job.id)} · ${esc(job.name || "")}</option>`).join("");
          picker.wrap.hidden = !picker.wrap.hidden;
        } catch (error) { alert(String(error?.message || error)); }
        finally { button.disabled = false; }
      });
      picker.save.addEventListener("click", () => {
        const option = picker.select.selectedOptions[0]; if (!option) return;
        resolve(item.id, "project", { jobId:picker.select.value, jobName:option.dataset.name || option.textContent || "" }, picker.save);
      });
      list.appendChild(row);
    }
  }

  function renderStats(data) {
    const box = document.getElementById("mixHistoryStats"); if (!box) return;
    const sale = data.sale || {}, project = data.project || {}, waste = data.waste || {};
    box.innerHTML = `
      <div class="mixhist-kpi"><span>Verkauf ${esc(data.year || "")}</span><b>${fmtNum(sale.pieces)} Dosen</b>${fmtNum(sale.liters)} L · ${money(sale.value)}</div>
      <div class="mixhist-kpi"><span>Baustellen</span><b>${fmtNum(project.pieces)} Dosen</b>${fmtNum(project.liters)} L</div>
      <div class="mixhist-kpi"><span>Fehlmischung</span><b>${fmtNum(waste.pieces)} Dosen</b>${fmtNum(waste.liters)} L</div>`;
  }

  async function loadAll() {
    const status = document.getElementById("mixHistoryStatus");
    try {
      if (status) status.textContent = "Misch-History wird geladen …";
      const [history, sync, stats] = await Promise.all([
        api("/admin/api/paint/mix-history?status=open"), api("/admin/api/paint/mix-history/status"), api("/admin/api/paint/sales-stats"),
      ]);
      renderRows(history.items || []); renderStats(stats);
      const last = sync.state?.lastSyncAt ? fmtDate(sync.state.lastSyncAt) : "noch kein Sync";
      if (status) status.textContent = `${history.count || 0} offen · letzte History-Prüfung ${last} · ${sync.schedule || ""}`;
    } catch (error) { if (status) status.textContent = String(error?.message || error); }
  }

  installStyle();
  if (!installCard()) {
    const observer = new MutationObserver(() => { if (installCard()) { observer.disconnect(); loadAll(); } });
    observer.observe(document.body, { childList:true, subtree:true });
  } else loadAll();
})();
