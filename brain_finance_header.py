# coding: utf-8
"""Einheitlicher The-Brain-Kopf fuer alle Unterseiten.

Die Startseite ist die Referenz: KRISTINE / The Brain / Firmenwissen.
Jede weitere HTML-Seite des lokalen Brain-Connectors bekommt exakt denselben
Kopf per after_request. Dadurch muss kein neues Modul seinen eigenen Kopf bauen
und spaetere Wrapper (OP, CAMT, Revolut, Erfassung, Material usw.) koennen ihn
nicht mehr versehentlich verlieren.
"""


def install(ns):
    app = ns.get("app")
    if app is None:
        return

    css = r'''
<style id="kristaFinanceBrainHeadCss">
.brain-finance-head{max-width:1500px;margin:0 auto;padding:24px 18px 4px;display:flex;align-items:flex-start;justify-content:space-between;gap:18px}
.brain-finance-brand{color:#eef2f4;text-decoration:none;display:block}.brain-finance-brand small{display:block;color:#9da8b3;font-size:13px;font-weight:750;letter-spacing:.02em;margin-bottom:4px}.brain-finance-brand strong{display:block;font-size:31px;line-height:1.05;letter-spacing:-.02em}.brain-finance-home{color:#dce3e8;text-decoration:none;font-weight:850;padding-top:18px}.brain-finance-home:hover{text-decoration:underline}
.brain-finance-head+main.shell{padding-top:12px}
@media(max-width:620px){.brain-finance-head{padding-top:18px}.brain-finance-brand strong{font-size:27px}.brain-finance-home{padding-top:15px;font-size:13px}}
</style>
'''
    head = r'''
<header class="brain-finance-head" id="kristaFinanceBrainHead">
  <a class="brain-finance-brand" href="/"><small>KRISTINE</small><strong>The Brain</strong></a>
  <a class="brain-finance-home" href="/">Firmenwissen</a>
</header>
'''

    # / und /mobile sind bereits die Referenzoberflaeche und besitzen diesen Kopf
    # nativ. Alle echten Unterseiten werden hier zentral vereinheitlicht.
    reference_paths = {"/", "/mobile", "/mobile/"}

    if getattr(app, "_krista_finance_head_after_request", False):
        return

    from flask import request

    @app.after_request
    def krista_finance_brain_head(response):
        try:
            if request.path in reference_paths:
                return response
            content_type = str(response.headers.get("Content-Type") or "").lower()
            if "text/html" not in content_type:
                return response
            html = response.get_data(as_text=True)
            if "kristaFinanceBrainHead" in html:
                return response
            if "</head>" in html and "kristaFinanceBrainHeadCss" not in html:
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
            print("⚠ The-Brain-Kopf konnte nicht eingesetzt werden:", exc)
            return response

    app._krista_finance_head_after_request = True
    print("✅ The-Brain-Kopf: einheitlich auf allen Unterseiten")
