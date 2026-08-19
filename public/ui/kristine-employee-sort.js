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

    // Rückfall für den bestehenden Mitarbeiterstamm, solange die Gruppe noch
    // nicht bei allen Stammdaten explizit gesetzt ist.
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

  function planningEmployees() {
    return (masterEmployees || [])
      .filter(isVisibleEmployee)
      .slice()
      .sort((a, b) => Number(isOfficeEmployee(a)) - Number(isOfficeEmployee(b)) || alpha(a, b));
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
