# coding: utf-8
"""Einmalige Altbestandsbereinigung fuer erwartete Einzuege.

Nur beim ersten echten Aufruf des Einzugsbereichs:
- vorhandene WinWorker-Einzuege mit erwartetem Einzug > 14 Tage in der Vergangenheit
  werden als historisch eingezogen markiert und aus der Liste entfernt;
- die uebrigen damals vorhandenen WinWorker-Einzuege bekommen genau einmal die
  Entscheidung "Eingezogen" / "Noch nicht".

Nach diesem Cutover gibt es fuer neue Einzuege keine manuellen Altbestandsbuttons
mehr. Ab dann beendet ausschliesslich der CAMT-Abgleich einen erwarteten Einzug.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from brain_finance_source import FinanceStore, norm_status


def _iso_day(value):
    raw = str(value or "").strip()[:10]
    try:
        return datetime.strptime(raw, "%Y-%m-%d").date()
    except Exception:
        return None


def install(ns):
    app = ns.get("app")
    page = str(ns.get("MOBILE_PAGE") or "")
    allowed = ns.get("MOBILE_ALLOWED_PATHS")
    if app is None or not page:
        return

    review_path = "/incoming/direct-debit/legacy-review"
    if isinstance(allowed, set):
        allowed.add(review_path)

    store = FinanceStore(ns)

    def ensure_schema():
        con = store.con()
        try:
            con.executescript("""
                CREATE TABLE IF NOT EXISTS brain_direct_debit_cutover_state(
                    id INTEGER PRIMARY KEY CHECK(id=1),
                    initialized_at TEXT NOT NULL,
                    cutoff_date TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS brain_direct_debit_cutover_items(
                    source TEXT NOT NULL,
                    source_id TEXT NOT NULL,
                    decision TEXT NOT NULL,
                    reviewed_at TEXT,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(source, source_id)
                );
            """)
            con.commit()
        finally:
            con.close()

    def cutover_state():
        ensure_schema()
        con = store.con()
        try:
            row = con.execute(
                "SELECT initialized_at,cutoff_date FROM brain_direct_debit_cutover_state WHERE id=1"
            ).fetchone()
            return dict(row) if row else None
        finally:
            con.close()

    def cutover_items():
        ensure_schema()
        con = store.con()
        try:
            rows = con.execute(
                "SELECT source,source_id,decision,reviewed_at,created_at FROM brain_direct_debit_cutover_items"
            ).fetchall()
            return {(str(r["source"]), str(r["source_id"])): dict(r) for r in rows}
        finally:
            con.close()

    def initialize_once(rows):
        state = cutover_state()
        if state:
            return state, cutover_items(), 0

        ww_rows = [x for x in (rows or []) if str(x.get("source") or "") == "WinWorker"]
        # Nicht auf einen leeren Stand festnageln. Beim ersten echten WW-Einzug wird
        # der Cutover dann sauber initialisiert.
        if not ww_rows:
            return None, {}, 0

        today = date.today()
        cutoff = today - timedelta(days=14)
        now = datetime.now().isoformat(timespec="seconds")
        records = []
        auto_paid = []

        for row in ww_rows:
            sid = str(row.get("id") or "").strip()
            if not sid:
                continue
            expected = _iso_day(
                row.get("expectedDebitDate") or row.get("dueDate") or row.get("invoiceDate")
            )
            if expected is not None and expected < cutoff:
                decision = "auto_paid_legacy"
                auto_paid.append(sid)
            else:
                decision = "pending_user"
            records.append(("WinWorker", sid, decision, None, now))

        # Erst die historisch sicheren Altfaelle aus dem OP nehmen.
        for sid in auto_paid:
            try:
                store.set_meta(
                    "WinWorker",
                    sid,
                    method="direct_debit",
                    status="paid",
                    note=f"Einzug Altbestand >14 Tage · einmaliger Cutover {today.isoformat()}",
                )
            except Exception as exc:
                print("⚠ Einzug-Altbestand konnte nicht automatisch abgeschlossen werden:", sid, exc)
                records = [
                    (src, rid, "pending_user" if rid == sid else dec, reviewed, created)
                    for src, rid, dec, reviewed, created in records
                ]

        con = store.con()
        try:
            for record in records:
                con.execute(
                    """INSERT OR IGNORE INTO brain_direct_debit_cutover_items
                       (source,source_id,decision,reviewed_at,created_at)
                       VALUES(?,?,?,?,?)""",
                    record,
                )
            con.execute(
                """INSERT OR IGNORE INTO brain_direct_debit_cutover_state
                   (id,initialized_at,cutoff_date) VALUES(1,?,?)""",
                (now, cutoff.isoformat()),
            )
            con.commit()
        finally:
            con.close()

        decisions = cutover_items()
        actual_auto = sum(1 for x in decisions.values() if x.get("decision") == "auto_paid_legacy")
        return cutover_state(), decisions, actual_auto

    def decorate_body(body):
        original_dd = list(body.get("directDebit") or [])
        dd_keys = {
            (str(x.get("source") or ""), str(x.get("id") or ""))
            for x in original_dd
        }

        state, decisions, auto_closed = initialize_once(original_dd)
        if state and not decisions:
            decisions = cutover_items()

        clean_dd = []
        pending_count = 0
        for row in original_dd:
            key = (str(row.get("source") or ""), str(row.get("id") or ""))
            decision = str((decisions.get(key) or {}).get("decision") or "")
            if decision in {"auto_paid_legacy", "confirmed_paid"}:
                continue
            item = dict(row)
            item["legacyReviewPending"] = decision == "pending_user"
            item["legacyReviewDecision"] = decision
            if item["legacyReviewPending"]:
                pending_count += 1
            clean_dd.append(item)

        # Einzug und Zahl-OP duerfen auch beim allerersten Erkennungslauf nicht
        # doppelt erscheinen. Die Einzugs-IDs werden sofort aus Zahlbar/Unklar entfernt.
        def without_debits(rows):
            return [
                x for x in (rows or [])
                if (str(x.get("source") or ""), str(x.get("id") or "")) not in dd_keys
            ]

        if "items" in body:
            body["items"] = without_debits(body.get("items"))
            body["count"] = len(body["items"])
            payable = [
                x for x in body["items"]
                if norm_status(x.get("paymentStatus")) != "sepa_submitted"
                and str(x.get("approvalStatus") or "") in {"approved", "reduced", "not_required"}
            ]
            body["total"] = round(sum(
                float(x.get("paymentAmount") if x.get("paymentAmount") is not None else x.get("amount") or 0)
                for x in payable
            ), 2)
        if "unclassified" in body:
            body["unclassified"] = without_debits(body.get("unclassified"))
            body["unclassifiedCount"] = len(body["unclassified"])

        totals = {}
        for row in clean_dd:
            cur = str(row.get("currency") or "EUR")
            totals[cur] = round(float(totals.get(cur, 0)) + float(row.get("amount") or 0), 2)
        body["directDebit"] = clean_dd
        body["directDebitCount"] = len(clean_dd)
        body["directDebitTotals"] = totals
        body["directDebitLegacyReviewPendingCount"] = pending_count
        body["directDebitLegacyAutoClosedCount"] = auto_closed
        body["directDebitLegacyCutoverAt"] = str((state or {}).get("initialized_at") or "")
        return body

    original_items = app.view_functions.get("brain_incoming_payment_open_items")
    if original_items and not getattr(original_items, "_krista_dd_cutover", False):
        from flask import jsonify

        def payment_open_items_cutover():
            response = app.make_response(original_items())
            try:
                if not response.is_json:
                    return response
                body = response.get_json(silent=True) or {}
                if not body.get("ok"):
                    return response
                return jsonify(decorate_body(body))
            except Exception as exc:
                print("⚠ Einzug-Cutover:", exc)
                return response

        payment_open_items_cutover.__name__ = "brain_incoming_payment_open_items_dd_cutover"
        payment_open_items_cutover._krista_dd_cutover = True
        app.view_functions["brain_incoming_payment_open_items"] = payment_open_items_cutover

    if "brain_direct_debit_legacy_review" not in app.view_functions:
        from flask import request, jsonify

        @app.post(review_path)
        def brain_direct_debit_legacy_review():
            try:
                body = request.get_json(silent=True) or {}
                source = str(body.get("source") or "")
                sid = str(body.get("id") or "")
                decision = str(body.get("decision") or "").lower()
                if source != "WinWorker" or not sid:
                    return jsonify(ok=False, error="Ungültiger Einzug."), 400
                if decision not in {"paid", "open"}:
                    return jsonify(ok=False, error="Bitte Eingezogen oder Noch nicht wählen."), 400

                ensure_schema()
                con = store.con()
                try:
                    row = con.execute(
                        """SELECT decision FROM brain_direct_debit_cutover_items
                           WHERE source=? AND source_id=?""",
                        (source, sid),
                    ).fetchone()
                finally:
                    con.close()
                if not row or str(row["decision"] or "") != "pending_user":
                    return jsonify(ok=False, error="Diese einmalige Altbestandsprüfung ist bereits erledigt."), 409

                now = datetime.now().isoformat(timespec="seconds")
                if decision == "paid":
                    store.set_meta(
                        source, sid, method="direct_debit", status="paid",
                        note="Einzug Altbestand · einmalig als eingezogen bestätigt",
                    )
                    saved_decision = "confirmed_paid"
                else:
                    store.set_meta(
                        source, sid, method="direct_debit", status="open",
                        note="Einzug Altbestand · noch nicht eingezogen · ab jetzt CAMT",
                    )
                    saved_decision = "keep_open"

                con = store.con()
                try:
                    con.execute(
                        """UPDATE brain_direct_debit_cutover_items
                           SET decision=?,reviewed_at=?
                           WHERE source=? AND source_id=? AND decision='pending_user'""",
                        (saved_decision, now, source, sid),
                    )
                    con.commit()
                finally:
                    con.close()
                return jsonify(ok=True, decision=saved_decision)
            except Exception as exc:
                return jsonify(ok=False, error=str(exc)), 500

    original_page = app.view_functions.get("brain_incoming_payments_page")
    if original_page and not getattr(original_page, "_krista_dd_cutover", False):
        from flask import Response

        def payments_page_cutover():
            response = app.make_response(original_page())
            html = response.get_data(as_text=True)

            helper = r'''
 const legacyReview=x=>x.legacyReviewPending?`<span class="dd-review"><button type="button" data-dd-legacy="paid" data-source="${esc(x.source)}" data-id="${esc(x.id)}">✓ Eingezogen</button><button type="button" data-dd-legacy="open" data-source="${esc(x.source)}" data-id="${esc(x.id)}">Noch nicht</button></span>`:status(x);
'''
            if "const legacyReview=" not in html and " function totals(rows){" in html:
                html = html.replace(" function totals(rows){", helper + " function totals(rows){", 1)
            html = html.replace("<div>${status(x)}</div>", "<div>${legacyReview(x)}</div>", 1)

            css = r'''
<style id="kristaDirectDebitCutoverCss">
.dd-review{display:flex;gap:6px;flex-wrap:wrap}.dd-review button{padding:6px 8px;border-radius:8px;font-size:11px;font-weight:850;background:#25303a;color:#fff;border:1px solid #526170}.dd-review button[data-dd-legacy="paid"]{background:#2d7047;border-color:#3d8d5e}.dd-review button:disabled{opacity:.55;cursor:wait}
</style>
'''
            if "kristaDirectDebitCutoverCss" not in html:
                html = html.replace("</head>", css + "</head>", 1)

            script = r'''
<script id="kristaDirectDebitCutoverV1">
(function(){
 document.addEventListener('click',async e=>{
   const button=e.target.closest('[data-dd-legacy]');if(!button)return;
   e.preventDefault();
   const group=button.closest('.dd-review');group?.querySelectorAll('button').forEach(b=>b.disabled=true);
   try{
     const r=await fetch('/incoming/direct-debit/legacy-review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:button.dataset.source,id:button.dataset.id,decision:button.dataset.ddLegacy})});
     const d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||'Einzug konnte nicht gespeichert werden');
     location.reload();
   }catch(err){group?.querySelectorAll('button').forEach(b=>b.disabled=false);alert(err.message||err)}
 });
})();
</script>
'''
            if "kristaDirectDebitCutoverV1" not in html:
                html = html.replace("</body>", script + "</body>", 1)
            return Response(html, mimetype="text/html")

        payments_page_cutover.__name__ = "brain_incoming_payments_page_dd_cutover"
        payments_page_cutover._krista_dd_cutover = True
        app.view_functions["brain_incoming_payments_page"] = payments_page_cutover

    print("✅ Einzug Altbestand: einmalig >14 Tage raus · Rest Eingezogen/Noch nicht · danach nur CAMT")
