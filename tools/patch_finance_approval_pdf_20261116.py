from pathlib import Path
p=Path(__file__).resolve().parents[1]
brain=p/"brain_finance_runtime.py"
s=brain.read_text(encoding="utf-8")
old='"/incoming/payment-approvals/sync","/incoming/payments"'
assert s.count(old)==1
s=s.replace(old,'"/incoming/payment-approvals/sync","/incoming/approval-document","/incoming/payments"')
marker='        @app.get("/incoming/payments")'
assert s.count(marker)==1
route='''        @app.get("/incoming/approval-document")
        def brain_incoming_approval_document():
            # Resolve by internal invoice identity, never by supplier/amount/number.
            from flask import redirect
            from pathlib import Path
            source=str(request.args.get("source") or "").strip()
            sid=str(request.args.get("id") or "").strip()
            if source != "KRISTINE" or not re.fullmatch(r"kristine:[0-9]+",sid):
                return jsonify(ok=False,error="Ungültige Rechnungskennung."),400
            try:
                found=[row for row in store.kristine(True) if str(row.get("id") or "")==sid]
                if len(found)!=1:
                    return jsonify(ok=False,error="Rechnung nicht eindeutig gefunden."),404
                path=str(found[0].get("path") or "").strip()
                if not path or not Path(path).is_file():
                    return jsonify(ok=False,error="Originalrechnung fehlt im Rechnungseingang."),404
                return redirect("/pdf?path="+quote(path,safe=""),code=302)
            except Exception:
                return jsonify(ok=False,error="Originalrechnung konnte nicht geöffnet werden."),500

'''
s=s.replace(marker,route+marker)
brain.write_text(s,encoding="utf-8")
print("brain route patched")
