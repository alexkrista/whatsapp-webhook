"use strict";
(function(){
  const qs = new URLSearchParams(location.search);
  const token = qs.get("token") || "";

  async function api(url, opt={}) {
    const join = url.includes("?") ? "&" : "?";
    const response = await fetch(url + (token ? join + "token=" + encodeURIComponent(token) : ""), {
      ...opt,
      headers: { "Content-Type":"application/json", ...(opt.headers || {}) },
    });
    const data = await response.json().catch(() => ({ ok:false, error:"Keine JSON-Antwort" }));
    if (!response.ok || data.ok === false) throw new Error(data.error || ("HTTP " + response.status));
    return data;
  }

  function install(){
    if (document.getElementById("stockBackupCheckBtn")) return true;
    const tools = document.querySelector("#tab-inventory .inventory-tools");
    if (!tools) return false;

    const button = document.createElement("button");
    button.type = "button";
    button.id = "stockBackupCheckBtn";
    button.className = "btn";
    button.textContent = "IST aus Backup prüfen";
    button.title = "Prüft das automatische Backup vor dem LG-Neuaufbau. Zunächst wird nichts verändert.";

    const status = document.createElement("span");
    status.id = "stockBackupCheckStatus";
    status.className = "muted";
    status.style.fontSize = "12px";

    tools.appendChild(button);
    tools.appendChild(status);

    button.addEventListener("click", async () => {
      button.disabled = true;
      status.textContent = "Prüfe Backup …";
      try {
        const p = await api("/admin/api/paint/inventory/stock-backup-preview");
        if (!p.safe) throw new Error(`Backup nicht sicher genug: nur ${p.matched || 0} Artikel eindeutig gefunden.`);
        const sample = (p.preview || []).slice(0, 8).map(x =>
          `${x.product || ""} ${x.size || ""} ${x.baseCode || x.baseName || ""}: ${x.currentStock} → ${x.backupStock}`
        ).join("\n");
        const text = [
          "IST-Bestand aus dem automatischen Backup prüfen / zurückholen?",
          "",
          `Backup: ${p.backupName}`,
          `Artikel eindeutig gefunden: ${p.matched}`,
          `Backup-Positionen mit IST > 0: ${p.backupNonZero}`,
          `Aktuell Positionen mit IST > 0: ${p.currentNonZero}`,
          `Abweichende IST-Werte: ${p.changed}`,
          sample ? "\nBeispiele:\n" + sample : "",
          "",
          "Bei Bestätigung wird NUR der IST-Bestand zurückgeholt.",
          "Mindest, Soll, EAN, Colourants und Bestellmengen bleiben unverändert.",
          "Vorher wird nochmals ein Sicherheitsbackup des jetzigen Standes angelegt."
        ].filter(Boolean).join("\n");

        if (!window.confirm(text)) {
          status.textContent = `Nur geprüft: ${p.backupNonZero} alte IST-Werte > 0 gefunden.`;
          return;
        }

        status.textContent = "Stelle ausschließlich IST wieder her …";
        const r = await api("/admin/api/paint/inventory/stock-backup-restore", {
          method:"POST",
          body: JSON.stringify({ confirm:"RESTORE_STOCK_ONLY" }),
        });
        status.textContent = `IST wiederhergestellt: ${r.restored || 0} Positionen.`;
        document.getElementById("inventoryReload")?.click();
        setTimeout(() => location.reload(), 650);
      } catch (error) {
        status.textContent = String(error?.message || error);
      } finally {
        button.disabled = false;
      }
    });
    return true;
  }

  if (!install()) {
    const observer = new MutationObserver(() => {
      if (install()) observer.disconnect();
    });
    observer.observe(document.body, { childList:true, subtree:true });
  }
})();
