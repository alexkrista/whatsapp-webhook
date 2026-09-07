"use strict";

(function installKristineNfon(){
  const token = new URLSearchParams(location.search).get("token") || "";
  let status = null;
  let pendingPhone = "";

  function endpoint(path) {
    return path + (token ? `${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : "");
  }
  async function request(path, options = {}) {
    const response = await fetch(endpoint(path), options);
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) throw new Error(body?.error || text || `HTTP ${response.status}`);
    return body;
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>\"]/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" })[char]);
  }
  function ensureDialog() {
    let dialog = document.getElementById("kristineNfonDialog");
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.id = "kristineNfonDialog";
    dialog.style.cssText = "border:0;border-radius:16px;padding:0;box-shadow:0 24px 80px #0005;width:min(460px,calc(100% - 24px))";
    dialog.innerHTML = `<div style="padding:18px"><h3 style="margin:0 0 8px">Über NFON anrufen</h3><div id="kristineNfonNumber" style="font-weight:800;margin-bottom:14px"></div><div id="kristineNfonChoices" style="display:grid;gap:8px"></div><div id="kristineNfonMessage" class="small" style="margin-top:12px"></div><div class="actions" style="margin-top:14px"><button type="button" class="secondary" data-nfon-close>Schließen</button></div></div>`;
    dialog.querySelector("[data-nfon-close]").onclick = () => dialog.close();
    document.body.appendChild(dialog);
    return dialog;
  }
  async function callFrom(extension) {
    const dialog = ensureDialog();
    const message = dialog.querySelector("#kristineNfonMessage");
    const buttons = [...dialog.querySelectorAll("[data-nfon-extension]")];
    buttons.forEach(button => button.disabled = true);
    message.textContent = "NFON ruft zuerst die gewählte Nebenstelle an …";
    try {
      await request("/kristine/api/nfon/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extension, phone: pendingPhone }),
      });
      message.textContent = "✓ Anruf wurde gestartet. Bitte Hörer abnehmen.";
    } catch (error) {
      message.textContent = `Anruf konnte nicht gestartet werden: ${error.message}`;
      buttons.forEach(button => button.disabled = false);
    }
  }
  function openDialer(phone) {
    if (!status?.ready) return;
    pendingPhone = String(phone || "").trim();
    const dialog = ensureDialog();
    dialog.querySelector("#kristineNfonNumber").textContent = pendingPhone;
    dialog.querySelector("#kristineNfonMessage").textContent = "";
    dialog.querySelector("#kristineNfonChoices").innerHTML = status.officeExtensions.map(row =>
      `<button type="button" data-nfon-extension="${escapeHtml(row.extension)}">📞 ${escapeHtml(row.name)} · ${escapeHtml(row.extension)}</button>`
    ).join("");
    dialog.querySelectorAll("[data-nfon-extension]").forEach(button => {
      button.onclick = () => callFrom(button.dataset.nfonExtension);
    });
    dialog.showModal();
  }
  async function loadStatus() {
    try {
      status = await request("/kristine/api/nfon/status");
      document.documentElement.dataset.nfonReady = status.ready ? "1" : "0";
    } catch {
      status = null;
      document.documentElement.dataset.nfonReady = "0";
    }
  }
  document.addEventListener("click", event => {
    const link = event.target.closest?.('a[href^="tel:"]');
    if (!link || !status?.ready) return;
    event.preventDefault();
    openDialer(decodeURIComponent(link.getAttribute("href").slice(4)));
  });
  loadStatus();
})();
