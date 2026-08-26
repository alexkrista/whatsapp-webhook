"use strict";

(() => {
  const VERSION = "2026-08-26-kalk-grid-v2";
  const token = new URLSearchParams(location.search).get("token") || "";
  let currentJobId = "";
  let metaRows = [];
  let calcRows = [];
  let loaded = false;
  let observer = null;
  let enhanceQueued = false;
  let nextRegieMaterial = false;
  let saveBusy = false;

  const COMPONENT_LABELS = {
    arbeit: "Arbeit",
    material: "Material",
    maschine: "Maschine",
    leistung: "Leistung",
    sonstiges: "Sonstiges",
  };

  const num = value => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  };
  const money = value => new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num(value));
  const hours = value => new Intl.NumberFormat("de-AT", { maximumFractionDigits: 1 }).format(num(value)) + " h";
  const tokenUrl = path => {
    const url = new URL(path, location.origin);
    if (token && url.origin === location.origin) url.searchParams.set("token", token);
    return url.origin === location.origin ? url.pathname + url.search + url.hash : url.href;
  };
  async function api(path, options = {}) {
    const response = await fetch(tokenUrl(path), options);
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!response.ok || data?.ok === false) throw new Error(data?.error || text || response.statusText);
    return data || {};
  }
  function jobId() {
    return decodeURIComponent(location.hash.slice(1) || "").trim();
  }
  function euro(value) {
    const n = Number(String(value ?? "").replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }
  function roundMoney(value) {
    return Math.round((num(value) + Number.EPSILON) * 100) / 100;
  }
  function parseDescription(description) {
    const source = String(description || "").replace(/\s+/g, " ").trim();
    const qtyMatch = source.match(/(?:^|\s)(\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+(?:,\d+)?)\s*(Std|VE|Stk\.?|Stück|Stueck|m²|m2|lfm|Psch\.?|Pausch\.?|pauschal|m)\b/i);
    const quantity = qtyMatch ? euro(qtyMatch[1]) : 0;
    const unit = qtyMatch ? String(qtyMatch[2]).replace(/\.$/, "") : "";
    const values = source.match(/\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}/g) || [];
    const total = values.length ? euro(values[values.length - 1]) : 0;
    let unitPrice = values.length >= 3 ? euro(values[values.length - 2]) : 0;
    if (!unitPrice && quantity > 0 && total > 0) unitPrice = total / quantity;
    const hay = source.toLowerCase();
    let componentType = "leistung";
    if (/material|farbe|lack|grundierung|spachtel|kleber|vlies|tapete|material\s+und\s+maschinen/.test(hay)) componentType = "material";
    else if (/maschine|gerät|geraet|miete/.test(hay)) componentType = "maschine";
    else if (/^std$/i.test(unit)) componentType = "arbeit";
    return { quantity, unit, unitPrice: roundMoney(unitPrice), total: roundMoney(total), componentType };
  }

  function installCss() {
    if (document.getElementById("kgridv2Css")) return;
    const style = document.createElement("style");
    style.id = "kgridv2Css";
    style.textContent = `
      .kcv2-table.kgridv2-table{min-width:1280px}.kgridv2-table th,.kgridv2-table td{padding:7px 5px}.kgridv2-table .kgrid-check{width:42px;text-align:center}.kgridv2-table .kgrid-pos{width:62px}.kgridv2-table .kgrid-kind{width:132px}.kgridv2-table .kgrid-component{width:102px}.kgridv2-table .kgrid-text{width:250px}.kgridv2-table .kgrid-qty{width:84px}.kgridv2-table .kgrid-unit{width:72px}.kgridv2-table .kgrid-price{width:96px}.kgridv2-table .kgrid-total{width:105px}.kgridv2-table .kgrid-hours{width:82px}.kgridv2-table .kgrid-ma{width:48px;text-align:center}.kgridv2-table input.kgrid-number{text-align:right}.kgridv2-table select.kgrid-component-select{font-size:10.5px;padding:7px 5px}.kgridv2-table input[data-field="shortText"]{min-width:220px}.kgridv2-table input[type="checkbox"]{accent-color:#2f7d4a}.kgridv2-calcnote{font-size:9px;color:#707670;margin-top:3px}.kgridv2-calcnote.off{color:#a84540;font-weight:850}.kgridv2-material-btn{background:#f6eef7!important;border-color:#d7bddb!important;color:#65416a!important}.kgridv2-total-auto{background:#f7f8f5!important}.kgridv2-meta-badge{display:inline-flex;margin-left:5px;padding:2px 5px;border-radius:999px;background:#eef6ef;color:#326342;font-size:8px;font-weight:900}
      @media(max-width:700px){.kcv2-table.kgridv2-table{min-width:1160px}.kgridv2-table .kgrid-text{width:210px}.kgridv2-table input[data-field="shortText"]{min-width:190px}}
    `;
    document.head.appendChild(style);
  }
  function setBaseValue(input, value, eventName = "input") {
    if (!input) return;
    const next = String(value ?? "");
    if (String(input.value) === next) return;
    input.dataset.kgridSync = "1";
    input.value = next;
    input.dispatchEvent(new Event(eventName, { bubbles: true }));
    delete input.dataset.kgridSync;
  }
  function metaForRow(tr, index) {
    const saved = metaRows[index] || {};
    const description = tr.querySelector('[data-field="shortText"]')?.getAttribute("title") || tr.querySelector('[data-field="shortText"]')?.value || "";
    const inferred = parseDescription(description);
    const baseHours = num(tr.querySelector('[data-field="plannedHours"]')?.value);
    const componentType = saved.componentType || (baseHours > 0 ? "arbeit" : inferred.componentType);
    const meta = {
      positionId: saved.positionId || calcRows[index]?.id || "",
      quantity: saved.quantity > 0 ? num(saved.quantity) : inferred.quantity,
      unit: saved.unit || inferred.unit,
      unitPrice: saved.unitPrice > 0 ? num(saved.unitPrice) : inferred.unitPrice,
      componentType,
      calcIncluded: saved.calcIncluded !== false,
    };
    metaRows[index] = meta;
    return meta;
  }
  function rowInfo(tr, index) {
    const kind = tr.querySelector('[data-field="kind"]')?.value || "auftrag";
    const amount = num(tr.querySelector('[data-field="amount"]')?.value);
    const plannedHours = num(tr.querySelector('[data-field="plannedHours"]')?.value);
    const number = String(tr.querySelector(".kcv2-pos")?.textContent || "").trim();
    const addToContract = calcRows[index]?.addToContract === true || (/^N\d+/i.test(number) && /^nachtrag_/.test(kind));
    return { kind, amount, plannedHours, number, addToContract, meta: metaForRow(tr, index) };
  }
  function componentOptions(selected) {
    return Object.entries(COMPONENT_LABELS).map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join("");
  }
  function checkboxCell(meta) {
    const td = document.createElement("td");
    td.className = "kgrid-check";
    td.innerHTML = `<input type="checkbox" data-kgrid-field="calcIncluded" ${meta.calcIncluded !== false ? "checked" : ""} title="In Kalkulation einrechnen"><div class="kgridv2-calcnote ${meta.calcIncluded === false ? "off" : ""}">${meta.calcIncluded === false ? "aus" : "Σ"}</div>`;
    return td;
  }
  function componentCell(meta) {
    const td = document.createElement("td");
    td.className = "kgrid-component";
    td.innerHTML = `<select data-kgrid-field="componentType" class="kgrid-component-select">${componentOptions(meta.componentType)}</select>`;
    return td;
  }
  function inputCell(field, value, className, step = "0.01", type = "number") {
    const td = document.createElement("td");
    td.className = className;
    td.innerHTML = `<input data-kgrid-field="${field}" class="${type === "number" ? "kgrid-number" : ""}" type="${type}" ${type === "number" ? `min="0" step="${step}"` : ""} value="${String(value ?? "").replace(/"/g, "&quot;")}">`;
    return td;
  }
  function transformHeader(table) {
    const row = table.querySelector("thead tr");
    if (!row || row.dataset.kgridV2) return;
    row.dataset.kgridV2 = "1";
    row.innerHTML = `<th class="kgrid-check" title="In Kalkulation einrechnen">Σ</th><th class="kgrid-pos">Pos.</th><th class="kgrid-kind">Art</th><th class="kgrid-component">Typ</th><th class="kgrid-text">Text</th><th class="kgrid-qty num">Menge</th><th class="kgrid-unit">Einh.</th><th class="kgrid-price num">Preis</th><th class="kgrid-total num">Gesamt</th><th class="kgrid-hours num">Regie h</th><th class="kgrid-ma" title="Für Mitarbeiter sichtbar">MA</th><th style="width:34px"></th>`;
  }
  function syncRegieHours(tr, meta) {
    const kind = tr.querySelector('[data-field="kind"]')?.value || "";
    const hourInput = tr.querySelector('[data-field="plannedHours"]');
    if (!["regie", "nachtrag_regie"].includes(kind)) return;
    if (meta.componentType !== "arbeit") {
      setBaseValue(hourInput, 0);
      return;
    }
    if (/^std$/i.test(meta.unit) && meta.quantity > 0) setBaseValue(hourInput, meta.quantity);
  }
  function syncTotal(tr, meta) {
    const amountInput = tr.querySelector('[data-field="amount"]');
    if (!amountInput) return;
    if (meta.quantity > 0 && meta.unitPrice >= 0 && String(tr.querySelector('[data-kgrid-field="unitPrice"]')?.value || "") !== "") {
      const total = roundMoney(meta.quantity * meta.unitPrice);
      setBaseValue(amountInput, total.toFixed(2));
    }
  }
  function bindEnhancedRow(tr, index) {
    if (tr.dataset.kgridV2) return;
    const cells = [...tr.children];
    if (cells.length < 7) return;
    const meta = metaForRow(tr, index);
    const posCell = cells[0], kindCell = cells[1], textCell = cells[2], amountCell = cells[3], hoursCell = cells[4], maCell = cells[5];
    posCell.classList.add("kgrid-pos"); kindCell.classList.add("kgrid-kind"); textCell.classList.add("kgrid-text"); amountCell.classList.add("kgrid-total"); hoursCell.classList.add("kgrid-hours"); maCell.classList.add("kgrid-ma");
    const check = checkboxCell(meta);
    tr.insertBefore(check, posCell);
    const component = componentCell(meta);
    tr.insertBefore(component, textCell);
    const qty = inputCell("quantity", meta.quantity || "", "kgrid-qty", "0.01");
    const unit = inputCell("unit", meta.unit || "", "kgrid-unit", "", "text");
    const price = inputCell("unitPrice", meta.unitPrice || "", "kgrid-price", "0.01");
    tr.insertBefore(qty, amountCell);
    tr.insertBefore(unit, amountCell);
    tr.insertBefore(price, amountCell);
    amountCell.querySelector('[data-field="amount"]')?.classList.add("kgridv2-total-auto");
    tr.dataset.kgridV2 = "1";

    const included = tr.querySelector('[data-kgrid-field="calcIncluded"]');
    included?.addEventListener("change", () => {
      meta.calcIncluded = !!included.checked;
      const note = included.parentElement.querySelector(".kgridv2-calcnote");
      if (note) { note.textContent = meta.calcIncluded ? "Σ" : "aus"; note.classList.toggle("off", !meta.calcIncluded); }
      refreshSummary();
    });
    const componentSelect = tr.querySelector('[data-kgrid-field="componentType"]');
    componentSelect?.addEventListener("change", () => {
      meta.componentType = componentSelect.value;
      syncRegieHours(tr, meta);
      refreshSummary();
    });
    const qtyInput = tr.querySelector('[data-kgrid-field="quantity"]');
    qtyInput?.addEventListener("input", () => {
      meta.quantity = num(qtyInput.value);
      syncTotal(tr, meta);
      syncRegieHours(tr, meta);
      refreshSummary();
    });
    const unitInput = tr.querySelector('[data-kgrid-field="unit"]');
    unitInput?.addEventListener("input", () => {
      meta.unit = unitInput.value.trim();
      syncRegieHours(tr, meta);
      refreshSummary();
    });
    const priceInput = tr.querySelector('[data-kgrid-field="unitPrice"]');
    priceInput?.addEventListener("input", () => {
      meta.unitPrice = num(priceInput.value);
      syncTotal(tr, meta);
      refreshSummary();
    });
    const amountInput = tr.querySelector('[data-field="amount"]');
    amountInput?.addEventListener("input", () => {
      if (amountInput.dataset.kgridSync) return;
      if (meta.quantity > 0) {
        meta.unitPrice = roundMoney(num(amountInput.value) / meta.quantity);
        const p = tr.querySelector('[data-kgrid-field="unitPrice"]');
        if (p) p.value = meta.unitPrice ? String(meta.unitPrice) : "";
      }
      refreshSummary();
    });
    tr.querySelector('[data-field="plannedHours"]')?.addEventListener("input", refreshSummary);
    tr.querySelector('[data-field="kind"]')?.addEventListener("change", () => {
      syncRegieHours(tr, meta);
      refreshSummary();
    });
    tr.querySelector('[data-field="employeeVisible"]')?.setAttribute("title", "Nur Sichtbarkeit für Mitarbeiter – ändert die Kalkulationssumme nicht");
  }
  function addMaterialButton() {
    const actions = document.querySelector("#kcv2Rows")?.closest(".kcv2-card")?.querySelector(".kcv2-actions");
    if (!actions || document.getElementById("kgridAddRegieMaterial")) return;
    const button = document.createElement("button");
    button.id = "kgridAddRegieMaterial";
    button.type = "button";
    button.className = "kgridv2-material-btn";
    button.textContent = "+ Nachtrag Regie Material";
    button.title = "Regie-Nachtrag als Materialposition – ohne Regiestunden";
    button.addEventListener("click", () => {
      nextRegieMaterial = true;
      document.getElementById("kcv2AddRegie")?.click();
      queueEnhance();
    });
    actions.appendChild(button);
  }
  function applyNextMaterial() {
    if (!nextRegieMaterial) return;
    const rows = [...document.querySelectorAll("#kcv2Rows tr[data-index]")];
    const tr = rows.at(-1);
    if (!tr || !tr.dataset.kgridV2) return;
    const index = Number(tr.dataset.index);
    const meta = metaForRow(tr, index);
    meta.componentType = "material";
    meta.unit = meta.unit || "VE";
    const component = tr.querySelector('[data-kgrid-field="componentType"]'); if (component) component.value = "material";
    const unit = tr.querySelector('[data-kgrid-field="unit"]'); if (unit) unit.value = meta.unit;
    setBaseValue(tr.querySelector('[data-field="plannedHours"]'), 0);
    nextRegieMaterial = false;
    tr.querySelector('[data-field="shortText"]')?.focus();
    refreshSummary();
  }
  function refreshSummary() {
    const rows = [...document.querySelectorAll("#kcv2Rows tr[data-index]")];
    if (!rows.length) return;
    const infos = rows.map((tr, index) => rowInfo(tr, index));
    const original = infos.filter(row => !row.addToContract);
    const anyExcluded = original.some(row => row.meta.calcIncluded === false);
    const originalIncluded = original.filter(row => row.meta.calcIncluded !== false);
    const net = num(document.getElementById("kcv2Net")?.value);
    const selectedBase = anyExcluded ? originalIncluded.reduce((s, row) => s + row.amount, 0) : (net || originalIncluded.reduce((s, row) => s + row.amount, 0));
    const added = infos.filter(row => row.addToContract && row.meta.calcIncluded !== false).reduce((s, row) => s + row.amount, 0);
    const included = infos.filter(row => row.meta.calcIncluded !== false);
    const contract = selectedBase + added;
    const regie = included.filter(row => ["regie", "nachtrag_regie"].includes(row.kind)).reduce((s, row) => s + row.amount, 0);
    const external = included.filter(row => row.kind === "fremdleistung").reduce((s, row) => s + row.amount, 0);
    const other = included.filter(row => row.kind === "sonstiges").reduce((s, row) => s + row.amount, 0);
    const fixed = Math.max(0, contract - regie - external - other);
    const pct = Math.min(100, num(document.getElementById("kcv2Material")?.value));
    const material = fixed * pct / 100;
    const labor = Math.max(0, fixed - material);
    const rate = num(document.getElementById("kcv2Rate")?.value);
    const target = rate > 0 ? labor / rate : 0;
    const plannedRegie = included.filter(row => ["regie", "nachtrag_regie"].includes(row.kind) && row.meta.componentType === "arbeit").reduce((s, row) => s + row.plannedHours, 0);
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    set("kcv2SumContract", money(contract));
    set("kcv2SumRegie", `${money(regie)} · ${hours(plannedRegie)}`);
    set("kcv2SumExternal", money(external));
    set("kcv2SumOther", money(other));
    set("kcv2SumFixed", money(fixed));
    set("kcv2SumMaterial", `${money(material)} · ${pct.toLocaleString("de-AT", { maximumFractionDigits: 1 })} %`);
    set("kcv2SumLabor", money(labor));
    set("kcv2SumHours", hours(target));
    const contractCard = document.getElementById("kcv2SumContract")?.closest(".kcv2-kpi");
    if (contractCard) {
      let badge = contractCard.querySelector(".kgridv2-meta-badge");
      if (anyExcluded) {
        if (!badge) { badge = document.createElement("span"); badge.className = "kgridv2-meta-badge"; contractCard.appendChild(badge); }
        badge.textContent = "neu aus Auswahl";
      } else badge?.remove();
    }
  }
  function collectMeta() {
    return [...document.querySelectorAll("#kcv2Rows tr[data-index]")].map((tr, index) => {
      const meta = metaForRow(tr, index);
      return {
        positionId: calcRows[index]?.id || meta.positionId || "",
        quantity: num(tr.querySelector('[data-kgrid-field="quantity"]')?.value),
        unit: String(tr.querySelector('[data-kgrid-field="unit"]')?.value || "").trim(),
        unitPrice: num(tr.querySelector('[data-kgrid-field="unitPrice"]')?.value),
        componentType: tr.querySelector('[data-kgrid-field="componentType"]')?.value || meta.componentType || "leistung",
        calcIncluded: !!tr.querySelector('[data-kgrid-field="calcIncluded"]')?.checked,
      };
    });
  }
  async function refreshOuterNumbers() {
    try {
      const data = await api("/admin/api/jobs");
      const j = (data.jobs || []).find(row => String(row.jobId) === String(currentJobId));
      if (!j) return;
      const c = j.calculation || {};
      const actual = num(c.orderHours ?? c.actualHours), target = num(c.calculatedHours);
      const open = j.status === "Auftrag" ? Math.max(0, target) : j.status === "Laufend" ? Math.max(0, target - actual) : 0;
      const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
      set("detailAmount", money(j.contractAmount ?? c.contractAmount));
      set("detailHours", `${hours(actual)} / ${hours(target)}`);
      set("detailHoursNote", target > 0 ? `${Math.round(actual / target * 100)} % verbraucht` : "keine Sollstunden hinterlegt");
      set("detailOpen", hours(open));
      const progress = target > 0 ? Math.min(100, actual / target * 100) : 0;
      const bar = document.getElementById("detailProgress"); if (bar) bar.style.width = progress + "%";
      const note = document.getElementById("detailProgressNote"); if (note) note.textContent = target > 0 ? `${hours(actual)} von ${hours(target)} · ${Math.round(progress)} %` : "Noch keine Stundenkalkulation hinterlegt.";
      document.querySelectorAll('.job-row[data-job]').forEach(row => {
        if (String(row.dataset.job) !== String(currentJobId)) return;
        const cells = [...row.children];
        if (cells[3]) cells[3].textContent = `${hours(actual)} / ${hours(target)}`;
        if (cells[5]) cells[5].textContent = money(j.contractAmount ?? c.contractAmount);
      });
    } catch {}
  }
  async function persistAfterBaseSave(snapshot) {
    if (saveBusy || !currentJobId) return;
    saveBusy = true;
    try {
      const before = await api(`/admin/api/job/${encodeURIComponent(currentJobId)}/order-calculation`).catch(() => ({}));
      const beforeAt = before.calculation?.updatedAt || "";
      let latest = before;
      for (let attempt = 0; attempt < 16; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 300));
        latest = await api(`/admin/api/job/${encodeURIComponent(currentJobId)}/order-calculation`).catch(() => latest);
        if (!beforeAt || latest.calculation?.updatedAt !== beforeAt) break;
      }
      calcRows = Array.isArray(latest.calculation?.positions) ? latest.calculation.positions : calcRows;
      const rows = snapshot.map((meta, index) => ({ ...meta, positionId: calcRows[index]?.id || meta.positionId || "" }));
      const result = await api(`/admin/api/job/${encodeURIComponent(currentJobId)}/order-lines-v2`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      metaRows = Array.isArray(result.meta?.rows) ? result.meta.rows : rows;
      const msg = document.getElementById("kcv2SaveMsg");
      if (msg) msg.textContent = "✓ Gespeichert · Mengen, Preise, Auswahl, Baustelle & Tower aktualisiert";
      await refreshOuterNumbers();
      window.BaustellenKnowledgeHub?.load?.(currentJobId);
      setTimeout(() => { window.KristaOrderCalculation?.load?.(currentJobId); window.KristaOrderCalculation?.tab?.(); }, 250);
    } catch (error) {
      const msg = document.getElementById("kcv2SaveMsg");
      if (msg) { msg.textContent = "Zusatzdaten konnten nicht gespeichert werden: " + error.message; msg.style.color = "#a84540"; }
    } finally {
      saveBusy = false;
    }
  }
  function enhance() {
    enhanceQueued = false;
    const id = jobId();
    if (!id || id !== currentJobId) return;
    const table = document.querySelector("#kcv2Rows .kcv2-table");
    if (!table) { addMaterialButton(); return; }
    table.classList.add("kgridv2-table");
    transformHeader(table);
    [...table.querySelectorAll("tbody tr[data-index]")].forEach((tr, index) => bindEnhancedRow(tr, index));
    addMaterialButton();
    applyNextMaterial();
    refreshSummary();
  }
  function queueEnhance() {
    if (enhanceQueued) return;
    enhanceQueued = true;
    setTimeout(enhance, 30);
  }
  async function load(force = false) {
    const id = jobId();
    if (!id) return;
    if (!force && loaded && id === currentJobId) { queueEnhance(); return; }
    currentJobId = id;
    loaded = true;
    try {
      const [calc, meta] = await Promise.all([
        api(`/admin/api/job/${encodeURIComponent(id)}/order-calculation`).catch(() => ({})),
        api(`/admin/api/job/${encodeURIComponent(id)}/order-lines-v2`).catch(() => ({ rows: [] })),
      ]);
      calcRows = Array.isArray(calc.calculation?.positions) ? calc.calculation.positions : [];
      metaRows = Array.isArray(meta.rows) ? meta.rows : [];
    } catch {
      calcRows = [];
      metaRows = [];
    }
    queueEnhance();
  }
  function install() {
    installCss();
    document.addEventListener("click", event => {
      if (event.target?.id === "kcv2Save") {
        const snapshot = collectMeta();
        setTimeout(() => persistAfterBaseSave(snapshot), 0);
      }
    }, true);
    window.addEventListener("hashchange", () => { loaded = false; setTimeout(() => load(true), 200); });
    observer = new MutationObserver(() => queueEnhance());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const wait = () => {
      const id = jobId();
      if (!id || !document.getElementById("kcv2Rows")) return setTimeout(wait, 180);
      load(true);
    };
    wait();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
  window.KristaCalculationGridV2 = { version: VERSION, reload: () => load(true) };
})();
