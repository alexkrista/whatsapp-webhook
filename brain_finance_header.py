# coding: utf-8
"""Einheitlicher KRISTA-Produktkopf fuer alle HTML-Seiten von The Brain.

The Brain soll keine eigene Kopf-Variante mehr haben. Der lokale Connector bekommt
auf jeder HTML-Seite denselben Produktkopf wie KRISTOWER/KRISTINE/KRISZEIT/LG.
Die Links auf die Render-Module werden serverseitig mit dem vorhandenen
KRISTINE-Admin-Token versehen, damit Navigation aus dem privaten Brain nicht auf
403/Forbidden bzw. unvollstaendig authentifizierten Seiten landet.
"""

from urllib.parse import quote


def install(ns):
    app = ns.get("app")
    if app is None:
        return

    render_base = str(ns.get("KRISTINE_API_BASE") or "https://protokoll.krista.at").rstrip("/")
    admin_token = str(ns.get("KRISTINE_ADMIN_TOKEN") or "").strip()

    def render_url(path, fragment=""):
        path = str(path or "/")
        url = render_base + path
        if admin_token:
            url += ("&" if "?" in url else "?") + "token=" + quote(admin_token, safe="")
        if fragment:
            url += "#" + str(fragment).lstrip("#")
        return url

    kristower_url = render_url("/kontrollzentrum")
    kriszeit_url = render_url("/kristool-preview/")
    lg_url = render_url("/admin/paint?scan=1")
    kristine_url = render_url("/kristine", "planning")
    krisadmin_url = render_url("/admin/ui")
    tasks_url = render_url("/kristine", "tasks")

    css = r'''
<style id="kristaBrainGlobalHeaderCss">
.krista-shell-topbar{position:relative;z-index:200;color:#fff;background:radial-gradient(circle at 12% -20%,rgba(90,145,108,.28),transparent 34%),linear-gradient(135deg,#17211b,#253129);border-bottom:1px solid rgba(255,255,255,.1);box-shadow:0 8px 28px rgba(12,18,14,.2);font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
.krista-shell-main{max-width:1480px;margin:auto;min-height:76px;padding:14px 22px;display:grid;grid-template-columns:230px minmax(560px,1fr) 170px;gap:18px;align-items:center}
.krista-brand{display:flex;align-items:center;gap:12px;color:#fff;text-decoration:none;min-width:0}.krista-mark{width:46px;height:46px;display:grid;place-items:center;flex:0 0 auto;border-radius:14px;background:linear-gradient(145deg,#f2e7c8,#b58d43);color:#262018;font-size:23px;font-weight:950;box-shadow:inset 0 1px 0 rgba(255,255,255,.7),0 7px 20px rgba(0,0,0,.22)}.krista-brand-copy{display:flex;flex-direction:column;min-width:0}.krista-brand-copy strong{font-size:19px;letter-spacing:.06em;line-height:1}.krista-brand-copy small{margin-top:5px;color:rgba(255,255,255,.65);white-space:nowrap}
.krista-world-nav{display:flex;justify-content:center;align-items:center;gap:8px;min-width:0}.krista-world-link{min-height:42px;padding:9px 14px;border-radius:11px;border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.055);color:#fff;text-decoration:none;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;gap:7px;font:800 12.5px/1 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}.krista-world-link:hover{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.27)}.krista-world-link.active{background:#2f7d4a;border-color:#69a47d;box-shadow:0 6px 18px rgba(15,57,32,.34)}.krista-world-icon{font-size:15px;line-height:1}.krista-mobile-menu{display:none}.krista-user{text-align:right;display:flex;flex-direction:column}.krista-user strong{font-size:13px}.krista-user small{margin-top:4px;color:rgba(255,255,255,.6)}
@media(max-width:1050px){.krista-shell-main{grid-template-columns:205px 1fr}.krista-user{display:none}.krista-world-nav{justify-content:flex-start;overflow-x:auto;padding-bottom:3px}}
@media(max-width:760px){.krista-shell-main{min-height:54px;grid-template-columns:minmax(0,1fr) auto;padding:8px 10px;gap:8px}.krista-brand{gap:8px}.krista-mark{width:34px;height:34px;border-radius:10px;font-size:18px}.krista-brand-copy strong{font-size:15px}.krista-brand-copy small{display:none}.krista-mobile-menu{display:inline-flex;min-height:36px;padding:7px 10px;border:1px solid rgba(255,255,255,.2);border-radius:10px;background:rgba(255,255,255,.08);color:#fff;align-items:center;justify-content:center;gap:6px;font:850 12.5px/1 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}.krista-world-nav{display:none;grid-column:1/-1;overflow:visible;padding:4px 0 2px;gap:6px;flex-direction:column;align-items:stretch}.krista-shell-topbar.menu-open .krista-world-nav{display:flex}.krista-world-link{width:100%;min-height:40px;justify-content:flex-start;padding:9px 12px}.krista-user{display:none}}
</style>
'''

    head = f'''
<header class="krista-shell-topbar" id="kristaBrainGlobalHeader">
  <div class="krista-shell-main">
    <a class="krista-brand" href="{kristower_url}" aria-label="KRISTA Start">
      <span class="krista-mark" aria-hidden="true">K</span>
      <span class="krista-brand-copy"><strong>KRISTA</strong><small>Einfach. Intuitiv. Gemeinsam.</small></span>
    </a>
    <button class="krista-mobile-menu" id="kristaBrainMobileMenu" type="button" aria-expanded="false"><span>🧠</span><span>THE BRAIN</span><span>▾</span></button>
    <nav class="krista-world-nav" id="kristaBrainWorldNav" aria-label="KRISTA Arbeitswelten">
      <a class="krista-world-link" href="{kristower_url}"><span class="krista-world-icon">⌂</span><span>KRISTOWER</span></a>
      <a class="krista-world-link" href="{kriszeit_url}"><span class="krista-world-icon">⏱</span><span>KRISZEIT</span></a>
      <a class="krista-world-link active" href="/" aria-current="page"><span class="krista-world-icon">🧠</span><span>THE BRAIN</span></a>
      <a class="krista-world-link" href="{lg_url}"><span class="krista-world-icon">🎨</span><span>LG</span></a>
      <a class="krista-world-link" href="{kristine_url}"><span class="krista-world-icon">✦</span><span>KRISTINE</span></a>
      <a class="krista-world-link" href="{krisadmin_url}"><span class="krista-world-icon">⚙</span><span>KRISADMIN</span></a>
      <a class="krista-world-link" href="{tasks_url}"><span class="krista-world-icon">📌</span><span>AUFGABEN</span></a>
    </nav>
    <div class="krista-user"><strong>Alexander Krista</strong><small>The Brain</small></div>
  </div>
</header>
<script id="kristaBrainGlobalHeaderJs">
(function(){{
 const h=document.getElementById('kristaBrainGlobalHeader'),b=document.getElementById('kristaBrainMobileMenu');if(!h||!b)return;
 const setOpen=o=>{{h.classList.toggle('menu-open',!!o);b.setAttribute('aria-expanded',o?'true':'false');b.innerHTML=o?'<span>×</span><span>Schließen</span>':'<span>🧠</span><span>THE BRAIN</span><span>▾</span>'}};
 b.addEventListener('click',()=>setOpen(!h.classList.contains('menu-open')));document.getElementById('kristaBrainWorldNav')?.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>setOpen(false)));window.addEventListener('resize',()=>{{if(innerWidth>760)setOpen(false)}},{{passive:true}});
}})();
</script>
'''

    if getattr(app, "_krista_brain_global_header", False):
        return

    @app.after_request
    def krista_brain_global_header(response):
        try:
            content_type = str(response.headers.get("Content-Type") or "").lower()
            if "text/html" not in content_type:
                return response
            html = response.get_data(as_text=True)
            if "kristaBrainGlobalHeader" in html:
                return response

            # Alte Brain-Kopfvarianten entfernen. Damit bleibt auf jeder Seite
            # genau ein gemeinsamer KRISTA-Produktkopf stehen.
            import re
            html = re.sub(r'<style id="kristaFinanceBrainHeadCss">.*?</style>', '', html, flags=re.I | re.S)
            html = re.sub(r'<header class="brain-finance-head" id="kristaFinanceBrainHead">.*?</header>', '', html, flags=re.I | re.S)
            html = re.sub(r'<header class="krista-brain-head">.*?</header>', '', html, flags=re.I | re.S)

            if "</head>" in html:
                html = html.replace("</head>", css + "</head>", 1)
            body_pos = html.find("<body")
            if body_pos >= 0:
                body_end = html.find(">", body_pos)
                if body_end >= 0:
                    html = html[:body_end + 1] + head + html[body_end + 1:]
                    response.set_data(html)
                    response.headers["Content-Type"] = "text/html; charset=utf-8"
            return response
        except Exception as exc:
            print("⚠ KRISTA-Produktkopf konnte in The Brain nicht eingesetzt werden:", exc)
            return response

    app._krista_brain_global_header = True
    print("✅ The Brain: ein KRISTA-Produktkopf · Navigation authentifiziert")
