"use strict";

(function () {
  function movePlanningCardsBesideCalendar() {
    const panel = document.getElementById("planningCardsPanel");
    const calendar = document.querySelector(".planning-calendar-card");
    if (!panel || !calendar) return;

    let workspace = document.getElementById("kristaPlanningWorkspace");
    if (!workspace) {
      workspace = document.createElement("div");
      workspace.id = "kristaPlanningWorkspace";
      workspace.className = "krista-planning-workspace";

      const planningTab = document.getElementById("planning") || calendar.closest(".tab") || panel.closest(".tab");
      const anchor = calendar.parentElement === planningTab ? calendar : (panel.parentElement === planningTab ? panel : null);

      if (planningTab && anchor) planningTab.insertBefore(workspace, anchor);
      else if (calendar.parentElement) calendar.parentElement.insertBefore(workspace, calendar);
      else return;
    }

    if (panel.parentElement !== workspace) workspace.appendChild(panel);
    if (calendar.parentElement !== workspace) workspace.appendChild(calendar);
    panel.open = true;

    if (!document.getElementById("kristaPlanningSidebarHotfixStyle")) {
      const style = document.createElement("style");
      style.id = "kristaPlanningSidebarHotfixStyle";
      style.textContent = `
        .krista-planning-workspace{
          display:grid;
          grid-template-columns:285px minmax(0,1fr);
          gap:14px;
          align-items:start;
          margin-top:14px;
        }
        .krista-planning-workspace #planningCardsPanel{
          position:sticky;
          top:14px;
          margin:0;
          max-height:calc(100vh - 28px);
          overflow:auto;
        }
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

  function install() {
    movePlanningCardsBesideCalendar();
    setTimeout(movePlanningCardsBesideCalendar, 0);
    setTimeout(movePlanningCardsBesideCalendar, 250);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
