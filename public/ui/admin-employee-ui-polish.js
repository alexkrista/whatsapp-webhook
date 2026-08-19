"use strict";

(function () {
  function normalize(text) {
    return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function removeKristaModel() {
    const form = document.querySelector("#employeeModal .employee-form");
    if (!form) return;

    form.querySelectorAll("label").forEach((label) => {
      const text = normalize(label.textContent);
      if (text !== "krista modell") return;
      const row = label.closest("div");
      if (row && row !== form) row.remove();
      else label.remove();
    });
  }

  function polishCheckboxes() {
    const form = document.querySelector("#employeeModal .employee-form");
    if (!form) return;

    form.querySelectorAll('label:has(input[type="checkbox"])').forEach((label) => {
      label.classList.add("krista-admin-checkline");
    });

    const flags = form.querySelector(".employee-flags");
    if (flags) flags.classList.add("krista-admin-flags");
  }

  function installStyle() {
    if (document.getElementById("kristaAdminEmployeePolishStyle")) return;
    const style = document.createElement("style");
    style.id = "kristaAdminEmployeePolishStyle";
    style.textContent = `
      #employeeModal .krista-admin-flags{
        display:grid!important;
        grid-template-columns:repeat(auto-fit,minmax(220px,1fr));
        gap:10px 18px!important;
        align-items:center!important;
        padding:14px 16px!important;
      }
      #employeeModal .krista-admin-checkline{
        display:grid!important;
        grid-template-columns:20px minmax(0,1fr)!important;
        align-items:center!important;
        justify-content:start!important;
        gap:8px!important;
        margin:0!important;
        min-width:0!important;
        line-height:1.3!important;
        white-space:normal!important;
      }
      #employeeModal .krista-admin-checkline input[type="checkbox"]{
        width:18px!important;
        height:18px!important;
        min-width:18px!important;
        margin:0!important;
        padding:0!important;
        flex:none!important;
      }
      #employeeModal .krista-admin-checkline>*:not(input){min-width:0}
      @media(max-width:760px){
        #employeeModal .krista-admin-flags{grid-template-columns:1fr}
      }
    `;
    document.head.appendChild(style);
  }

  function install() {
    removeKristaModel();
    polishCheckboxes();
    installStyle();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }

  const observer = new MutationObserver(() => install());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
