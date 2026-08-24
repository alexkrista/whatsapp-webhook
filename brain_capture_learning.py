# coding: utf-8
"""KRISTINE Eingangsrechnung: lernbare Lieferanten-Layouts und Dublettenprüfung."""
from __future__ import annotations

import hashlib
import re
from datetime import datetime
from pathlib import Path

from brain_line2 import _preview_path

FIELD_KEYS = {
    "invoiceNumber", "invoiceDate", "dueDate", "skontoPercent", "skontoDueDate",
    "currency", "customerNumber", "paymentTerms", "invoiceIban",
    "netAmount", "vatAmount", "grossAmount",
}


def _invoice_norm(value):
    return re.sub(r"[^A-Za-z0-9]+", "", str(value or "")).upper().strip()


def _norm_words(value):
    return {w for w in re.findall(r"[A-Za-zÄÖÜäöüß]{3,}", str(value or "").lower())}


def _date_iso(value):
    raw = str(value or "").strip()
    formats = (
        ("%Y-%m-%d", r"\b(\d{4}-\d{1,2}-\d{1,2})\b"),
        ("%d.%m.%Y", r"\b(\d{1,2}\.\d{1,2}\.\d{4})\b"),
        ("%d.%m.%y", r"\b(\d{1,2}\.\d{1,2}\.\d{2})\b"),
        ("%d/%m/%Y", r"\b(\d{1,2}/\d{1,2}/\d{4})\b"),
    )
    for fmt, pattern in formats:
        m = re.search(pattern, raw)
        if not m:
            continue
        try:
            return datetime.strptime(m.group(1), fmt).date().isoformat()
        except Exception:
            pass
    return ""


def _number(value):
    raw = str(value or "").strip().replace("\xa0", " ")
    hits = re.findall(r"[-+]?\d[\d\s.'’]*[,.]\d{1,2}|[-+]?\d+", raw)
    if not hits:
        return None
    token = hits[-1].replace(" ", "").replace("'", "").replace("’", "")
    if "," in token and "." in token:
        if token.rfind(",") > token.rfind("."):
            token = token.replace(".", "").replace(",", ".")
        else:
            token = token.replace(",", "")
    elif "," in token:
        token = token.replace(".", "").replace(",", ".")
    try:
        return float(token)
    except Exception:
        return None


