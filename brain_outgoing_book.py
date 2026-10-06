"""Read-only outgoing invoice book, combining WW originals and native invoices."""
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from brain_book_filters import filter_rows, monthly_totals


def money(value):
    return float(Decimal(str(value or 0)).quantize(Decimal('.01'), rounding=ROUND_HALF_UP))


class OutgoingBook:
    def __init__(self, store, ns):
        self.store, self.ns = store, ns

    def ww_rows(self, year):
        connection = self.ns.get("sql_connection")
        if not callable(connection):
            raise RuntimeError("WinWorker ist nicht erreichbar. Das vollständige Rechnungsbuch kann nicht geladen werden.")
        con = connection()
        try:
            cur = con.cursor()
            cur.execute("""
                WITH InvoiceRows AS (
                  SELECT CONVERT(varchar(36),b.gID) AS sourceId,
                    LTRIM(RTRIM(b.sBuchNummer)) AS invoiceNumber,
                    COALESCE(r.dzRechnungsdatum,b.dzDocDatum) AS invoiceDate,
                    COALESCE(k.sFirma,'') AS company,
                    LTRIM(RTRIM(COALESCE(k.sVorname,'')+' '+COALESCE(k.sName,''))) AS customer,
                    COALESCE(b.sKunde,'') AS customerRaw,
                    COALESCE(p.sProjektNummer,b.sProjektNummer,'') AS projectNumber,
                    COALESCE(p.sProjekt,b.sProjekt,'') AS projectTitle,
                    r.cUmsatzNetto AS net,
                    COALESCE(r.cForderungBrutto,r.cOffenerPostenBrutto,0) AS gross,
                    COALESCE(r.cOffenerPostenBrutto,0) AS openGross,
                    COALESCE(calc.fCalcMwStSatz,0) AS vatRate,
                    r.bIstAbschlag AS isPartial,r.bIstSchlussrechnung AS isFinal,
                    ROW_NUMBER() OVER(PARTITION BY b.sBuchNummer
                      ORDER BY COALESCE(b.Geändert,b.dzInhaltGeaendert,b.dzDocDatum,b.Aufgenommen) DESC,b.gID DESC) AS rowNo
                  FROM dbo.[Bücher] b JOIN dbo.Rechnung r ON r.gBuchID=b.gID
                  LEFT JOIN dbo.Projekte p ON p.ProjektIndex=b.ProjektIndex
                  LEFT JOIN WinWorker_Adressen_Standard.dbo.Kunden k ON k.StammIndex=b.KundenIndex
                  OUTER APPLY(SELECT TOP 1 bk.fCalcMwStSatz FROM dbo.[Bücher Kalkulation] bk
                    WHERE bk.gBuchID=b.gID ORDER BY bk.Backup_BuchIndex DESC) calc
                  WHERE b.Storno=0 AND b.ErsterAusdruck>CONVERT(datetime,'18000101',112)
                    AND NULLIF(LTRIM(RTRIM(b.sBuchNummer)),'') IS NOT NULL AND r.cUmsatzNetto IS NOT NULL
                ) SELECT * FROM InvoiceRows WHERE rowNo=1 AND (?=0 OR YEAR(invoiceDate)=?)
                ORDER BY invoiceDate,invoiceNumber
            """, year, year)
            columns = [x[0] for x in cur.description]
            result = []
            for values in cur.fetchall():
                x = dict(zip(columns, values))
                day = x["invoiceDate"]
                net = money(x["net"])
                gross = money(x["gross"])
                if not gross and net:
                    gross = money(Decimal(str(net)) * (1 + Decimal(str(x["vatRate"] or 0))/100))
                outstanding = min(max(0, money(x["openGross"])), max(0, gross))
                result.append({"source":"WW", "sourceId":str(x["sourceId"]), "id":None,
                    "invoiceNumber":str(x["invoiceNumber"]),
                    "invoiceDate":day.date().isoformat() if hasattr(day,"date") else str(day or '')[:10],
                    "customer":x["company"] or x["customer"] or x["customerRaw"] or "Ohne Kunde",
                    "projectNumber":str(x["projectNumber"]), "projectTitle":x["projectTitle"],
                    "kind":"GS" if gross < 0 else "SR" if x["isFinal"] else "TR" if x["isPartial"] else "RE",
                    "status":"issued", "currency":"EUR", "net":net, "vat":money(gross-net),
                    "gross":gross, "open":outstanding, "paid":money(gross-outstanding), "pdfUrl":""})
            return result
        finally:
            con.close()

    def local_rows(self, year):
        outstanding = {x["invoiceId"]:x["openGross"] for x in self.store.debtor_open_items()}
        with self.store.connect() as con:
            rows = con.execute("""SELECT i.*,r.customer_company,r.customer_name,r.project_number,r.project_title
                FROM outgoing_invoices i JOIN outgoing_runs r ON r.id=i.run_id
                WHERE i.status IN ('issued','draft') AND (?=0 OR substr(i.issue_date,1,4)=?)
                ORDER BY i.issue_date,i.id""", (year,str(year))).fetchall()
        result = []
        for x in rows:
            gross = money(x["increment_gross"])
            opened = money(outstanding.get(x["id"], 0)) if x["status"] == "issued" else 0
            result.append({"id":x["id"], "source":x["source"], "sourceId":x["source_id"],
                "invoiceNumber":x["invoice_number"] or "Entwurf", "invoiceDate":x["issue_date"],
                "customer":x["customer_company"] or x["customer_name"] or "Ohne Kunde",
                "projectNumber":x["project_number"], "projectTitle":x["project_title"],
                "kind":x["kind"], "status":x["status"], "currency":x["currency"],
                "net":money(x["increment_net"]), "vat":money(x["increment_vat"]), "gross":gross,
                "open":opened, "paid":money(gross-opened) if x["status"]=='issued' else 0,
                "pdfUrl":f"/api/outgoing/invoices/{x['id']}/source-pdf" if x["source"]=='WW' else
                         f"/api/outgoing/invoices/{x['id']}/pdf" if x["status"]=='issued' else ""})
        return result

    def items(self, year, args):
        local = self.local_rows(year)
        native = {x["invoiceNumber"]:x for x in local if x["source"]!='WW' and x["status"]=='issued'}
        mirrors = {x["invoiceNumber"]:x for x in local if x["source"]=='WW'}
        rows = []
        seen = set()
        for x in self.ww_rows(year):
            number = x["invoiceNumber"]
            if number in native:
                continue
            if number in mirrors:
                mirror = mirrors[number]
                x.update(id=mirror["id"], pdfUrl=mirror["pdfUrl"], open=mirror["open"])
                x["paid"] = money(x["gross"]-x["open"])
            rows.append(x); seen.add(number)
        rows += [x for x in local if x["source"]!='WW' or x["invoiceNumber"] not in seen]
        query = str(args.get('q') or '').strip().casefold()
        rows = filter_rows(rows, args)
        rows = [x for x in rows if not query or query in ' '.join(str(x.get(k) or '') for k in
                ('customer','invoiceNumber','projectNumber','projectTitle')).casefold()]
        state = args.get('state') or 'issued'
        if state not in {'issued','open','paid','draft'}:
            raise ValueError('Ungültiger Status.')
        rows = [x for x in rows if (x['status']=='draft' if state=='draft' else x['status']=='issued' and
                (state=='issued' or (x['open'] > .004 if state=='open' else abs(x['open']) <= .004)))]
        rows.sort(key=lambda x:(x['invoiceDate'],x['invoiceNumber']), reverse=True)
        return rows


def install(ns):
    app = ns.get('app')
    if app is None or 'outgoing_book_page' in app.view_functions:
        return
    store = app.extensions.get('kristine_outgoing_store')
    if store is None:
        return
    from flask import request, jsonify, Response
    book = OutgoingBook(store, ns)
    ns['outgoing_invoice_book'] = book
    ns['MOBILE_ALLOWED_PATHS'].update({'/outgoing/invoice-book','/outgoing/invoice-book/items'})

    @app.get('/outgoing/invoice-book')
    def outgoing_book_page():
        return Response((Path(__file__).parent/'public'/'outgoing-invoice-book.html').read_text(encoding='utf-8'),mimetype='text/html')

    @app.get('/outgoing/invoice-book/items')
    def outgoing_book_items():
        try:
            year = int(request.args.get('year') or 0)
            if year and not 1900 <= year <= 2200:
                raise ValueError('Ungültiges Jahr.')
            rows = book.items(year, request.args)
            return jsonify(ok=True,items=rows,months=monthly_totals(rows),count=len(rows))
        except ValueError as exc:
            return jsonify(ok=False,error=str(exc)),400
        except Exception as exc:
            return jsonify(ok=False,error=str(exc)),503
