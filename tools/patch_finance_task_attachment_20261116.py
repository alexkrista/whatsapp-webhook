from pathlib import Path
p=Path(__file__).resolve().parents[1]/"public/ui/kristine-task-list.js"
s=p.read_text(encoding="utf-8")
mark='  function renderAttachmentPanel(taskId, items, error = "") {'
assert s.count(mark)==1
helper='''  function financeOriginalAttachmentUrl(taskId) {
    try {
      const task = (typeof data !== "undefined" && Array.isArray(data?.tasks))
        ? data.tasks.find((item) => String(item.id || "") === String(taskId || ""))
        : null;
      const reminder = String(task?.reminder || "");
      const match = reminder.match(/\\[FINANCE_APPROVAL\\]source=KRISTINE;id=([^;]+)/);
      if (!match) return "";
      const invoiceId = decodeURIComponent(match[1]);
      if (!/^kristine:[0-9]+$/.test(invoiceId)) return "";
      return "https://pc-alex02.tail610122.ts.net/incoming/approval-document?source=KRISTINE&id=" + encodeURIComponent(invoiceId);
    } catch { return ""; }
  }

'''
s=s.replace(mark,helper+mark)
start=s.index('    if (!items.length) {',s.index(mark))
end=s.index('    panel.innerHTML = ',start)
# Find exact block end by next "    }" after the return panel statement.
blockEnd=s.index('    }',end)+len('    }')
old=s[start:blockEnd]
assert 'return panel;' in old and 'Keine Anlagen' in old
new='''    if (!items.length) {
      const invoiceUrl = financeOriginalAttachmentUrl(taskId);
      if (invoiceUrl) {
        panel.innerHTML = '<h5>Originalrechnung</h5><div class="krista-task-attachment-row"><div><div class="krista-task-attachment-name">Originalrechnung aus The Brain</div><div class="krista-task-attachment-meta">Eindeutige interne Rechnungs-ID</div></div><div class="krista-task-attachment-links"><a href="' + invoiceUrl + '" target="_blank" rel="noopener noreferrer">PDF öffnen</a></div></div>';
      } else {
        panel.innerHTML = '<h5>Anlagen</h5><div class="krista-task-attachment-empty">Keine Anlagen mit dieser Aufgabe verknüpft.</div>';
      }
      return panel;
    }'''
s=s[:start]+new+s[blockEnd:]
p.write_text(s,encoding="utf-8")
print("Task attachment links updated")
