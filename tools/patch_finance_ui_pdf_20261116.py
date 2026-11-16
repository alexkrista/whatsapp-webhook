from pathlib import Path
p=Path(__file__).resolve().parents[1]/"public/ui/kristine-finance-approval.js"
s=p.read_text(encoding="utf-8")
marker='  const MARKER = "[FINANCE_APPROVAL]";'
assert s.count(marker)==1
s=s.replace(marker,marker+'''
  const BRAIN_ORIGIN = "https://pc-alex02.tail610122.ts.net";
  const reviewed = new Set();
  const reviewKey = (meta) => [meta.source,meta.id,meta.invoice,meta.amount].join("|");
  function requireReviewed(task,meta) {
    if (meta.source === "KRISTINE" && reviewed.has(reviewKey(meta))) return true;
    alert("Bitte zuerst die Originalrechnung öffnen, prüfen und in der Freigabeaufgabe die Prüfung bestätigen.");
    if (typeof openTaskListModal === "function") openTaskListModal(task.id);
    return false;
  }
''')
anchor='    meta.decision = "approved";'
assert s.count(anchor)==1
s=s.replace(anchor,'    if (!requireReviewed(task,meta)) return;\n'+anchor)
anchor='    const gross = Number(meta.amount || 0);'
assert s.count(anchor)==1
s=s.replace(anchor,'    if (!requireReviewed(task,meta)) return;\n'+anchor)
anchor='    const actions = host.querySelector(":scope > .actions");'
index=s.index('    panel.innerHTML = '+chr(96)+'<div class="krista-finance-panel-head">')
offset=s.index(anchor,index)
insert='''    const supported = meta.source === "KRISTINE" && /^kristine:[0-9]+$/.test(meta.id);
    const invoiceLink = supported
      ? BRAIN_ORIGIN + "/incoming/approval-document?source=KRISTINE&id=" + encodeURIComponent(meta.id)
      : "";
    const checkPanel = document.createElement("div");
    checkPanel.className = "krista-finance-review";
    if (invoiceLink) {
      const link = document.createElement("a");
      link.href = invoiceLink; link.target = "_blank"; link.rel = "noopener noreferrer";
      link.textContent = "Originalrechnung als PDF öffnen";
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = reviewed.has(reviewKey(meta));
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) reviewed.add(reviewKey(meta));
        else reviewed.delete(reviewKey(meta));
      });
      label.append(checkbox,document.createTextNode(" Ich habe diese Originalrechnung geöffnet und geprüft."));
      checkPanel.append(link,label);
    } else {
      checkPanel.textContent = "Keine eindeutige Rechnungs-ID vorhanden – Freigabe gesperrt. Bitte Rechnungseingang kontrollieren.";
    }
    panel.append(checkPanel);
'''
s=s[:offset]+insert+s[offset:]
sty='      .krista-finance-panel{margin-top:14px;'
assert s.count(sty)==1
s=s.replace(sty,'''      .krista-finance-review{margin-top:15px;padding:10px;border:1px solid #d7dfe8;border-radius:8px;background:white;display:grid;gap:10px;font-size:13px}
      .krista-finance-review a{font-weight:800;color:#165b85;text-decoration:underline}
      .krista-finance-review label{display:flex;align-items:center;gap:8px;line-height:1.4;font-weight:650}
      .krista-finance-review input{width:19px;height:19px}
'''+sty)
p.write_text(s,encoding="utf-8")
print("ui patched")
