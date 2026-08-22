# coding: utf-8
"""Kompatibilitäts-Loader für KRISTINE Finance V4 + Eingangsrechnungs-Bearbeitung.

Die frühere OP-Erfassungsansicht wird durch den getrennten Bezahl-OP und den
Revolut-Bereich ersetzt. Zusätzlich werden erfasste, noch ungeprüfte Rechnungen
wieder bearbeitbar gemacht und Zahlungsweg/Fremdwährung direkt bei der Erfassung
geführt.
"""
from brain_finance_runtime import install as _finance_install
from brain_capture_edit import install as _capture_edit_install
from brain_currency_payment_v2 import install as _currency_payment_install


def install(ns):
    _capture_edit_install(ns)
    _finance_install(ns)
    _currency_payment_install(ns)
