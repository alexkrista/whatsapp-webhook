"""Invoice selection to confirmed bank submission, without downloading XML."""
import hashlib
import json
import secrets
import sqlite3
import time
from contextlib import closing
from datetime import date
from decimal import Decimal
from xml.etree import ElementTree as ET

from flask import jsonify, request

from brain_konfipay import ConnectionError
from brain_konfipay_expected import expected_balances


FIELDS = [
    "source", "id", "supplier", "invoiceNumber", "accountHolder", "iban",
    "bic", "currency", "paymentAmount", "paymentId", "remittanceText",
    "approvalStatus", "approvalReason",
]


def fingerprint(items):
    relevant = [{key: item.get(key) for key in FIELDS} for item in items]
    return hashlib.sha256(json.dumps(relevant, sort_keys=True, default=str).encode()).hexdigest()


class DirectPay:
    def __init__(self, ns, select, xml, store):
        self.ns = ns
        self.select = select
        self.xml = xml
        self.store = store
        self.drafts = {}

    def services(self):
        service = self.ns.get("brain_bank_payments")
        if not service:
            raise ConnectionError("Die Bankverbindung ist noch nicht bereit.")
        return service

    @staticmethod
    def db(payments):
        db = payments.db()
        db.execute(
            "CREATE TABLE IF NOT EXISTS creditor_claims "
            "(source TEXT,invoice TEXT,batch TEXT,state TEXT,PRIMARY KEY(source,invoice))"
        )
        return db

    def checked(self, refs):
        if not isinstance(refs, list) or not 1 <= len(refs) <= 100:
            raise ConnectionError("Bitte 1 bis 100 Rechnungen auswählen.")
        if any(not isinstance(item, dict) for item in refs):
            raise ConnectionError("Ungültige Auswahl.")
        keys = [(str(item.get("source")), str(item.get("id"))) for item in refs]
        if len(set(keys)) != len(keys):
            raise ConnectionError("Eine Rechnung wurde doppelt ausgewählt.")
        items, _total = self.select(refs)
        return items

    def prepare(self, refs):
        service = self.services()
        payments = service["payments"]
        client = service["client"]
        with payments.lock:
            items = self.checked(refs)
            with closing(self.db(payments)) as db:
                for item in items:
                    prior = db.execute(
                        "SELECT 1 FROM creditor_claims WHERE source=? AND invoice=?",
                        (item["source"], item["id"]),
                    ).fetchone()
                    if prior and item.get("paymentStatus") == "sepa_submitted":
                        raise ConnectionError(
                            "Eine ausgewählte Rechnung wurde bereits übergeben. Bitte den Zahlungsstatus prüfen."
                        )

            payload = self.xml(items)
            root = ET.fromstring(payload["xml"])
            prefix = secrets.token_hex(6).upper()
            serial = 0
            for node in root.iter():
                if node.tag.rsplit("}", 1)[-1] in {"MsgId", "PmtInfId"}:
                    serial += 1
                    node.text = prefix + str(serial).zfill(4)
            xml = ET.tostring(root, encoding="unicode")
            preview = payments.prepare([{"name": payload["filename"], "xml": xml}])
            token = preview["draft"]

            bank = expected_balances(client)
            debtor = preview["files"][0]["items"][0]["debtorIban"]
            account = next(
                (
                    row for row in bank["accounts"]
                    if row["iban"].replace(" ", "") == debtor.replace(" ", "")
                ),
                None,
            )
            before = None
            after = None
            note = ""
            if account and not account.get("error") and account.get("expected") is not None:
                before = account["expected"]
                after = format(Decimal(before) - Decimal(preview["total"]), ".2f")
            else:
                note = "Erwarteter Kontostand derzeit nicht verfügbar."

            # Older balance providers lack the own-payment reconciliation.
            if not (account or {}).get("ownTransfersChecked"):
                with closing(payments.db()) as db:
                    earlier = db.execute(
                        "SELECT 1 FROM transfers WHERE substr(created,1,10)>=? "
                        "AND COALESCE(status,'') NOT IN "
                        "('FIN_REJECTED','KON_REJECTED','FIN_VEU_CANCELED') LIMIT 1",
                        ((account or {}).get("date") or date.today().isoformat(),),
                    ).fetchone()
                if earlier:
                    before = None
                    after = None
                    note = (
                        "Kontostand nach Zahlung noch nicht sicher berechenbar: Frühere eigene "
                        "Übergaben müssen mit den Bankumsätzen abgeglichen werden."
                    )

            self.drafts = {
                key: value for key, value in self.drafts.items()
                if value["expires"] > time.time()
            }
            self.drafts[token] = {
                "refs": refs,
                "items": items,
                "hash": fingerprint(items),
                "xml": xml,
                "name": payload["filename"],
                "expires": time.time() + 900,
                "day": date.today().isoformat(),
                "total": preview["total"],
            }
            details = []
            for item, transaction in zip(items, preview["files"][0]["items"]):
                details.append(
                    {
                        **transaction,
                        "invoiceNumber": item.get("invoiceNumber") or item.get("docId") or "",
                    }
                )
            return {
                "draft": token,
                "count": preview["count"],
                "total": preview["total"],
                "items": details,
                "account": debtor,
                "before": before,
                "after": after,
                "balanceNote": note,
                "bankFetchedAt": bank["fetchedAt"],
            }

    def submit(self, token, confirmed):
        if confirmed is not True:
            raise ConnectionError("Bitte die Zahlung ausdrücklich bestätigen.")
        service = self.services()
        payments = service["payments"]
        with payments.lock:
            draft = self.drafts.pop(str(token), None)
            if (
                not draft
                or draft["expires"] < time.time()
                or draft["day"] != date.today().isoformat()
            ):
                raise ConnectionError("Vorschau abgelaufen. Bitte erneut auf Bezahlen klicken.")
            live = self.checked(draft["refs"])
            if fingerprint(live) != draft["hash"]:
                raise ConnectionError("Eine Rechnung oder Freigabe wurde geändert. Bitte neu prüfen.")
            if token not in payments.drafts or payments.drafts[token]["expires"] < time.time():
                raise ConnectionError("Bankvorschau abgelaufen. Bitte neu prüfen.")

            with closing(self.db(payments)) as db:
                try:
                    db.execute("BEGIN IMMEDIATE")
                    for item in live:
                        db.execute(
                            "INSERT INTO creditor_claims VALUES (?,?,?,?) "
                            "ON CONFLICT(source,invoice) DO UPDATE SET batch=excluded.batch,state=excluded.state",
                            (item["source"], item["id"], token, "submitting"),
                        )
                    db.commit()
                except sqlite3.IntegrityError:
                    raise ConnectionError(
                        "Doppelte Übergabe blockiert. Bitte den Status prüfen."
                    ) from None

            try:
                result = payments.submit(token, True)
            except Exception:
                raise ConnectionError(
                    "Ergebnis unklar. Nicht erneut überweisen; bitte im Bank-Zahlungsarchiv prüfen."
                ) from None

            entry = (result.get("results") or [{}])[0]
            warnings = []
            # Die Bankuebergabe ist bereits erfolgt. Ihr Status darf deshalb
            # nicht davon abhaengen, ob das zusaetzliche XML-Archiv geschrieben
            # werden kann.
            if entry.get("state") != "rejected":
                for item in live:
                    try:
                        self.store.set_status_override(
                            item["source"], item["id"], "sepa_submitted"
                        )
                    except Exception:
                        warnings.append("Kreditorenstatus")
                    try:
                        self.store.set_meta(
                            item["source"],
                            item["id"],
                            method="transfer",
                            status="sepa_submitted",
                            note=item["remittanceText"],
                        )
                    except Exception:
                        warnings.append("Kreditorenstatus")
            try:
                self.store.save_sepa_batch(draft["name"], draft["xml"], live, draft["total"])
            except Exception:
                warnings.append("XML-Sicherung")

            try:
                with closing(self.db(payments)) as db:
                    db.execute(
                        "UPDATE creditor_claims SET state=? WHERE batch=?",
                        (entry.get("state", "unknown"), token),
                    )
                    db.commit()
            except Exception:
                warnings.append("Übergabeprotokoll")
            warning = None
            if warnings:
                warning = (
                    "An konfipay übergeben, aber intern noch nicht vollständig aktualisiert "
                    f"({', '.join(dict.fromkeys(warnings))}). Nicht erneut senden."
                )
            return {**result, "warning": warning}

    def cancel(self, token):
        payments = self.services()["payments"]
        with payments.lock:
            if self.drafts.pop(str(token), None):
                payments.drafts.pop(str(token), None)
        return {}


