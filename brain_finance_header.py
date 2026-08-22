# coding: utf-8
"""Einheitlicher The-Brain-Kopf fuer die Finance-Unterseiten."""


def install(ns):
    app = ns.get("app")
    if app is None:
        return

    css = r'''
<style id="kristaFinanceBrainHeadCss">
.brain-finance-head{max-width:1500px;margin:0 auto;padding:24px 18px 4px;display:flex;align-items:flex-start;justify-content:space-between;gap:18px}
.brain-finance-brand{color:#eef2f4;text-decoration:none;display:block}.brain-finance-brand small{display:block;color:#9da8b3;font-size:13px;font-weight:750;letter-spacing:.02em;margin-bottom:4px}.brain-finance-brand strong{display:block;font-size:31px;line-height:1.05;letter-spacing:-.02em}.brain-finance-home{color:#dce3e8;text-decoration:none;font-weight:850;padding-top:18px}.brain-finance-home:hover{text-decoration:underline}
@media(max-width:620px){.brain-finance-head{padding-top:18px}.brain-finance-brand strong{font-size:27px}.brain-finance-home{padding-top:15px;font-size:13px}}
</style>
'''
    head = r'''
<header class="brain-finance-head" id="kristaFinanceBrainHead">
  <a class="brain-finance-brand" href="/"><small>KRISTINE</small><strong>The Brain</strong></a>
  <a class="brain-finance-home" href="/">Firmenwissen</a>
</header>
'''

    def wrap(view_name):
        original = app.view_functions.get(view_name)
        if not original or getattr(original, "_krista_finance_head", False):
            return

        def decorated(*args, **kwargs):
            response = app.make_response(original(*args, **kwargs))
            try:
                html = response.get_data(as_text=True)
                if "kristaFinanceBrainHead" not in html and "<body" in html:
                    html = html.replace("</head>", css + "</head>", 1)
                    body_end = html.find(">", html.find("<body"))
                    if body_end >= 0:
                        html = html[:body_end + 1] + head + html[body_end + 1:]
                    response.set_data(html)
                    response.headers["Content-Type"] = "text/html; charset=utf-8"
                return response
            except Exception:
                return response

        decorated.__name__ = f"{view_name}_with_brain_head"
        decorated._krista_finance_head = True
        app.view_functions[view_name] = decorated

    for name in (
        "brain_incoming_payments_page",
        "brain_incoming_revolut_page",
        "brain_reconciliation_page",
    ):
        wrap(name)

    print("✅ Finance-Kopf: KRISTINE / The Brain / Firmenwissen")
