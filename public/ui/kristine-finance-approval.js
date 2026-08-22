"use strict";

(function () {
  const MARKER = "[FINANCE_APPROVAL]";

  function safe(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  function money(value, currency = "EUR") {
    try {
      return new Intl.NumberFormat("de-AT", { style: "currency", currency: currency || "EUR" }).format(Number(value || 0));
    } catch {
      return `${Number(value || 0).toFixed(2)} ${currency || "EUR"}`;
    }
  }

  function decode(value) {
    try { return decodeURIComponent(String(value || "")); } catch { return String(value || ""); }
  }

  function encode(value) {
    return encodeURIComponent(String(value ?? ""));
  }

  function parseFinanceMeta(task) {
    const reminder = String(task?.reminder || "");
    if (!reminder.includes(MARKER)) return null;
    const raw = reminder.split(MARKER, 2)[1] || "";
    const meta = {};
    raw.split(";").forEach((part) => {
      const index = part.indexOf("=");
      if (index < 0) return;
      meta[part.slice(0, index).trim()] = decode(part.slice(index + 1));
    });
    if (!meta.source || !meta.id) return null;
    ["amount", "deduction", "approved"].forEach((key) => {
      const number = Number(String(meta[key] || "0").replace(",", "."));
      meta[key] = Number.isFinite(number) ? number : 0;
    });
    meta.decision = String(meta.decision || "pending").toLowerCase();
    meta.mode = String(meta.mode || "").toLowerCase();
    return meta;
  }

  function buildFinanceReminder(meta) {
    const keys = ["source", "id", "doc", "invoice", "amount", "currency", "decision", "mode", "deduction", "approved", "reason"];
    const normalized = {
      ...meta,
      amount: Number(meta.amount || 0).toFixed(2),
      deduction: Number(meta.deduction || 0).toFixed(2),
      approved: Number(meta.approved || 0).toFixed(2),
    };
    return `${MARKER}${keys.map((key) => `${key}=${encode(normalized[key] ?? "")}`).join(";")}`.slice(0, 500);
  }

  function financeTask(task) {
    return String(task?.creatorId || "") === "brain-finance" || Boolean(parseFinanceMeta(task));
  }

  function getTasks() {
    try { return Array.isArray(data?.tasks) ? data.tasks : []; } catch { return []; }
  }

  function getTask(taskId) {
    return getTasks().find((task) => String(task.id || "") === String(taskId || "")) || null;
  }

  function decisionLabel(meta) {
    if (!meta) return "Freigabe offen";
    if (meta.decision === "approved") return "✓ Freigegeben";
    if (meta.decision === "reduced") return `✂ Gekürzt · ${money(meta.approved, meta.currency)}`;
    if (meta.decision === "blocked") return "⛔ Gesperrt";
    return "⏳ Freigabe offen";
  }

  function parseGermanNumber(raw) {
    let value = String(raw || "").trim().replace(/[^0-9,.-]/g, "");
    if (!value) return NaN;
    if (value.includes(",") && value.includes(".")) value = value.replace(/\./g, "").replace(",", ".");
    else value = value.replace(",", ".");
    const number = Number(value);
    return Number.isFinite(number) ? number : NaN;
  }

  async function persistFinanceDecision(task, meta, { done }) {
    task.reminder = buildFinanceReminder(meta);
    task.status = done ? "done" : "open";
    task.completedAt = done ? new Date().toISOString() : null;
    if (typeof persistTasks !== "function") throw new Error("Aufgaben-Speicherung ist noch nicht bereit.");
    await persistTasks();
    if (typeof renderTasks === "function") renderTasks();
    setTimeout(() => {
      decorateRows();
      const modal = document.getElementById("taskModalBackdrop");
      if (modal?.classList.contains("open") && typeof openTaskListModal === "function") openTaskListModal(task.id);
    }, 0);
  }

  async function approve(taskId) {
    const task = getTask(taskId); const meta = parseFinanceMeta(task);
    if (!task || !meta) return;
    meta.decision = "approved";
    meta.mode = "";
    meta.deduction = 0;
    meta.approved = Number(meta.amount || 0);
    meta.reason = "";
    try { await persistFinanceDecision(task, meta, { done: true }); }
    catch (error) { alert(`Freigabe konnte nicht gespeichert werden: ${error.message || error}`); }
  }

  async function reduce(taskId) {
    const task = getTask(taskId); const meta = parseFinanceMeta(task);
    if (!task || !meta) return;
    const gross = Number(meta.amount || 0);
    const raw = prompt(`Kürzung um …\n\nBitte entweder Prozent oder absoluten Betrag eingeben.\nBeispiele: 5%  oder  150,00\n\nRechnungsbetrag: ${money(gross, meta.currency)}`);
    if (raw === null) return;
    const percentMode = String(raw).includes("%");
    const entered = parseGermanNumber(raw);
    if (!Number.isFinite(entered) || entered <= 0) return alert("Bitte eine Kürzung größer 0 eingeben.");
    const deduction = percentMode ? gross * entered / 100 : entered;
    if (deduction <= 0 || deduction >= gross) return alert("Die Kürzung muss kleiner als der Rechnungsbetrag sein.");
    const reason = prompt("Grund der Kürzung / Text für die Überweisung:", meta.reason || "");
    if (reason === null) return;
    if (!String(reason).trim()) return alert("Bitte einen kurzen Grund für die Kürzung eintragen.");
    meta.decision = "reduced";
    meta.mode = percentMode ? "percent" : "absolute";
    meta.deduction = Math.round(deduction * 100) / 100;
    meta.approved = Math.round((gross - meta.deduction) * 100) / 100;
    meta.reason = String(reason).trim();
    try { await persistFinanceDecision(task, meta, { done: true }); }
    catch (error) { alert(`Kürzung konnte nicht gespeichert werden: ${error.message || error}`); }
  }

  async function block(taskId) {
    const task = getTask(taskId); const meta = parseFinanceMeta(task);
    if (!task || !meta) return;
    const reason = prompt("Warum ist diese Rechnung gesperrt?", meta.reason || "");
    if (reason === null) return;
    if (!String(reason).trim()) return alert("Bitte einen kurzen Sperrgrund eintragen.");
    meta.decision = "blocked";
    meta.mode = "";
    meta.deduction = 0;
    meta.approved = 0;
    meta.reason = String(reason).trim();
    try { await persistFinanceDecision(task, meta, { done: false }); }
    catch (error) { alert(`Sperre konnte nicht gespeichert werden: ${error.message || error}`); }
  }

  window.financeApproveTask = approve;
  window.financeReduceTask = reduce;
  window.financeBlockTask = block;

  function decisionButtons(task, compact = false) {
    const meta = parseFinanceMeta(task);
    if (!meta || task.status === "done") return "";
    const cls = compact ? "krista-finance-compact" : "krista-finance-modal-actions";
    return `<span class="${cls}"><button type="button" class="krista-finance-approved" onclick="financeApproveTask('${safe(task.id)}')">✓ Freigegeben</button><button type="button" class="krista-finance-reduced" onclick="financeReduceTask('${safe(task.id)}')">✂ Kürzung um</button><button type="button" class="krista-finance-blocked" onclick="financeBlockTask('${safe(task.id)}')">⛔ Gesperrt</button></span>`;
  }

  function taskIdFromRow(row) {
    const button = row.querySelector('button[onclick*="openTaskListModal"]');
    const onclick = String(button?.getAttribute("onclick") || "");
    const match = onclick.match(/openTaskListModal\(['\"]([^'\"]+)['\"]\)/);
    return match ? match[1] : "";
  }

  function decorateRows() {
    document.querySelectorAll("#taskList .krista-task-row").forEach((row) => {
      const task = getTask(taskIdFromRow(row));
      if (!task || !financeTask(task)) return;
      const meta = parseFinanceMeta(task); if (!meta) return;
      row.classList.add("krista-finance-task-row");
      const badges = row.querySelectorAll(".krista-task-badge");
      if (badges[0]) badges[0].textContent = "Rechnungsfreigabe";
      const firstCell = row.querySelector(".krista-task-cell");
      const sub = firstCell?.querySelector(".krista-task-sub");
      if (sub) sub.innerHTML = `<span class="krista-task-badge">Rechnungsfreigabe</span><span class="krista-finance-state ${safe(meta.decision)}">${safe(decisionLabel(meta))}</span><span class="krista-finance-amount">${safe(money(meta.amount, meta.currency))}</span>${meta.decision === "reduced" ? `<span class="krista-finance-pay">→ ${safe(money(meta.approved, meta.currency))}</span>` : ""}`;
      const actions = row.querySelector(".krista-task-actions");
      if (!actions) return;
      actions.querySelectorAll('button[onclick*="markTaskDone"],button.danger').forEach((button) => button.remove());
      let controls = actions.querySelector(".krista-finance-compact");
      if (task.status === "done") { if (controls) controls.remove(); return; }
      if (!controls) actions.insertAdjacentHTML("beforeend", decisionButtons(task, true));
    });
  }

  function decorateModal(taskId) {
    const task = getTask(taskId); if (!task || !financeTask(task)) return;
    const meta = parseFinanceMeta(task); if (!meta) return;
    const host = document.querySelector("#taskModalList .task-modal-item"); if (!host) return;
    host.classList.add("krista-finance-task-modal");
    host.querySelectorAll(".task-detail-grid strong").forEach((value) => {
      if (String(value.textContent || "").includes(MARKER)) value.textContent = decisionLabel(meta);
    });
    let panel = host.querySelector(".krista-finance-panel");
    if (!panel) {
      panel = document.createElement("div"); panel.className = "krista-finance-panel";
      const actions = host.querySelector(":scope > .actions");
      if (actions) host.insertBefore(panel, actions); else host.appendChild(panel);
    }
    panel.innerHTML = `<div class="krista-finance-panel-head"><strong>💶 Rechnungsfreigabe</strong><span class="krista-finance-state ${safe(meta.decision)}">${safe(decisionLabel(meta))}</span></div><div class="krista-finance-grid"><span>Rechnung</span><strong>${safe(meta.invoice || meta.doc || "–")}</strong><span>Rechnungsbetrag</span><strong>${safe(money(meta.amount, meta.currency))}</strong>${meta.decision === "reduced" ? `<span>Abzug</span><strong>${safe(money(meta.deduction, meta.currency))}</strong><span>Freigabebetrag / Überweisung</span><strong>${safe(money(meta.approved, meta.currency))}</strong>` : ""}${meta.reason ? `<span>Grund</span><strong>${safe(meta.reason)}</strong>` : ""}</div>`;
    const actions = host.querySelector(":scope > .actions");
    if (actions) {
      actions.querySelectorAll('button[onclick*="markTaskDone"]').forEach((button) => button.remove());
      actions.querySelectorAll(".krista-finance-modal-actions").forEach((node) => node.remove());
      if (task.status !== "done") actions.insertAdjacentHTML("beforeend", decisionButtons(task, false));
    }
  }

  function installStyle() {
    if (document.getElementById("kristaFinanceApprovalStyle")) return;
    const style = document.createElement("style");
    style.id = "kristaFinanceApprovalStyle";
    style.textContent = `
      #taskList .krista-finance-task-row{border-left-color:#3677b8}
      .krista-finance-state{display:inline-flex;align-items:center;border-radius:999px;padding:3px 7px;font-size:10px;font-weight:900;margin-right:5px;background:#eef0f2;color:#333}
      .krista-finance-state.approved{background:#dff2e3;color:#145829}.krista-finance-state.reduced{background:#e5efff;color:#1d4f91}.krista-finance-state.blocked{background:#ffe2e2;color:#8b1f1f}.krista-finance-state.pending{background:#fff0c7;color:#795400}
      .krista-finance-amount,.krista-finance-pay{font-size:11px;font-weight:850;margin-left:5px}.krista-finance-pay{color:#27713d}
      .krista-finance-compact,.krista-finance-modal-actions{display:flex;gap:5px;flex-wrap:wrap}
      .krista-finance-approved{background:#27713d!important;border-color:#27713d!important;color:#fff!important}.krista-finance-reduced{background:#315d91!important;border-color:#315d91!important;color:#fff!important}.krista-finance-blocked{background:#9d2525!important;border-color:#9d2525!important;color:#fff!important}
      .krista-finance-panel{margin-top:14px;padding:14px;border:1px solid #d7dfe8;border-radius:12px;background:#f7faff}.krista-finance-panel-head{display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}.krista-finance-grid{display:grid;grid-template-columns:minmax(150px,.8fr) minmax(180px,1.2fr);gap:7px 14px;font-size:13px}.krista-finance-grid span{color:#666}.krista-finance-grid strong{text-align:right}
      @media(max-width:800px){.krista-finance-compact{width:100%}.krista-finance-compact button{flex:1}.krista-finance-grid{grid-template-columns:1fr}.krista-finance-grid strong{text-align:left}}
    `;
    document.head.appendChild(style);
  }

  function installRenderHook() {
    if (typeof renderTasks !== "function") return false;
    if (renderTasks.__kristaFinanceApproval) return true;
    const original = renderTasks;
    const wrapped = function () {
      const result = original.apply(this, arguments);
      setTimeout(decorateRows, 0);
      return result;
    };
    wrapped.__kristaCompact = Boolean(original.__kristaCompact);
    wrapped.__kristaFinanceApproval = true;
    window.renderTasks = wrapped;
    setTimeout(decorateRows, 0);
    return true;
  }

  function installModalHook() {
    if (typeof openTaskListModal !== "function") return false;
    if (openTaskListModal.__kristaFinanceApproval) return true;
    const original = openTaskListModal;
    const wrapped = function (focusId = "") {
      const result = original.apply(this, arguments);
      if (focusId) setTimeout(() => decorateModal(String(focusId)), 0);
      return result;
    };
    wrapped.__kristaAttachments = Boolean(original.__kristaAttachments);
    wrapped.__kristaFinanceApproval = true;
    window.openTaskListModal = wrapped;
    return true;
  }

  function install() {
    installStyle();
    installRenderHook();
    installModalHook();
    decorateRows();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();

  setInterval(() => {
    installRenderHook();
    installModalHook();
    decorateRows();
  }, 1200);
})();