def install(ns, select, xml, store):
    app = ns["app"]
    direct = DirectPay(ns, select, xml, store)
    paths = [
        "/incoming/pay-direct/preview",
        "/incoming/pay-direct/submit",
        "/incoming/pay-direct/cancel",
    ]
    ns["MOBILE_ALLOWED_PATHS"].update(paths)

    def invoke(function):
        try:
            if not direct.services()["write_allowed"]():
                return jsonify({"ok": False, "error": "Bitte Seite neu laden."}), 403
            if not request.content_length or request.content_length > 50000:
                raise ConnectionError("Ungültige Anfrage.")
            body = request.get_json(silent=True)
            if not isinstance(body, dict):
                raise ConnectionError("Ungültige Anfrage.")
            return jsonify({"ok": True, **function(body)})
        except (ConnectionError, ValueError) as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        except Exception:
            return jsonify(
                {
                    "ok": False,
                    "error": "Vorgang nicht abgeschlossen. Bitte Zahlungsstatus prüfen.",
                }
            ), 500

    app.add_url_rule(
        paths[0],
        "brain_direct_pay_preview",
        lambda: invoke(lambda body: direct.prepare(body.get("items"))),
        methods=["POST"],
    )
    app.add_url_rule(
        paths[1],
        "brain_direct_pay_submit",
        lambda: invoke(lambda body: direct.submit(body.get("draft"), body.get("confirmed"))),
        methods=["POST"],
    )
    app.add_url_rule(
        paths[2],
        "brain_direct_pay_cancel",
        lambda: invoke(lambda body: direct.cancel(body.get("draft"))),
        methods=["POST"],
    )