def _parse_value(field, text):
    text = " ".join(str(text or "").split()).strip()
    if not text:
        return ""
    if field in {"invoiceDate", "dueDate", "skontoDueDate"}:
        return _date_iso(text)
    if field in {"netAmount", "vatAmount", "grossAmount", "skontoPercent"}:
        n = _number(text)
        return "" if n is None else round(n, 4)
    if field == "currency":
        upper = text.upper()
        for code in ("EUR", "CHF", "USD", "GBP", "CAD", "AUD", "JPY", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF"):
            if re.search(rf"(?<![A-Z]){code}(?![A-Z])", upper):
                return code
        if "€" in text:
            return "EUR"
        if "$" in text:
            return "USD"
        if "£" in text:
            return "GBP"
        return text[:3].upper()
    if field == "invoiceIban":
        m = re.search(r"\b[A-Z]{2}\s*\d{2}(?:[\sA-Z0-9]){10,32}\b", text.upper())
        return re.sub(r"\s+", "", m.group(0) if m else text.upper())
    if field == "invoiceNumber":
        return re.sub(
            r"(?i)\b(rechnung(?:s)?(?:nummer|nr\.?)?|beleg(?:nummer|nr\.?)?|invoice(?:\s*no\.?)?)\b[:\s-]*",
            "", text
        ).strip()[:120]
    if field == "customerNumber":
        return re.sub(
            r"(?i)\b(kunden(?:nummer|nr\.?)?|kundennr\.?|customer\s*no\.?)\b[:\s-]*",
            "", text
        ).strip()[:120]
    return text[:500]


def _extract_words(path, page_no, ns):
    import pymupdf
    with pymupdf.open(path) as doc:
        if page_no < 1 or page_no > doc.page_count:
            raise ValueError("PDF-Seite existiert nicht.")
        page = doc[page_no - 1]
        rect = page.rect
        words = page.get_text("words") or []
        meaningful = "".join(str(w[4] or "") for w in words if len(w) > 4).strip()
        if len(meaningful) < 20:
            try:
                lang = str(ns.get("CAPTURE_OCR_LANG") or "deu+eng")
                dpi = int(ns.get("CAPTURE_OCR_DPI") or 190)
                textpage = page.get_textpage_ocr(language=lang, dpi=dpi, full=True)
                words = page.get_text("words", textpage=textpage) or []
            except Exception:
                pass
        return float(rect.width), float(rect.height), words


def _texts_for_box(words, width, height, box):
    x0 = min(float(box["x0"]), float(box["x1"])) * width
    x1 = max(float(box["x0"]), float(box["x1"])) * width
    y0 = min(float(box["y0"]), float(box["y1"])) * height
    y1 = max(float(box["y0"]), float(box["y1"])) * height
    selected, nearby = [], []
    ex = max(width * .045, (x1 - x0) * .25)
    ey = max(height * .025, (y1 - y0) * .60)
    ax0, ay0, ax1, ay1 = max(0, x0 - ex), max(0, y0 - ey), min(width, x1 + ex), min(height, y1 + ey)
    for word in words:
        if len(word) < 5:
            continue
        cx = (float(word[0]) + float(word[2])) / 2
        cy = (float(word[1]) + float(word[3])) / 2
        txt = str(word[4] or "").strip()
        if not txt:
            continue
        if x0 <= cx <= x1 and y0 <= cy <= y1:
            selected.append((float(word[1]), float(word[0]), txt))
        elif ax0 <= cx <= ax1 and ay0 <= cy <= ay1:
            nearby.append((float(word[1]), float(word[0]), txt))
    selected.sort()
    nearby.sort()
    return " ".join(x[2] for x in selected), " ".join(x[2] for x in nearby)


def _layout_score(saved_anchor, current_anchor):
    a, b = _norm_words(saved_anchor), _norm_words(current_anchor)
    if not a:
        return 1.0
    if not b:
        return 0.0
    return len(a & b) / max(1, len(a))


def install(ns):
    app = ns.get("app")
    area_connection = ns.get("_capture_area_connection")
    capture_area = ns.get("_capture_area")
    sql_connection = ns.get("sql_connection")
    pdf_lookup = ns.get("_pdf_paths_by_docids")
    analyze_pdf = ns.get("_capture_analyze_pdf")
    allowed = ns.get("MOBILE_ALLOWED_PATHS")
    if app is None or not callable(area_connection) or not callable(capture_area):
        return

    paths = (
        "/incoming/capture/fences", "/incoming/capture/fence",
        "/incoming/capture/fences/apply", "/incoming/capture/duplicate-check",
        "/incoming/capture/duplicate-replace",
    )
    if isinstance(allowed, set):
        allowed.update(paths)

    def ensure_schema(con):
        con.executescript("""
            CREATE TABLE IF NOT EXISTS incoming_supplier_fences(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                supplier_address_id TEXT NOT NULL,
                field_key TEXT NOT NULL,
                page_no INTEGER NOT NULL DEFAULT 1,
                x0 REAL NOT NULL, y0 REAL NOT NULL, x1 REAL NOT NULL, y1 REAL NOT NULL,
                sample_text TEXT, anchor_text TEXT, created_by TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                UNIQUE(supplier_address_id, field_key)
            );
            CREATE INDEX IF NOT EXISTS idx_supplier_fences_supplier
              ON incoming_supplier_fences(supplier_address_id, field_key);
        """)
        con.commit()

    for area_name in ("live", "test"):
        try:
            con = area_connection(area_name)
            try:
                ensure_schema(con)
            finally:
                con.close()
        except Exception as exc:
            print("⚠ Fence-Schema", area_name, exc)

    def fence_rows(area, address_id):
        con = area_connection(area)
        try:
            ensure_schema(con)
            return [dict(r) for r in con.execute(
                "SELECT * FROM incoming_supplier_fences WHERE supplier_address_id=? ORDER BY field_key",
                (str(address_id),)
            ).fetchall()]
        finally:
            con.close()

    def local_candidates(address_id, invoice_number, invoice_date, gross, file_hash):
        con = area_connection("live")
        try:
            rows = con.execute("""
                SELECT id,doc_id,supplier_name,supplier_invoice_number,invoice_date,gross_amount,
                       pdf_path,workflow_status,payment_state,file_sha256
                FROM incoming_invoices
                WHERE supplier_address_id=?
                ORDER BY invoice_date DESC,id DESC LIMIT 120
            """, (str(address_id),)).fetchall()
            out = []
            inv_norm = _invoice_norm(invoice_number)
            for row in rows:
                d = dict(row)
                reasons, hard = [], False
                if file_hash and str(d.get("file_sha256") or "") == file_hash:
                    reasons.append("identische Datei")
                    hard = True
                if inv_norm and _invoice_norm(d.get("supplier_invoice_number")) == inv_norm:
                    reasons.append("gleiche Rechnungsnummer")
                    hard = True
                amount_same = gross is not None and abs(float(d.get("gross_amount") or 0) - gross) <= 0.05
                day_diff = None
                try:
                    if invoice_date and d.get("invoice_date"):
                        a = datetime.strptime(str(invoice_date)[:10], "%Y-%m-%d").date()
                        b = datetime.strptime(str(d.get("invoice_date"))[:10], "%Y-%m-%d").date()
                        day_diff = abs((a - b).days)
                except Exception:
                    pass
                if not hard and amount_same and (day_diff is None or day_diff <= 45):
                    reasons.append("gleicher Betrag" + (f" · Datum ±{day_diff} Tage" if day_diff is not None else ""))
                if reasons:
                    out.append({
                        "source": "KRISTINE", "id": int(d["id"]), "docId": str(d.get("doc_id") or ""),
                        "supplier": str(d.get("supplier_name") or ""),
                        "invoiceNumber": str(d.get("supplier_invoice_number") or ""),
                        "invoiceDate": str(d.get("invoice_date") or ""),
                        "amount": float(d.get("gross_amount") or 0), "currency": "EUR",
                        "path": str(d.get("pdf_path") or ""), "hard": hard, "reasons": reasons,
                        "replaceAllowed": str(d.get("workflow_status") or "").lower() != "geprueft"
                            and str(d.get("payment_state") or "").lower() not in {"paid", "bezahlt", "closed", "geschlossen"},
                    })
            return out
        finally:
            con.close()

    def ww_candidates(address_id, invoice_number, invoice_date, gross):
        if not callable(sql_connection) or not str(address_id or "").isdigit():
            return []
        address_num = int(address_id)
        inv_norm = _invoice_norm(invoice_number)
        con = sql_connection("WinWorker_Projekte_Standard")
        try:
            rows = con.cursor().execute("""
                SELECT TOP 120 e.cID,e.sBelegnummer,e.dzBelegdatum,e.dblBruttoBetrag,
                       dm.sDocID,k.sFirma,k.sName,k.sVorname
                FROM dbo.Eingangsbelege e
                LEFT JOIN dbo.DokumentenManagement dm ON dm.gID=e.gDMID
                LEFT JOIN WinWorker_Adressen_Standard.dbo.Kunden k ON k.StammIndex=e.lVonAdrIndex
                WHERE e.lVonAdrIndex=?
                ORDER BY e.dzBelegdatum DESC,e.cID DESC
            """, address_num).fetchall()
        finally:
            con.close()
        out, docs = [], []
        for row in rows:
            number = str(row.sBelegnummer or "").strip()
            reasons, hard = [], False
            if inv_norm and _invoice_norm(number) == inv_norm:
                reasons.append("gleiche Rechnungsnummer")
                hard = True
            amount = float(row.dblBruttoBetrag or 0)
            amount_same = gross is not None and abs(amount - gross) <= 0.05
            try:
                date_text = row.dzBelegdatum.strftime("%Y-%m-%d") if row.dzBelegdatum else ""
            except Exception:
                date_text = str(row.dzBelegdatum or "")[:10]
            day_diff = None
            try:
                if invoice_date and date_text:
                    a = datetime.strptime(str(invoice_date)[:10], "%Y-%m-%d").date()
                    b = datetime.strptime(date_text[:10], "%Y-%m-%d").date()
                    day_diff = abs((a - b).days)
            except Exception:
                pass
            if not hard and amount_same and (day_diff is None or day_diff <= 45):
                reasons.append("gleicher Betrag" + (f" · Datum ±{day_diff} Tage" if day_diff is not None else ""))
            if not reasons:
                continue
            company = str(row.sFirma or "").strip()
            person = " ".join(x for x in [str(row.sVorname or "").strip(), str(row.sName or "").strip()] if x)
            doc_id = str(row.sDocID or "").strip()
            if doc_id:
                docs.append(doc_id)
            out.append({
                "source": "WinWorker", "id": f"ww:{int(row.cID)}", "docId": doc_id,
                "supplier": company or person or f"WW {address_num}", "invoiceNumber": number,
                "invoiceDate": date_text, "amount": amount, "currency": "EUR", "path": "",
                "hard": hard, "reasons": reasons, "replaceAllowed": False,
            })
        if callable(pdf_lookup) and docs:
            try:
                found = pdf_lookup(docs, include_text=False) or {}
                for item in out:
                    hit = found.get(item["docId"], {}) if item["docId"] else {}
                    item["path"] = str(hit.get("pdfPath") or hit.get("originalPath") or "")
            except Exception:
                pass
        return out

    if "brain_capture_fences" in app.view_functions:
        return

    from flask import request, jsonify

    @app.get("/incoming/capture/fences")
    def brain_capture_fences():
        try:
            area = capture_area(request.args.get("area") or "live")
            address_id = str(request.args.get("addressId") or "").strip()
            if not address_id:
                raise ValueError("Lieferant fehlt.")
            rows = fence_rows(area, address_id)
            return jsonify(ok=True, area=area, count=len(rows), items=rows)
        except ValueError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        except Exception as exc:
            return jsonify(ok=False, error=str(exc)), 500

    @app.post("/incoming/capture/fence")
    def brain_capture_fence_save():
        try:
            body = request.get_json(silent=True) or {}
            area = capture_area(body.get("area") or "live")
            address_id = str(body.get("addressId") or "").strip()
            field = str(body.get("fieldKey") or "").strip()
            if not address_id or field not in FIELD_KEYS:
                raise ValueError("Lieferant/Feld fehlt.")
            token = str(body.get("previewToken") or "")
            page_no = max(1, int(body.get("page") or 1))
            box = {k: max(0.0, min(1.0, float(body.get(k)))) for k in ("x0", "y0", "x1", "y1")}
            if abs(box["x1"] - box["x0"]) < .005 or abs(box["y1"] - box["y0"]) < .003:
                raise ValueError("Markierung ist zu klein.")
            width, height, words = _extract_words(_preview_path(token), page_no, ns)
            sample, anchor = _texts_for_box(words, width, height, box)
            value = _parse_value(field, sample)
            now = datetime.now().isoformat(timespec="seconds")
            con = area_connection(area)
            try:
                ensure_schema(con)
                con.execute("""
                    INSERT INTO incoming_supplier_fences
                    (supplier_address_id,field_key,page_no,x0,y0,x1,y1,sample_text,anchor_text,created_by,created_at,updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(supplier_address_id,field_key) DO UPDATE SET
                      page_no=excluded.page_no,x0=excluded.x0,y0=excluded.y0,x1=excluded.x1,y1=excluded.y1,
                      sample_text=excluded.sample_text,anchor_text=excluded.anchor_text,
                      created_by=excluded.created_by,updated_at=excluded.updated_at
                """, (
                    address_id, field, page_no, box["x0"], box["y0"], box["x1"], box["y1"],
                    sample[:500], anchor[:500], str(body.get("createdBy") or "Dunja")[:100], now, now
                ))
                con.commit()
            finally:
                con.close()
            return jsonify(ok=True, fieldKey=field, sampleText=sample, value=value)
        except ValueError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        except Exception as exc:
            return jsonify(ok=False, error=str(exc)), 500

    @app.delete("/incoming/capture/fence")
    def brain_capture_fence_delete():
        try:
            area = capture_area(request.args.get("area") or "live")
            address_id = str(request.args.get("addressId") or "").strip()
            field = str(request.args.get("fieldKey") or "").strip()
            if not address_id:
                raise ValueError("Lieferant fehlt.")
            con = area_connection(area)
            try:
                ensure_schema(con)
                if field:
                    con.execute("DELETE FROM incoming_supplier_fences WHERE supplier_address_id=? AND field_key=?", (address_id, field))
                else:
                    con.execute("DELETE FROM incoming_supplier_fences WHERE supplier_address_id=?", (address_id,))
                con.commit()
            finally:
                con.close()
            return jsonify(ok=True)
        except ValueError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        except Exception as exc:
            return jsonify(ok=False, error=str(exc)), 500

    @app.post("/incoming/capture/fences/apply")
    def brain_capture_fences_apply():
        try:
            body = request.get_json(silent=True) or {}
            area = capture_area(body.get("area") or "live")
            address_id = str(body.get("addressId") or "").strip()
            token = str(body.get("previewToken") or "")
            if not address_id or not token:
                raise ValueError("Lieferant oder PDF fehlt.")
            rows = fence_rows(area, address_id)
            by_page, items, scores = {}, [], []
            path = _preview_path(token)
            for row in rows:
                page_no = int(row.get("page_no") or 1)
                if page_no not in by_page:
                    by_page[page_no] = _extract_words(path, page_no, ns)
                width, height, words = by_page[page_no]
                box = {k: float(row.get(k) or 0) for k in ("x0", "y0", "x1", "y1")}
                text, anchor = _texts_for_box(words, width, height, box)
                score = _layout_score(row.get("anchor_text"), anchor)
                scores.append(score)
                items.append({
                    "fieldKey": row.get("field_key"), "page": page_no, "text": text,
                    "value": _parse_value(str(row.get("field_key")), text),
                    "layoutScore": round(score, 3), "box": box,
                })
            layout_score = round(sum(scores) / len(scores), 3) if scores else 1.0
            warning = ""
            if rows and layout_score < .38:
                warning = "Gespeicherte Lieferanten-Vorlage passt vermutlich nicht mehr zum aktuellen Rechnungsdesign."
            return jsonify(ok=True, count=len(rows), layoutScore=layout_score, warning=warning, items=items)
        except ValueError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        except Exception as exc:
            return jsonify(ok=False, error=str(exc)), 500

    @app.post("/incoming/capture/duplicate-check")
    def brain_capture_duplicate_check():
        try:
            body = request.get_json(silent=True) or {}
            area = capture_area(body.get("area") or "live")
            supplier = body.get("supplier") or {}
            address_id = str(supplier.get("addressId") or body.get("addressId") or "").strip()
            if not address_id:
                return jsonify(ok=True, area=area, count=0, hard=False, items=[])
            invoice_number = str(body.get("invoiceNumber") or "").strip()
            invoice_date = str(body.get("invoiceDate") or "").strip()
            gross = _number(body.get("grossAmount"))
            file_hash = str(body.get("fileSha256") or "").strip().lower()
            items = local_candidates(address_id, invoice_number, invoice_date, gross, file_hash)
            items += ww_candidates(address_id, invoice_number, invoice_date, gross)
            seen, unique = set(), []
            for item in items:
                doc_key = str(item.get("docId") or "")
                key = ("doc", doc_key) if doc_key else (str(item.get("source")), str(item.get("id")))
                if key in seen:
                    continue
                seen.add(key)
                unique.append(item)
            unique.sort(key=lambda x: (0 if x.get("hard") else 1, str(x.get("invoiceDate") or "")))
            return jsonify(ok=True, area=area, count=len(unique), hard=any(bool(x.get("hard")) for x in unique), items=unique[:8])
        except Exception as exc:
            return jsonify(ok=False, error=str(exc)), 500

    @app.post("/incoming/capture/duplicate-replace")
    def brain_capture_duplicate_replace():
        try:
            source = str(request.form.get("source") or "")
            if source != "KRISTINE":
                raise ValueError("WinWorker-Belege sind read-only und können hier nicht ersetzt werden.")
            invoice_id = int(request.form.get("id") or 0)
            upload = request.files.get("file")
            if not upload or not str(upload.filename or "").lower().endswith(".pdf"):
                raise ValueError("PDF fehlt.")
            raw = upload.read()
            if not raw:
                raise ValueError("PDF ist leer.")
            if not callable(analyze_pdf):
                raise RuntimeError("PDF-Analyse ist nicht verfügbar.")
            con = area_connection("live")
            try:
                row = con.execute("SELECT * FROM incoming_invoices WHERE id=?", (invoice_id,)).fetchone()
                if not row:
                    raise ValueError("Vorhandene Rechnung wurde nicht gefunden.")
                if str(row["workflow_status"] or "").lower() == "geprueft":
                    raise ValueError("Geprüfte Rechnung darf nicht ersetzt werden.")
                if str(row["payment_state"] or "").lower() in {"paid", "bezahlt", "closed", "geschlossen"}:
                    raise ValueError("Bezahlte Rechnung darf nicht ersetzt werden.")
                try:
                    meta = con.execute(
                        "SELECT payment_status FROM brain_payment_meta WHERE source='KRISTINE' AND source_id=?",
                        (f"kristine:{invoice_id}",)
                    ).fetchone()
                except Exception:
                    meta = None
                if meta and str(meta["payment_status"] or "").lower() == "sepa_submitted":
                    raise ValueError("Rechnung wurde bereits an SEPA übergeben und darf nicht ersetzt werden.")
                analysis = analyze_pdf(raw, upload.filename)
                sha = str(analysis.get("sha256") or hashlib.sha256(raw).hexdigest())
                clash = con.execute("SELECT id,doc_id FROM incoming_invoices WHERE file_sha256=? AND id<>? LIMIT 1", (sha, invoice_id)).fetchone()
                if clash:
                    raise ValueError(f"Dieses PDF gehört bereits zu {clash['doc_id']}.")
                pdf_path = Path(str(row["pdf_path"] or ""))
                original_path = Path(str(row["original_path"] or ""))
                for target in (pdf_path, original_path):
                    target.parent.mkdir(parents=True, exist_ok=True)
                    tmp = target.with_name("." + target.name + ".replace.tmp")
                    tmp.write_bytes(raw)
                    tmp.replace(target)
                con.execute("""
                    UPDATE incoming_invoices SET original_filename=?,file_sha256=?,pdf_text=?,page_count=?,
                        ocr_used=?,ocr_pages=?,ocr_warning=?,updated_at=? WHERE id=?
                """, (
                    str(upload.filename or "")[:240], sha, str(analysis.get("text") or ""),
                    int(analysis.get("pageCount") or 0), 1 if analysis.get("ocrUsed") else 0,
                    int(analysis.get("ocrPages") or 0), str(analysis.get("ocrWarning") or ""),
                    datetime.now().isoformat(timespec="seconds"), invoice_id
                ))
                con.commit()
                doc_id = str(row["doc_id"] or "")
            finally:
                con.close()
            return jsonify(ok=True, id=invoice_id, docId=doc_id, message=f"PDF von {doc_id} ersetzt. Rechnungsdaten bleiben zur Kontrolle bestehen.")
        except ValueError as exc:
            return jsonify(ok=False, error=str(exc)), 400
        except Exception as exc:
            return jsonify(ok=False, error=str(exc)), 500

    print("✅ Capture Learning API: Fences · Layout-Anker · Dublettenprüfung")
