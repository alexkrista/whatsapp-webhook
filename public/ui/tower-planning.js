"use strict";

(function () {
  const MONTHS = ["Jänner", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
  const token = new URLSearchParams(location.search).get("token") || "";
  let data = null;

  function tokenUrl(path) {
    const url = new URL(path, location.origin);
    if (token) url.searchParams.set("token", token);
    return url.pathname + url.search;
  }

  async function api(path, options) {
    const response = await fetch(tokenUrl(path), options);
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch {}
    if (!response.ok || !result?.ok) throw new Error(result?.error || text || response.statusText);
    return result;
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  function num(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function money(value) {
    return new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(num(value));
  }

  function hours(value) {
    return new Intl.NumberFormat("de-AT", { minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(num(value)) + " h";
  }

  function percent(value) {
    return new Intl.NumberFormat("de-AT", { maximumFractionDigits: 1 }).format(num(value)) + " %";
  }

  function calculate(plan, revenueCarryIn = null) {
    const base = num(plan.annualHoursPerFte) / 12;
    const factors = MONTHS.map((_, month) => (plan.employees || []).reduce((sum, row) => sum + num(row.monthlyPercent?.[month]) / 100, 0));
    const gross = factors.map(value => value * base);
    const planHours = gross.map((value, month) => value * num(plan.productivityPercent?.[month]) / 100);
    const workLabor = planHours.map(value => value * num(plan.billingRate));
    const workMaterial = workLabor.map(value => value * num(plan.materialPercent) / 100);
    const workRevenue = workLabor.map((value, month) => value + workMaterial[month]);
    const carryLabor = revenueCarryIn ? num(revenueCarryIn.labor) : workLabor[11];
    const carryMaterial = revenueCarryIn ? num(revenueCarryIn.material) : workMaterial[11];
    const labor = [carryLabor, ...workLabor.slice(0, 11)];
    const material = [carryMaterial, ...workMaterial.slice(0, 11)];
    const revenue = labor.map((value, month) => value + material[month]);
    const sum = values => values.reduce((total, value) => total + value, 0);
    const productiveFte = Math.max(0, num(plan.annualHoursPerFte) - (num(plan.holidayDays) + num(plan.vacationDays) + num(plan.sickDays) + num(plan.otherDays)) * num(plan.hoursPerDay));
    return {
      factors, gross, planHours, labor, material, revenue, workLabor, workMaterial, workRevenue,
      annualGrossHours: sum(gross), annualPlanHours: sum(planHours), annualLaborRevenue: sum(labor), annualMaterialRevenue: sum(material), annualPlanRevenue: sum(revenue),
      productiveHoursPerFte: productiveFte,
      targetProductivityPercent: num(plan.annualHoursPerFte) ? productiveFte / num(plan.annualHoursPerFte) * 100 : 0,
      monthlyProductivityAverage: (plan.productivityPercent || []).reduce((sumValue, value) => sumValue + num(value), 0) / 12,
    };
  }

  function injectStyle() {
    if (document.getElementById("towerPlanningStyle")) return;
    const style = document.createElement("style");
    style.id = "towerPlanningStyle";
    style.textContent = `
.tp-open{font:inherit;border:1px solid #cbc7bd;border-radius:10px;background:#fffefa;color:#303530;padding:8px 12px;font-weight:850;cursor:pointer}.tp-open:hover{border-color:#8aae94;background:#f8fff9}
.tp-dialog{width:min(1500px,calc(100vw - 28px));max-width:none;height:min(880px,calc(100vh - 28px));max-height:none;padding:0;border:0;border-radius:18px;background:#f5f4ef;color:#202520;box-shadow:0 24px 90px rgba(0,0,0,.35)}.tp-dialog::backdrop{background:rgba(16,21,18,.62);backdrop-filter:blur(3px)}
.tp-shell{height:100%;display:flex;flex-direction:column}.tp-head{padding:17px 19px;background:#fffefa;border-bottom:1px solid #dedad1;display:flex;justify-content:space-between;gap:14px;align-items:flex-start}.tp-head h2{margin:0;font-size:22px}.tp-head p{margin:3px 0 0;color:#707670;font-size:12px}.tp-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.tp-actions select,.tp-actions button{font:inherit;border:1px solid #cbc7bd;border-radius:9px;background:white;padding:8px 11px;font-weight:800}.tp-actions button{cursor:pointer}.tp-actions .tp-save{background:#2f7d4a;border-color:#2f7d4a;color:white}.tp-body{padding:14px 18px 20px;overflow:auto;flex:1}.tp-settings{display:grid;grid-template-columns:repeat(8,minmax(110px,1fr));gap:8px;margin-bottom:12px}.tp-field{background:#fffefa;border:1px solid #dedad1;border-radius:11px;padding:9px}.tp-field span{display:block;font-size:10px;color:#707670;font-weight:800;margin-bottom:5px}.tp-field input{width:100%;font:inherit;font-size:14px;font-weight:850;border:0;border-bottom:1px solid #d8d4ca;background:transparent;padding:3px 0;outline:none}.tp-field input:focus{border-color:#2f7d4a}.tp-table-wrap{overflow:auto;background:#fffefa;border:1px solid #dcd8cf;border-radius:13px;max-height:570px}.tp-table{border-collapse:separate;border-spacing:0;min-width:1510px;width:100%;font-size:11px}.tp-table th,.tp-table td{border-right:1px solid #ece9e1;border-bottom:1px solid #ece9e1;padding:7px 8px;text-align:right;white-space:nowrap}.tp-table thead th{position:sticky;top:0;background:#eeece5;z-index:4;text-align:center}.tp-table th:first-child,.tp-table td:first-child{position:sticky;left:0;z-index:3;background:#fffefa;text-align:left;min-width:160px;max-width:160px}.tp-table thead th:first-child{z-index:6;background:#eeece5}.tp-table .tp-result td{background:#faf9f4;font-weight:750}.tp-table .tp-result td:first-child{background:#faf9f4}.tp-table .tp-main td{font-size:12px;font-weight:950;color:#244c31}.tp-table .tp-main td:first-child{color:#202520}.tp-table .tp-divider td{border-top:2px solid #c7c2b7}.tp-table input{width:58px;text-align:right;border:1px solid #d7d3ca;border-radius:7px;padding:5px;font:inherit;font-weight:800;background:white}.tp-table .tp-year{font-weight:950;background:#f3f1ea}.tp-table td:last-child,.tp-table th:last-child{position:sticky;right:0;z-index:2;background:#f3f1ea;border-left:2px solid #d4d0c7}.tp-table thead th:last-child{z-index:5}.tp-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:10px}.tp-summary div{background:#fffefa;border:1px solid #dedad1;border-radius:11px;padding:10px}.tp-summary span{display:block;font-size:10px;color:#707670}.tp-summary strong{display:block;font-size:16px;margin-top:3px}.tp-summary .warn strong{color:#a84540}.tp-note{font-size:11px;color:#707670;margin-top:10px}.tp-status{font-size:11px;color:#2f7d4a;font-weight:800;min-width:80px}.tp-error{padding:30px;color:#a84540}
@media(max-width:1000px){.tp-settings{grid-template-columns:repeat(4,1fr)}.tp-summary{grid-template-columns:1fr 1fr}}@media(max-width:650px){.tp-dialog{width:100vw;height:100vh;border-radius:0}.tp-head{padding:12px}.tp-body{padding:10px}.tp-settings{grid-template-columns:1fr 1fr}.tp-summary{grid-template-columns:1fr}.tp-actions{width:100%}}
`;
    document.head.appendChild(style);
  }

  function outputRow(label, values, annual, format, className = "") {
    return `<tr class="tp-result ${className}"><td>${esc(label)}</td>${values.map(value => `<td>${esc(format(value))}</td>`).join("")}<td class="tp-year">${esc(format(annual))}</td></tr>`;
  }

  function renderTable() {
    if (!data?.plan) return;
    const plan = data.plan;
    const savedCalculation = data.calculation || {};
    const carry = savedCalculation.revenueCarrySource === "previous-year-plan"
      ? {
          labor: num(savedCalculation.monthlyLaborRevenue?.[0]),
          material: num(savedCalculation.monthlyMaterialRevenue?.[0]),
        }
      : null;
    const calc = calculate(plan, carry);
    const table = document.getElementById("tpTable");
    table.innerHTML = `
      <thead><tr><th>Plan ${plan.year}</th>${MONTHS.map(month => `<th>${month}</th>`).join("")}<th>Jahr</th></tr></thead>
      <tbody>
        ${outputRow("Umsatz Plan · Verrechnung +1 Monat", calc.revenue, calc.annualPlanRevenue, money, "tp-main")}
        ${outputRow("davon Material", calc.material, calc.annualMaterialRevenue, money)}
        ${outputRow("davon Lohn/Leistung", calc.labor, calc.annualLaborRevenue, money)}
        ${outputRow("Stunden Plan", calc.planHours, calc.annualPlanHours, hours, "tp-main")}
        ${outputRow("Bruttokapazität", calc.gross, calc.annualGrossHours, hours)}
        <tr class="tp-divider"><td>Produktivanteil</td>${plan.productivityPercent.map((value, month) => `<td><input class="tp-productivity" data-month="${month}" type="number" min="0" max="150" step="1" value="${num(value)}"> %</td>`).join("")}<td class="tp-year">Ø ${percent(calc.monthlyProductivityAverage)}</td></tr>
        <tr><td>Personal-Faktor</td>${calc.factors.map(value => `<td>${value.toLocaleString("de-AT", { maximumFractionDigits: 2 })}</td>`).join("")}<td class="tp-year">–</td></tr>
        ${(plan.employees || []).map((employee, employeeIndex) => `<tr><td><strong>${esc(employee.employeeName)}</strong></td>${employee.monthlyPercent.map((value, month) => `<td><input class="tp-employee" data-employee="${employeeIndex}" data-month="${month}" type="number" min="0" max="200" step="5" value="${num(value)}"> %</td>`).join("")}<td class="tp-year">Ø ${percent(employee.monthlyPercent.reduce((sumValue, value) => sumValue + num(value), 0) / 12)}</td></tr>`).join("")}
      </tbody>`;
    document.getElementById("tpSummary").innerHTML = `
      <div><span>Produktivstunden je Vollzeitkraft</span><strong>${hours(calc.productiveHoursPerFte)}</strong></div>
      <div class="${Math.abs(calc.targetProductivityPercent - calc.monthlyProductivityAverage) > .6 ? "warn" : ""}"><span>Ziel / Monatsmittel Produktivität</span><strong>${percent(calc.targetProductivityPercent)} / ${percent(calc.monthlyProductivityAverage)}</strong></div>
      <div><span>Stunden Plan Jahr</span><strong>${hours(calc.annualPlanHours)}</strong></div>
      <div><span>Umsatz Plan Jahr</span><strong>${money(calc.annualPlanRevenue)}</strong></div>`;
  }

  function settingsHtml(plan) {
    const fields = [
      ["annualHoursPerFte", "Jahresstunden Vollzeit", 1, 4000, 1],
      ["hoursPerDay", "Stunden pro Tag", .1, 24, .1],
      ["billingRate", "Stundensatz €", 0, 1000, 1],
      ["materialPercent", "Materialaufschlag %", 0, 500, 1],
      ["holidayDays", "Feiertage Tage", 0, 366, .1],
      ["vacationDays", "Urlaub Tage", 0, 366, .1],
      ["sickDays", "Krank Plan Tage", 0, 366, .1],
      ["otherDays", "Sonstiges Tage", 0, 366, .1],
    ];
    return fields.map(([key, label, min, max, step]) => `<label class="tp-field"><span>${label}</span><input class="tp-setting" data-key="${key}" type="number" min="${min}" max="${max}" step="${step}" value="${num(plan[key])}"></label>`).join("");
  }

  function render() {
    const plan = data.plan;
    document.getElementById("tpSettings").innerHTML = settingsHtml(plan);
    document.getElementById("tpYear").value = String(plan.year);
    renderTable();
    document.getElementById("tpStatus").textContent = plan.updatedAt ? "Gespeichert" : "Noch nicht gespeichert";
  }

  async function load(year) {
    const host = document.getElementById("tpBody");
    host.setAttribute("aria-busy", "true");
    try {
      data = await api(`/kristine/api/tower-plan?year=${encodeURIComponent(year)}`);
      render();
      window.kristaTowerPlanData = data;
      window.dispatchEvent(new CustomEvent("krista:tower-plan-updated", { detail: data }));
    } catch (error) {
      document.getElementById("tpStatus").textContent = error.message || String(error);
    } finally {
      host.removeAttribute("aria-busy");
    }
  }

  async function save() {
    const button = document.getElementById("tpSave");
    button.disabled = true;
    document.getElementById("tpStatus").textContent = "Wird gespeichert …";
    try {
      data = await api("/kristine/api/tower-plan", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan: data.plan }) });
      render();
      window.kristaTowerPlanData = data;
      window.dispatchEvent(new CustomEvent("krista:tower-plan-updated", { detail: data }));
      document.getElementById("tpStatus").textContent = "✓ Gespeichert";
    } catch (error) {
      document.getElementById("tpStatus").textContent = error.message || String(error);
    } finally {
      button.disabled = false;
    }
  }

  function build() {
    injectStyle();
    const headRight = document.querySelector(".head-right");
    if (!headRight || document.getElementById("towerPlanningOpen")) return;
    const open = document.createElement("button");
    open.id = "towerPlanningOpen";
    open.className = "tp-open";
    open.type = "button";
    open.textContent = "Planung bearbeiten";
    headRight.insertBefore(open, headRight.firstChild);

    const currentYear = new Date().getFullYear();
    const dialog = document.createElement("dialog");
    dialog.id = "towerPlanningDialog";
    dialog.className = "tp-dialog";
    dialog.innerHTML = `<div class="tp-shell">
      <div class="tp-head"><div><h2>Umsatz- und Stundenplanung</h2><p>Hintergrundplanung für die beiden Plan/Ist-Vergleiche im Tower.</p></div><div class="tp-actions"><span id="tpStatus" class="tp-status"></span><select id="tpYear" aria-label="Planungsjahr">${Array.from({ length: 5 }, (_, index) => currentYear - 1 + index).map(year => `<option value="${year}">${year}</option>`).join("")}</select><button id="tpSave" class="tp-save" type="button">Speichern</button><button id="tpClose" type="button">Schließen</button></div></div>
      <div id="tpBody" class="tp-body"><div id="tpSettings" class="tp-settings"></div><div class="tp-table-wrap"><table id="tpTable" class="tp-table"></table></div><div id="tpSummary" class="tp-summary"></div><div class="tp-note">Der Umsatzplan folgt der Arbeitsleistung mit einem Monat Versatz: Jänner-Arbeit wird im Februar als Umsatz geplant. Der Jänner übernimmt den Dezember des Vorjahres; fehlt dieser Plan, wird der aktuelle Dezember als Schätzung verwendet. Stunden-Ist kommt automatisch aus KRISZEIT, Umsatz-Ist aus den Ausgangsrechnungen.</div></div>
    </div>`;
    document.body.appendChild(dialog);

    open.addEventListener("click", () => { dialog.showModal(); if (!data) load(currentYear); });
    document.getElementById("tpClose").addEventListener("click", () => dialog.close());
    document.getElementById("tpSave").addEventListener("click", save);
    document.getElementById("tpYear").addEventListener("change", event => load(Number(event.target.value)));
    dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener("change", event => {
      if (!data?.plan) return;
      let changed = false;
      if (event.target.classList.contains("tp-setting")) { data.plan[event.target.dataset.key] = num(event.target.value); changed = true; }
      if (event.target.classList.contains("tp-productivity")) { data.plan.productivityPercent[Number(event.target.dataset.month)] = num(event.target.value); changed = true; }
      if (event.target.classList.contains("tp-employee")) {
        const employee = data.plan.employees[Number(event.target.dataset.employee)];
        const startMonth = Number(event.target.dataset.month);
        const value = num(event.target.value);
        for (let month = startMonth; month < 12; month += 1) employee.monthlyPercent[month] = value;
        changed = true;
      }
      if (!changed) return;
      renderTable();
      document.getElementById("tpStatus").textContent = "Ungespeichert";
    });

    load(currentYear);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build, { once: true });
  else build();
})();
