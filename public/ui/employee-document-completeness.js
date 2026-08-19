"use strict";

(function () {
  function tokenized(url) {
    const u = new URL(url, window.location.origin);
    const token = new URLSearchParams(window.location.search).get("token");
    if (token) u.searchParams.set("token", token);
    return `${u.pathname}${u.search}`;
  }

  function hasLicenseDocument(employee) {
    return Boolean(
      employee?.drivingLicenseFrontDocument?.data ||
      employee?.drivingLicenseBackDocument?.data ||
      employee?.drivingLicenseFrontImage ||
      employee?.drivingLicenseBackImage ||
      employee?.drivingLicenseImage
    );
  }

  function hasPassportDocument(employee) {
    return Boolean(
      employee?.passportPage1Document?.data ||
      employee?.passportPage2Document?.data ||
      employee?.passportPage1Image ||
      employee?.passportPage2Image ||
      employee?.passportImage
    );
  }

  async function updateEmployeeDocumentStatus() {
    const table = document.querySelector("#employeeList .employee-table");
    if (!table) return;

    let employees = [];
    try {
      const response = await fetch(tokenized("/admin/api/employees"));
      if (!response.ok) return;
      const data = await response.json();
      employees = Array.isArray(data?.employees) ? data.employees : [];
    } catch {
      return;
    }

    const byId = new Map(employees.map((employee) => [String(employee.id), employee]));

    table.querySelectorAll("tbody tr").forEach((row) => {
      const editButton = [...row.querySelectorAll("button")].find((button) =>
        String(button.getAttribute("onclick") || "").includes("editEmployeeMaster(")
      );
      const onclick = String(editButton?.getAttribute("onclick") || "");
      const match = onclick.match(/editEmployeeMaster\(['\"]([^'\"]+)['\"]\)/);
      const employee = match ? byId.get(String(match[1])) : null;
      if (!employee) return;

      const cell = row.children?.[4];
      if (!cell) return;

      let html = cell.innerHTML;
      html = html.replace(
        /(?:✅ Führerschein komplett|🟠 Führerschein unvollständig)/g,
        hasLicenseDocument(employee) ? "✅ Führerschein komplett" : "🟠 Führerschein unvollständig"
      );
      html = html.replace(
        /(?:✅ Pass komplett|🟠 Pass unvollständig)/g,
        hasPassportDocument(employee) ? "✅ Pass komplett" : "🟠 Pass unvollständig"
      );
      cell.innerHTML = html;
    });
  }

  function loadEmployeePolishAssets() {
    if (!document.querySelector('link[data-krista-personnel-layout]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/public/ui/admin-employee-personnel-layout.css";
      link.dataset.kristaPersonnelLayout = "1";
      document.head.appendChild(link);
    }
    if (!document.querySelector('script[data-krista-admin-employee-polish]')) {
      const script = document.createElement("script");
      script.src = "/public/ui/admin-employee-ui-polish.js";
      script.dataset.kristaAdminEmployeePolish = "1";
      script.defer = true;
      document.head.appendChild(script);
    }
  }

  let timer = null;
  function scheduleUpdate() {
    clearTimeout(timer);
    timer = setTimeout(updateEmployeeDocumentStatus, 80);
  }

  document.addEventListener("DOMContentLoaded", function () {
    loadEmployeePolishAssets();
    const list = document.getElementById("employeeList");
    if (!list) return;

    new MutationObserver(scheduleUpdate).observe(list, { childList: true, subtree: true });
    scheduleUpdate();
  });
})();