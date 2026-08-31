# coding: utf-8
"""Kompatibilitäts-Loader für KRISTINE Finance V4 + Eingangsrechnungs-Bearbeitung.

Der Rechnungseingang bleibt auf dem bewährten gemeinsamen Capture-Stand, aber ohne
die späteren Standalone-/Scroll-/Stability-Experimente. Damit kommen das moderne
3-Spalten-Design, genau ein PDF-Viewer, Bearbeiten und der seitenweite Datei-Einzug
wieder zusammen. Der Tax-Observer läuft bereits in der stabilen V2-Variante.
"""
import os

os.environ.setdefault("KRISTINE_FINANCE_APPROVER_ID", "Alex0780")

import brain_finance_runtime as _finance_runtime
from brain_finance_source_v2 import FinanceStore as _FinanceStoreV2
_finance_runtime.FinanceStore = _FinanceStoreV2
_finance_install = _finance_runtime.install

from brain_capture_edit import install as _capture_edit_install
from brain_capture_edit_fast import install as _capture_edit_fast_install
from brain_currency_payment_v2 import install as _currency_payment_install
from brain_finance_test_bridge import install as _finance_test_bridge_install
from brain_revolut_task_guard import install as _revolut_task_guard_install
from brain_revolut_panel_fix import install as _revolut_panel_fix_install
from brain_finance_kassa import install as _kassa_install
from brain_test_promote import install as _test_promote_install
from brain_finance_direct_debit import install as _direct_debit_install
from brain_finance_direct_debit_cutover import install as _direct_debit_cutover_install
from brain_finance_reconciliation import install as _reconciliation_install
from brain_finance_reconciliation_bridge import install as _reconciliation_bridge_install
from brain_invoice_intake import install as _invoice_intake_install
from brain_capture_global_drop import install as _capture_global_drop_install
from brain_capture_learning import install as _capture_learning_install
from brain_capture_duplicate_guard import install as _capture_duplicate_guard_install
from brain_capture_learning_ui import install as _capture_learning_ui_install
from brain_capture_tax_ui import install as _capture_tax_ui_install
from brain_capture_accounts import install as _capture_accounts_install
from brain_home_nav import install as _home_nav_install
from brain_finance_op_tools import install as _op_tools_install
from brain_header_dedup import install as _header_dedup_install
from brain_finance_header import install as _finance_header_install
from brain_outgoing_invoices import install as _outgoing_invoices_install


def install(ns):
    _capture_edit_install(ns)
    _capture_edit_fast_install(ns)
    _finance_install(ns)
    _currency_payment_install(ns)
    _finance_test_bridge_install(ns)
    _revolut_task_guard_install(ns)
    _revolut_panel_fix_install(ns)
    _kassa_install(ns)
    _test_promote_install(ns)
    _direct_debit_install(ns)
    _direct_debit_cutover_install(ns)
    _reconciliation_install(ns)
    _reconciliation_bridge_install(ns)
    _invoice_intake_install(ns)

    # Bewährter Capture-Stack: Datei-Einzug + modernes 3-Spalten-Design + Lernen.
    _capture_global_drop_install(ns)
    _capture_learning_install(ns)
    _capture_duplicate_guard_install(ns)
    _capture_learning_ui_install(ns)
    _capture_tax_ui_install(ns)
    _capture_accounts_install(ns)

    # Bewusst NICHT mehr installieren:
    # brain_capture_standalone / stability-Frontend / scroll_fix / scroll_isolation.
    # Der tatsächliche Hänger war der selbst-auslösende Tax-MutationObserver (V1).

    _home_nav_install(ns)
    _op_tools_install(ns)
    _outgoing_invoices_install(ns)
    # Reihenfolge absichtlich so: after_request läuft rückwärts.
    _header_dedup_install(ns)
    _finance_header_install(ns)
