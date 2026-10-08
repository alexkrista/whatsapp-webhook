"""Keep Revolut receipt originals linked by source and transaction ID."""
import base64
import hashlib
import json
from io import BytesIO


def schema(con):
    con.execute("""CREATE TABLE IF NOT EXISTS brain_revolut_receipts(
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL,
        external_id TEXT NOT NULL, sha256 TEXT NOT NULL, name TEXT NOT NULL,
        mime_type TEXT NOT NULL, content BLOB NOT NULL,
        UNIQUE(source,external_id,sha256))""")


def cache_receipts(con, source, transactions):
    schema(con)
    saved = 0
    for tx in transactions:
        if not isinstance(tx, dict):
            continue
        external_id = str(tx.get("id") or tx.get("transactionId") or "").strip()
        if not external_id:
            continue  # Never guess a link from amount or merchant.
        attachments = tx.get("attachments") or []
        if isinstance(attachments, dict):
            attachments = [attachments]
        if not isinstance(attachments, list):
            continue
        for attachment in attachments:
            if not isinstance(attachment, dict):
                continue
            encoded = attachment.get("data") or attachment.get("contentBytes") or attachment.get("base64") or ""
            try:
                if isinstance(encoded, str) and encoded.lower().startswith("data:"):
                    encoded = encoded.split(",", 1)[1]
                if len(encoded) > 17 * 1024 * 1024:
                    continue
                raw = encoded if isinstance(encoded, bytes) else base64.b64decode(encoded, validate=True)
            except (ValueError, TypeError):
                continue
            if not raw or len(raw) > 12 * 1024 * 1024:
                continue
            mime = ("application/pdf" if raw.startswith(b"%PDF-") else
                    "image/jpeg" if raw.startswith(b"\xff\xd8\xff") else
                    "image/png" if raw.startswith(b"\x89PNG\r\n\x1a\n") else "")
            if not mime:
                continue
            name = str(attachment.get("name") or attachment.get("filename") or "Revolut-Beleg")[:180]
            cur = con.execute("""INSERT OR IGNORE INTO brain_revolut_receipts
                (source,external_id,sha256,name,mime_type,content) VALUES(?,?,?,?,?,?)""",
                (source, external_id, hashlib.sha256(raw).hexdigest(), name, mime, raw))
            saved += cur.rowcount
    return saved


def install(ns):
    app = ns.get("app")
    connection = ns.get("_capture_connection")
    if app is None or not callable(connection) or "brain_revolut_receipt_file" in app.view_functions:
        return
    from flask import request, jsonify, send_file

    def con():
        c = connection(ns["CAPTURE_DB"])
        schema(c)
        c.commit()
        return c

    c = con()
    c.close()
    allowed = ns.get("MOBILE_ALLOWED_PATHS")
    if isinstance(allowed, set):
        allowed.add("/incoming/revolut/receipt")

    @app.get("/incoming/revolut/receipt")
    def brain_revolut_receipt_file():
        receipt_id = request.args.get("id", type=int)
        c = con()
        try:
            row = c.execute("SELECT * FROM brain_revolut_receipts WHERE id=?", (receipt_id,)).fetchone()
            if row is None:
                return jsonify(ok=False, error="Revolut-Beleg nicht gefunden."), 404
            response = send_file(BytesIO(row["content"]), mimetype=row["mime_type"], download_name=row["name"], as_attachment=False)
            response.headers["Cache-Control"] = "private, no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
            return response
        finally:
            c.close()

    original = app.view_functions.get("brain_reconciliation_statements")
    if original:
        def statements_with_receipts():
            response = app.make_response(original())
            body = response.get_json(silent=True) or {}
            if response.status_code >= 400 or not body.get("ok"):
                return response
            c = con()
            try:
                receipts = {}
                for row in c.execute("""SELECT m.id AS movement_id,r.id,r.name
                    FROM brain_statement_movements m JOIN brain_revolut_receipts r
                    ON r.source=m.source AND r.external_id=m.external_id ORDER BY r.id"""):
                    receipts.setdefault(row["movement_id"], []).append({
                        "id":row["id"], "name":row["name"],
                        "url":"/incoming/revolut/receipt?id=" + str(row["id"])})
                for statement in body.get("statements") or []:
                    for movement in statement.get("movements") or []:
                        movement["receipts"] = receipts.get(movement["id"], [])
            finally:
                c.close()
            response.set_data(json.dumps(body, ensure_ascii=False))
            response.mimetype = "application/json"
            return response
        app.view_functions["brain_reconciliation_statements"] = statements_with_receipts
