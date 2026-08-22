# coding: utf-8
"""Kompatibilitäts-Loader für KRISTINE Finance V4 + Eingangsrechnungs-Bearbeitung.

Die frühere OP-Erfassungsansicht wird durch den getrennten Bezahl-OP und den
Revolut-Bereich ersetzt. Zusätzlich werden erfasste, noch ungeprüfte Rechnungen
wieder bearbeitbar gemacht und Zahlungsweg/Fremdwährung direkt bei der Erfassung
geführt. Der TEST-/Revolut-Bridge erzeugt auch im Testgelände sofort die
Freigabe-Aufgabe und hält die Revolut-Ansicht in derselben Area.
"""
import os

# Fester Standard-Freigeber für Rechnungen. Kann bei Bedarf per Environment
# bewusst überschrieben werden, aber ohne Konfiguration geht die Aufgabe an Alex0780.
os.environ.setdefault("KRISTINE_FINANCE_APPROVER_ID", "Alex0780")

from brain_finance_runtime import install as _finance_install
from brain_capture_edit import install as _capture_edit_install
from brain_currency_payment_v2 import install as _currency_payment_install
from brain_finance_test_bridge import install as _finance_test_bridge_install
from brain_finance_direct_debit import install as _direct_debit_install
from brain_finance_reconciliation import install as _reconciliation_install
from brain_finance_reconciliation_bridge import install as _reconciliation_bridge_install
from brain_invoice_intake import install as _invoice_intake_install
from brain_home_nav import install as _home_nav_install


def install(ns):
    _capture_edit_install(ns)
    _finance_install(ns)
    _currency_payment_install(ns)
    _finance_test_bridge_install(ns)
    _direct_debit_install(ns)
    _reconciliation_install(ns)
    _reconciliation_bridge_install(ns)
    _invoice_intake_install(ns)
    _home_nav_install(ns)
