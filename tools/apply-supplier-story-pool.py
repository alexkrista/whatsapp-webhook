from pathlib import Path
root = Path(__file__).resolve().parents[1]
server = root / "kristine.js"
code = server.read_text(encoding="utf-8")
anchor = '  app.get("/kristine/story-pool", serveStoryPoolFile("index.html"));'
assert code.count(anchor) == 1
code = code.replace(anchor, '''  const { registerSupplierStoryPool } = require("./supplier-story-pool");
  registerSupplierStoryPool(app, requireAdmin);
  app.get("/kristine/story-pool/supplier-ui.js", serveStoryPoolFile("supplier-ui.js"));

''' + anchor)
server.write_text(code, encoding="utf-8")
html = root / "story-pool" / "index.html"
code = html.read_text(encoding="utf-8")
anchor = '<section><h2>Reposts mit Original-Link</h2>'
assert code.count(anchor) == 1
new_section = '''<section id="supplier-pool" aria-labelledby="supplier-pool-title">
  <h2 id="supplier-pool-title">Lieferanten-Stories übernehmen</h2>
  <p class="note">Instagram-Link einfügen und als Idee speichern. KRISTINE übernimmt keinen fremden Story-Inhalt ohne Berechtigung. Original teilen öffnet Instagram; Canva öffnet den Editor, eine automatische Übernahme findet noch nicht statt.</p>
  <form id="supplier-form" class="card">
    <label>Instagram- oder Lieferanten-Link <input name="link" type="url" required placeholder="https://www.instagram.com/..." style="display:block;width:100%;padding:.7rem;margin:.4rem 0 1rem"></label>
    <label>Lieferant (optional) <input name="supplier" type="text" maxlength="90" placeholder="wird aus dem Link vorgeschlagen" style="display:block;width:100%;padding:.7rem;margin:.4rem 0 1rem"></label>
    <label>Krista-Kommentar (optional) <textarea name="note" rows="3" maxlength="1200" placeholder="Was gefällt uns daran?" style="display:block;width:100%;padding:.7rem;margin:.4rem 0 1rem"></textarea></label>
    <button type="submit">Im Ideenpool speichern</button>
  </form>
  <p id="supplier-message" role="status" class="note" aria-live="polite"></p>
  <div id="supplier-list" class="grid"></div>
</section>
'''
code = code.replace(anchor, new_section + anchor)
scriptanchor = '</body>'
assert code.count(scriptanchor) == 1
code = code.replace(scriptanchor, '<script src="/kristine/story-pool/supplier-ui.js" defer></script>\n' + scriptanchor)
html.write_text(code, encoding="utf-8")
print("Supplier Story Pool installed into worktree (not deployed)")
