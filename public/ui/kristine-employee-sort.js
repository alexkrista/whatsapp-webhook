"use strict";

(function () {
  function norm(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function isVisibleEmployee(employee) {
    if (!employee) return false;
    if (employee.active === false || employee.isActive === false) return false;
    if (employee.hidden === true || employee.isHidden === true) return false;
    if (employee.disabled === true || employee.isDisabled === true) return false;
    if (employee.archived === true || employee.isArchived === true) return false;
    if (employee.visible === false) return false;
    if (employee.showInPlanning === false || employee.showInControl === false) return false;
    return true;
  }

  function isOfficeEmployee(employee) {
    if (!employee) return false;
    if (
      employee.office === true ||
      employee.isOffice === true ||
      employee.officeEmployee === true ||
      employee.isOfficeEmployee === true
    ) return true;

    const fields = [
      employee.department,
      employee.area,
      employee.group,
      employee.employeeGroup,
      employee.role,
      employee.employeeType,
      employee.category,
      employee.team,
      employee.workArea,
      employee.employmentType,
    ].map(norm).filter(Boolean).join(" ");

    if (/\b(buro|office|verwaltung|administration|backoffice)\b/.test(fields)) return true;

    const name = norm(employee.name || employee.employeeName || employee.nickname || employee.rufname);
    return [
      "alexander krista",
      "alex krista",
      "bettina eberle nigsch",
      "dunja turtscher",
      "judith krista",
    ].includes(name);
  }

  function alpha(a, b) {
    return String(a?.name || a?.employeeName || "")
      .localeCompare(String(b?.name || b?.employeeName || ""), "de", { sensitivity: "base" });
  }

  function currentPlanningDays() {
    try {
      if (typeof planningView !== "undefined" && planningView === "day" && typeof selectedPlanningDate === "function") {
        return [selectedPlanningDate()];
      }
      if (typeof planningView !== "undefined" && planningView === "month") return [];
      if (typeof weekDays === "function") return weekDays();
    } catch {}
    return [];
  }

  function employeeHasPlanning(employeeId, days) {
    if (!days.length) return false;
    return (data?.assignments || []).some((assignment) =>
      String(assignment?.employeeId || "") === String(employeeId || "") &&
      days.includes(String(assignment?.date || ""))
    );
  }

  function planningEmployees() {
    const days = currentPlanningDays();
    return (masterEmployees || [])
      .filter(isVisibleEmployee)
      .slice()
      .sort((a, b) => {
        const aOffice = isOfficeEmployee(a);
        const bOffice = isOfficeEmployee(b);
        if (aOffice !== bOffice) return Number(aOffice) - Number(bOffice);
        if (aOffice && bOffice) return alpha(a, b);

        // Produktive MA ohne Einteilung zuerst; innerhalb beider Gruppen A–Z.
        const aAssigned = employeeHasPlanning(a.id ?? a.employeeId, days);
        const bAssigned = employeeHasPlanning(b.id ?? b.employeeId, days);
        if (aAssigned !== bAssigned) return Number(aAssigned) - Number(bAssigned);
        return alpha(a, b);
      });
  }

  function employeeByAnyId(employeeId) {
    const wanted = String(employeeId || "");
    return (masterEmployees || []).find((employee) =>
      String(employee?.id ?? employee?.employeeId ?? "") === wanted
    ) || null;
  }

  function stateForEmployee(employeeId) {
    const state = data?.states?.[employeeId];
    return state || { mode: "idle", timeline: [] };
  }

  function hasStartedToday(employeeId, date) {
    const state = stateForEmployee(employeeId);
    if (state && state.mode && state.mode !== "idle") return true;
    return (data?.timeEvents || []).some((row) =>
      String(row?.employeeId || "") === String(employeeId || "") &&
      String(row?.date || "") === String(date || "") &&
      ["start", "weiter", "pause", "mittag", "ende", "fertig", "stop", "stopp"]
        .includes(String(row?.type || "").toLowerCase())
    );
  }

  function isUpAssignment(assignment) {
    const text = norm([
      assignment?.cardType,
      assignment?.assignmentType,
      assignment?.type,
      assignment?.category,
      assignment?.status,
      assignment?.reason,
      assignment?.jobId,
      assignment?.jobName,
      assignment?.name,
      assignment?.note,
    ].filter(Boolean).join(" "));

    return /\b(urlaub|krank|krankenstand|arzt|feiertag|za|zeitausgleich|aufraumen|werkstatt|schulung|material holen|lager|unproduktiv|up)\b/.test(text);
  }

  function hasUpForDay(employeeId, date) {
    return (data?.assignments || []).some((assignment) =>
      String(assignment?.employeeId || "") === String(employeeId || "") &&
      String(assignment?.date || "") === String(date || "") &&
      isUpAssignment(assignment)
    );
  }

  function controlBucket(employee, employeeId, date) {
    const office = isOfficeEmployee(employee);
    const started = hasStartedToday(employeeId, date);
    if (office) return started ? 3 : 4;
    if (started) return 0;
    if (hasUpForDay(employeeId, date)) return 2;
    return 1;
  }

  function reorderControlCards() {
    const grid = document.querySelector("#controlList .control-grid");
    if (!grid) return;
    const date = typeof selectedWorkDate === "function" ? selectedWorkDate() : data?.today;
    const cards = [...grid.querySelectorAll(":scope > .control-card")];

    const decorated = cards.map((card) => {
      const onclick = card.getAttribute("onclick") || "";
      const match = onclick.match(/openEmployeeActionModal\('([^']+)'\)/);
      const employeeId = match?.[1] || "";
      const employee = employeeByAnyId(employeeId);
      const visible = Boolean(employee && isVisibleEmployee(employee));
      return {
        card,
        employee,
        employeeId,
        visible,
        bucket: visible ? controlBucket(employee, employeeId, date) : 99,
      };
    });

    decorated.forEach((row) => {
      if (!row.visible) row.card.remove();
    });

    decorated
      .filter((row) => row.visible)
      .sort((a, b) => a.bucket - b.bucket || alpha(a.employee, b.employee))
      .forEach((row) => grid.appendChild(row.card));
  }

  function installPlanningSidebar() {
    const panel = document.getElementById("planningCardsPanel");
    const calendar = document.querySelector(".planning-calendar-card");
    if (!panel || !calendar || document.getElementById("kristaPlanningWorkspace")) return;
    const parent = panel.parentElement;
    if (!parent || calendar.parentElement !== parent) return;

    const workspace = document.createElement("div");
    workspace.id = "kristaPlanningWorkspace";
    workspace.className = "krista-planning-workspace";
    parent.insertBefore(workspace, panel);
    workspace.appendChild(panel);
    workspace.appendChild(calendar);
    panel.open = true;

    if (!document.getElementById("kristaPlanningSidebarStyle")) {
      const style = document.createElement("style");
      style.id = "kristaPlanningSidebarStyle";
      style.textContent = `
        .krista-planning-workspace{display:grid;grid-template-columns:285px minmax(0,1fr);gap:14px;align-items:start;margin-top:14px}
        .krista-planning-workspace #planningCardsPanel{position:sticky;top:14px;margin:0;max-height:calc(100vh - 28px);overflow:auto}
        .krista-planning-workspace #planningCardsPanel>summary .small{display:none}
        .krista-planning-workspace #planningCardsPanel .planning-panel-body{padding:0 10px 10px}
        .krista-planning-workspace #planningCardsPanel .planning-pools{display:grid;gap:9px;padding-top:10px}
        .krista-planning-workspace #planningCardsPanel .pool-column{padding:8px}
        .krista-planning-workspace #planningCardsPanel .pool-lane-wrap{display:block}
        .krista-planning-workspace #planningCardsPanel .pool-scroll-btn{display:none!important}
        .krista-planning-workspace #planningCardsPanel .pool-list{display:grid;gap:6px;overflow:visible;padding:0}
        .krista-planning-workspace #planningCardsPanel .pool-card{width:100%;min-width:0;max-width:none}
        .krista-planning-workspace .planning-calendar-card{margin:0;min-width:0}
        @media(max-width:1000px){
          .krista-planning-workspace{grid-template-columns:1fr}
          .krista-planning-workspace #planningCardsPanel{position:static;max-height:none}
          .krista-planning-workspace #planningCardsPanel .pool-list{display:flex;overflow-x:auto}
          .krista-planning-workspace #planningCardsPanel .pool-card{min-width:180px;width:auto}
        }
      `;
      document.head.appendChild(style);
    }
  }

  function installPlanningSort() {
    if (typeof window.renderEmployeePlanning !== "function" || window.renderEmployeePlanning.__kristaSorted) return;
    const original = window.renderEmployeePlanning;
    const wrapped = function (...args) {
      const originalEmployees = masterEmployees;
      try {
        masterEmployees = planningEmployees();
        return original.apply(this, args);
      } finally {
        masterEmployees = originalEmployees;
      }
    };
    wrapped.__kristaSorted = true;
    window.renderEmployeePlanning = wrapped;
  }

  function installControlSort() {
    if (typeof window.renderControl !== "function" || window.renderControl.__kristaSorted) return;
    const original = window.renderControl;
    const wrapped = function (...args) {
      const result = original.apply(this, args);
      reorderControlCards();
      return result;
    };
    wrapped.__kristaSorted = true;
    window.renderControl = wrapped;
  }

  function install() {
    installPlanningSidebar();
    installPlanningSort();
    installControlSort();
    if (typeof window.renderWeek === "function") window.renderWeek();
    if (typeof window.renderControl === "function") window.renderControl();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
