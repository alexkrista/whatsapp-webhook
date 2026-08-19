"use strict";

(function () {
  function completedStamp(task) {
    return String(task?.completedAt || task?.doneAt || task?.updatedAt || task?.createdAt || task?.id || "");
  }

  function createdStamp(task) {
    return String(task?.createdAt || task?.id || "");
  }

  function dueStamp(task) {
    return String(task?.dueDate || "9999-12-31");
  }

  function installStyle() {
    if (document.getElementById("kristaCompactTaskStyle")) return;
    const style = document.createElement("style");
    style.id = "kristaCompactTaskStyle";
    style.textContent = `
      #taskList{display:grid;gap:6px}
      #taskList .krista-task-row{
        display:grid;
        grid-template-columns:minmax(220px,2fr) minmax(130px,.9fr) minmax(150px,1fr) minmax(145px,.9fr) auto;
        gap:10px;
        align-items:center;
        background:#fff;
        border:1px solid #e7e3dc;
        border-left:4px solid #27713d;
        border-radius:10px;
        padding:8px 10px;
        min-height:44px;
      }
      #taskList .krista-task-row.done{border-left-color:#8aa48f;background:#fbfcfa}
      #taskList .krista-task-title{font-weight:850;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #taskList .krista-task-sub{font-size:11px;color:#707070;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #taskList .krista-task-cell{min-width:0}
      #taskList .krista-task-actions{display:flex;gap:5px;justify-content:flex-end;align-items:center}
      #taskList .krista-task-actions button{padding:6px 8px;border-radius:7px;font-size:11px;white-space:nowrap}
      #taskList .krista-task-badge{display:inline-flex;align-items:center;border-radius:999px;padding:3px 6px;background:#f0f0ed;font-size:10px;font-weight:800;margin-right:4px}
      @media(max-width:900px){
        #taskList .krista-task-row{grid-template-columns:minmax(180px,1fr) auto}
        #taskList .krista-task-row>.krista-task-cell:nth-child(2),
        #taskList .krista-task-row>.krista-task-cell:nth-child(3),
        #taskList .krista-task-row>.krista-task-cell:nth-child(4){display:none}
      }
    `;
    document.head.appendChild(style);
  }

  function compactRenderTasks() {
    let tasks = [...(data?.tasks || [])];

    if (taskFilter === "newest" || taskFilter === "open") {
      tasks = tasks.filter((task) => task.status !== "done");
    } else if (taskFilter === "done") {
      tasks = tasks.filter((task) => task.status === "done");
    }

    if (taskFilter === "done") {
      tasks.sort((a, b) => completedStamp(b).localeCompare(completedStamp(a)));
    } else if (taskFilter === "newest") {
      tasks.sort((a, b) => createdStamp(b).localeCompare(createdStamp(a)));
    } else {
      tasks.sort((a, b) => dueStamp(a).localeCompare(dueStamp(b)) || createdStamp(b).localeCompare(createdStamp(a)));
    }

    const list = document.getElementById("taskList");
    if (!list) return;

    list.innerHTML = tasks.length ? tasks.map((task) => {
      const job = (masterJobs || []).find((row) => String(row.jobId) === String(task.jobId));
      const priority = task.priority === "sofort" ? "🔴 Sofort" : task.priority === "heute" ? "🟡 Heute" : "🟢 Normal";
      const statusTime = task.status === "done"
        ? (task.completedAt ? new Date(task.completedAt).toLocaleString("de-AT", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" }) : "erledigt")
        : (typeof taskDueLabel === "function" ? taskDueLabel(task.dueDate) : (task.dueDate || "–"));
      const site = task.jobName || job?.name || "";
      return `<div class="krista-task-row ${task.status === "done" ? "done" : ""}">
        <div class="krista-task-cell"><div class="krista-task-title">${esc(task.title || "Aufgabe")}</div><div class="krista-task-sub"><span class="krista-task-badge">${esc(task.taskType || "Aufgabe")}</span><span class="krista-task-badge">${priority}</span>${task.reminder ? ` ${esc(task.reminder)}` : ""}</div></div>
        <div class="krista-task-cell"><strong>${esc(task.assigneeName || task.assigneeId || "–")}</strong><div class="krista-task-sub">für</div></div>
        <div class="krista-task-cell"><strong>${esc(site || "–")}</strong><div class="krista-task-sub">Baustelle</div></div>
        <div class="krista-task-cell"><strong>${esc(statusTime)}</strong><div class="krista-task-sub">${task.status === "done" ? "erledigt" : "fällig"}</div></div>
        <div class="krista-task-actions"><button class="secondary" onclick="openTaskListModal('${task.id}')">Details</button>${task.status !== "done" ? `<button class="green" onclick="markTaskDone('${task.id}')">✓</button>` : ""}<button class="danger" onclick="removeTask('${task.id}')">×</button></div>
      </div>`;
    }).join("") : '<span class="small">Keine Aufgaben.</span>';
  }

  function install() {
    installStyle();
    if (typeof window.renderTasks !== "function" || window.renderTasks.__kristaCompact) return;
    compactRenderTasks.__kristaCompact = true;
    window.renderTasks = compactRenderTasks;
    compactRenderTasks();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once:true });
  else install();
})();
