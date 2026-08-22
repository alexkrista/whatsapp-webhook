"use strict";

(function () {
  const token = new URLSearchParams(location.search).get("token") || "";

  function authUrl(path) {
    if (!token) return path;
    return path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
  }

  function employeeId() {
    return String(localStorage.getItem("kristineGoEmployeeId") || new URLSearchParams(location.search).get("employeeId") || "").trim();
  }

  function employeeName() {
    return String(document.getElementById("kgEmployeeName")?.textContent || "Mitarbeiter").trim();
  }

  function toast(text, error = false) {
    const existing = document.getElementById("kgToast");
    if (existing) {
      existing.textContent = text;
      existing.classList.add("kg-toast-show");
      if (error) existing.dataset.kind = "error"; else delete existing.dataset.kind;
      clearTimeout(existing._invoiceTimer);
      existing._invoiceTimer = setTimeout(() => existing.classList.remove("kg-toast-show"), 4200);
      return;
    }
    alert(text);
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Datei konnte nicht gelesen werden"));
      reader.readAsDataURL(file);
    });
  }

  async function upload(file, button) {
    const id = employeeId();
    const name = employeeName();
    if (!id) {
      toast("Bitte zuerst den Mitarbeiter auswählen.", true);
      return;
    }
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) {
      toast("Rechnung ist größer als 12 MB.", true);
      return;
    }

    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="kg-invoice-icon">⏳</span><span class="kg-invoice-copy"><strong>Wird abgelegt …</strong><small>Bitte kurz warten</small></span><span class="kg-invoice-arrow">›</span>';
    try {
      const data = await readAsDataUrl(file);
      const response = await fetch(authUrl("/kristine/api/invoice-intake/import"), {
        method: "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          name: file.name || `Rechnung_${Date.now()}.jpg`,
          type: file.type || "application/octet-stream",
          data,
          source: "KGO Scan",
          submittedById: id,
          submittedByName: name,
          capturedAt: new Date().toISOString(),
          paymentContext: "beim Bezahlen fotografiert",
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      toast(result.duplicate
        ? "✓ Rechnung war bereits im Eingangskorb."
        : `✓ Rechnung im Eingangskorb · ${name}`);
    } catch (error) {
      toast("Rechnung konnte nicht abgelegt werden: " + String(error?.message || error), true);
    } finally {
      button.disabled = false;
      button.innerHTML = original;
    }
  }

  function install() {
    if (document.getElementById("kgInvoiceScanCard")) return;
    const content = document.getElementById("kgContent");
    if (!content) return;

    const card = document.createElement("section");
    card.id = "kgInvoiceScanCard";
    card.className = "kg-invoice-scan-card";
    card.innerHTML = `
      <button id="kgInvoiceScanButton" class="kg-invoice-scan-button" type="button">
        <span class="kg-invoice-icon">🧾</span>
        <span class="kg-invoice-copy">
          <strong>Rechnung scannen</strong>
          <small>Foto landet mit deinem Namen + Zeit im Eingangskorb</small>
        </span>
        <span class="kg-invoice-arrow">›</span>
      </button>
      <input id="kgInvoiceScanInput" type="file" accept="image/*,application/pdf" capture="environment" hidden>
    `;

    const brain = document.getElementById("kgBrainCard");
    const greeting = document.getElementById("kgGreeting");
    if (brain?.parentElement === content) brain.insertAdjacentElement("afterend", card);
    else if (greeting?.parentElement === content) greeting.insertAdjacentElement("afterend", card);
    else content.prepend(card);

    const style = document.createElement("style");
    style.textContent = `
      .kg-invoice-scan-card{margin:12px 0 18px}
      .kg-invoice-scan-button{width:100%;display:flex;align-items:center;gap:12px;border:1px solid rgba(16,35,63,.14);border-radius:18px;padding:14px 16px;background:#fff;color:#10233f;box-shadow:0 8px 24px rgba(16,35,63,.08);text-align:left;cursor:pointer}
      .kg-invoice-scan-button:disabled{opacity:.65;cursor:wait}
      .kg-invoice-icon{width:44px;height:44px;display:grid;place-items:center;border-radius:13px;background:#e8f1ea;color:#1f6038;font-size:23px;flex:0 0 auto}
      .kg-invoice-copy{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}.kg-invoice-copy strong{font-size:16px;line-height:1.15}.kg-invoice-copy small{font-size:12px;color:#657387}.kg-invoice-arrow{font-size:28px;line-height:1;color:#657387}
    `;
    document.head.appendChild(style);

    const button = document.getElementById("kgInvoiceScanButton");
    const input = document.getElementById("kgInvoiceScanInput");
    button?.addEventListener("click", () => input?.click());
    input?.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.value = "";
      if (file) await upload(file, button);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
