"use strict";

(function () {
  function withToken(path) {
    const url = new URL(path, window.location.origin);
    const token = new URLSearchParams(window.location.search).get("token");
    if (token) url.searchParams.set("token", token);
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function tidyKriszeitToolbar() {
    if (!window.location.pathname.toLowerCase().includes("kristool-preview")) return;

    // KRISZEIT ist bereits die Kontrolle. Eine zweite Unter-Navigation ist doppelt.
    document.querySelectorAll(".krista-shell-subnav").forEach((el) => el.remove());

    const bar = document.querySelector(".date-workbench");
    const actions = bar?.querySelector(".export-actions");
    if (!bar || !actions) return;

    actions.classList.add("krista-kriszeit-actions");

    let left = actions.querySelector(".krista-kriszeit-actions-left");
    let right = actions.querySelector(".krista-kriszeit-actions-right");

    if (!left) {
      left = document.createElement("div");
      left.className = "krista-kriszeit-actions-left";
      actions.appendChild(left);
    }
    if (!right) {
      right = document.createElement("div");
      right.className = "krista-kriszeit-actions-right";
      actions.appendChild(right);
    }

    const fink = document.getElementById("openFinkzeitExport");
    const diet = document.getElementById("openDietReport");
    const logic = document.getElementById("openEmployeeLogic");

    if (fink && fink.parentElement !== left) left.appendChild(fink);
    if (diet && diet.parentElement !== left) left.appendChild(diet);
    if (logic && logic.parentElement !== right) right.appendChild(logic);

    let models = document.getElementById("openTimeModels");
    if (!models) {
      models = document.createElement("button");
      models.id = "openTimeModels";
      models.type = "button";
      models.className = "btn secondary";
      models.textContent = "⏰ Zeitmodelle";
      models.addEventListener("click", () => {
        window.location.href = withToken("/kristine#schedules");
      });
      right.appendChild(models);
    }

    if (!document.getElementById("kristaKriszeitToolbarStyle")) {
      const style = document.createElement("style");
      style.id = "kristaKriszeitToolbarStyle";
      style.textContent = `
        .date-workbench .krista-kriszeit-actions{
          grid-column:1/-1;
          display:flex!important;
          justify-content:space-between;
          align-items:center;
          gap:12px;
          width:100%;
          padding-top:2px;
        }
        .krista-kriszeit-actions-left,
        .krista-kriszeit-actions-right{
          display:flex;
          align-items:center;
          gap:8px;
          flex-wrap:wrap;
        }
        .krista-kriszeit-actions-right{margin-left:auto;justify-content:flex-end}
        .krista-kriszeit-actions-right .btn.secondary{
          background:#fff!important;
          color:#202620!important;
          border:1px solid #d3d7d2!important;
        }
        @media(max-width:720px){
          .date-workbench .krista-kriszeit-actions{align-items:stretch;flex-direction:column}
          .krista-kriszeit-actions-right{margin-left:0;justify-content:flex-start}
        }
      `;
      document.head.appendChild(style);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tidyKriszeitToolbar);
  } else {
    tidyKriszeitToolbar();
  }
})();
