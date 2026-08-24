# coding: utf-8
"""Revolut-Kachel: nur den area-faehigen Refresh verwenden.

Die alte Finance-Runtime injiziert noch einen zweiten Revolut-Refresh ohne
?area=test|live. Im Testgelaende fragt dieser unnoetig den Live-WinWorker-Bestand
ab und kann bei grossen Datenmengen an die SQL-Server-Grenze von 2100 Parametern
laufen. Die eigentliche Revolut-Seite und der neue area-faehige Refresh sind
korrekt; daher wird hier nur der veraltete Doppel-Refresh aus der HTML-Seite
entfernt.
"""
from __future__ import annotations

import re


def install(ns):
    page = str(ns.get("MOBILE_PAGE") or "")
    if not page:
        return

    cleaned = re.sub(
        r'<script id="kristaIncomingRevolutV\d+">.*?</script>',
        '',
        page,
        flags=re.I | re.S,
    )
    if cleaned != page:
        ns["MOBILE_PAGE"] = cleaned
        print("✅ Revolut-Kachel: alter Live-Doppelrefresh entfernt · Area-Refresh bleibt")
