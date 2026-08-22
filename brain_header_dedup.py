# coding: utf-8
"""Entfernt den alten Brain-Linie-2-Kopf, nachdem der globale KRISTA-Kopf gesetzt wurde.

Flask fuehrt after_request-Hooks in umgekehrter Registrierungsreihenfolge aus.
Darum wird dieses Modul VOR brain_finance_header installiert: Der globale Kopf
wird zuerst injiziert, danach entfernt dieser Hook nur den historischen
`.krista-brain-head` aus brain_line2. Ergebnis: genau EIN Produktkopf.
"""

from __future__ import annotations

import re


def install(ns):
    app = ns.get("app")
    if app is None or getattr(app, "_krista_brain_header_dedup", False):
        return

    @app.after_request
    def krista_brain_header_dedup(response):
        try:
            content_type = str(response.headers.get("Content-Type") or "").lower()
            if "text/html" not in content_type:
                return response
            html = response.get_data(as_text=True)
            if "krista-brain-head" not in html:
                return response

            # Nur den alten Linie-2-Kopf entfernen. Der neue globale Kopf hat
            # `krista-shell-topbar` / `kristaBrainGlobalHeader` und bleibt bestehen.
            html = re.sub(
                r'<header\s+class="krista-brain-head".*?</header>',
                '', html, count=1, flags=re.I | re.S,
            )
            response.set_data(html)
            response.headers["Content-Type"] = "text/html; charset=utf-8"
            return response
        except Exception as exc:
            print("⚠ Brain-Kopf-Deduplizierung:", exc)
            return response

    app._krista_brain_header_dedup = True
    print("✅ The Brain: alter Linie-2-Kopf entfernt · nur ein KRISTA-Kopf")
