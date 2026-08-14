from flask import Flask, request, jsonify, send_file
import sqlite3
from pathlib import Path
from io import BytesIO
from datetime import datetime
import os
import re

import pymupdf
import pyodbc

app = Flask(__name__)

DB = Path(r"N:\OneDrive\Dokumente\Kristine\Daten\kristine_pdf_index_v2.db")
SQL_SERVER = r"SRV-DB01\WINWORKER"
SQL_DATABASE = "WinWorker_Projekte_Standard"
SQL_USER = "kristine_reader"


def get_sql_driver():
    drivers = pyodbc.drivers()
    for name in (
        "ODBC Driver 18 for SQL Server",
        "ODBC Driver 17 for SQL Server",
        "SQL Server Native Client 11.0",
        "SQL Server",
    ):
        if name in drivers:
            return name
    raise RuntimeError("Kein geeigneter SQL-Server-ODBC-Treiber gefunden")


def sql_connection(database=SQL_DATABASE):
    password = os.environ.get("KRISTINE_SQL_PASSWORD", "").strip()
    if not password:
        raise RuntimeError("KRISTINE_SQL_PASSWORD fehlt")

    driver = get_sql_driver()
    return pyodbc.connect(
        f"DRIVER={{{driver}}};"
        f"SERVER={SQL_SERVER};"
        f"DATABASE={database};"
        f"UID={SQL_USER};"
        f"PWD={password};"
        "TrustServerCertificate=yes;",
        timeout=5,
    )


def clean_date(value):
    if value is None:
        return None
    if hasattr(value, "date"):
        return value.date().isoformat()
    return str(value)



def project_metrics(project_indices):
    """
    Projektkennzahlen V0.9.

    IST-STUNDEN
    -----------
    Direkte Verbindung zur Datenbank WinWorker_Mitschreibung_Standard.
    Das vermeidet Cross-DB-Probleme des Reader-Users.
    SUM(dStundenErfasst), bNichtAuswerten = 0.

    NETTO
    -----
    1) Pro Projekt + sBuchNummer nur die neueste Buch-Version.
       Reihenfolge: Geändert / dzInhaltGeaendert / dzDocDatum / Aufgenommen.
    2) dbo.Rechnung zusätzlich je gBuchID deduplizieren.
    3) Erst danach cUmsatzNetto summieren.
    """
    ids = sorted({int(x) for x in project_indices if x is not None})
    if not ids:
        return {}

    placeholders = ",".join("?" for _ in ids)
    result = {pid: {"hoursTotal": None, "netInvoiced": None} for pid in ids}

    # 1) Echte IST-Stunden
    # Wichtig: gleiche Verbindung wie die funktionierende Projektsuche verwenden,
    # aber die Mitschreibungs-Tabelle vollständig qualifizieren.
    try:
        con = sql_connection("WinWorker_Projekte_Standard")
        cur = con.cursor()
        sql = f"""
            SELECT
                sm.ProjektIndex,
                SUM(CAST(ISNULL(sm.dStundenErfasst, 0) AS decimal(18,4))) AS IstStunden
            FROM WinWorker_Mitschreibung_Standard.dbo.Stundenmitschreibung AS sm
            WHERE sm.ProjektIndex IN ({placeholders})
              AND ISNULL(sm.bNichtAuswerten, 0) = 0
            GROUP BY sm.ProjektIndex
        """
        rows = cur.execute(sql, *ids).fetchall()
        con.close()

        for row in rows:
            pid = int(row.ProjektIndex)
            if pid in result:
                result[pid]["hoursTotal"] = (
                    float(row.IstStunden) if row.IstStunden is not None else None
                )
    except Exception as e:
        print("SQL Stunden-Metrik FEHLER:", repr(e))

    # 2) Aktueller Netto-Abrechnungsstand
    #
    # WinWorker liefert dieselbe Rechnungsnummer mehrfach (z. B. Buchart 6/7
    # oder neu gedruckte/geänderte Versionen). Für die Archivkarte zählt
    # JEDE RECHNUNGSNUMMER NUR EINMAL.
    #
    # Vorgehen:
    # - alle Buch-/Rechnungszeilen des Projekts holen
    # - pro sBuchNummer nur eine aktuelle/eindeutige Netto-Zeile bestimmen
    # - erst danach summieren
    try:
        con = sql_connection("WinWorker_Projekte_Standard")
        cur = con.cursor()
        sql = f"""
            WITH InvoiceRows AS (
                SELECT
                    b.ProjektIndex,
                    LTRIM(RTRIM(b.sBuchNummer)) AS sBuchNummer,
                    r.cUmsatzNetto,
                    COALESCE(
                        b.Geändert,
                        b.dzInhaltGeaendert,
                        b.dzDocDatum,
                        b.Aufgenommen
                    ) AS VersionZeit,
                    b.gID
                FROM dbo.[Bücher] AS b
                INNER JOIN dbo.Rechnung AS r
                    ON r.gBuchID = b.gID
                WHERE b.ProjektIndex IN ({placeholders})
                  AND NULLIF(LTRIM(RTRIM(ISNULL(b.sBuchNummer, ''))), '') IS NOT NULL
                  AND ISNULL(b.Storno, 0) = 0
                  AND r.cUmsatzNetto IS NOT NULL
            ),
            LatestPerInvoiceNumber AS (
                SELECT
                    ProjektIndex,
                    sBuchNummer,
                    cUmsatzNetto,
                    ROW_NUMBER() OVER (
                        PARTITION BY ProjektIndex, sBuchNummer
                        ORDER BY
                            VersionZeit DESC,
                            gID DESC
                    ) AS rn
                FROM InvoiceRows
            )
            SELECT
                ProjektIndex,
                SUM(CAST(cUmsatzNetto AS decimal(18,2))) AS NettoAbgerechnet
            FROM LatestPerInvoiceNumber
            WHERE rn = 1
            GROUP BY ProjektIndex
        """
        rows = cur.execute(sql, *ids).fetchall()
        con.close()

        for row in rows:
            pid = int(row.ProjektIndex)
            if pid in result:
                result[pid]["netInvoiced"] = (
                    float(row.NettoAbgerechnet)
                    if row.NettoAbgerechnet is not None
                    else None
                )
    except Exception as e:
        print("SQL Rechnungs-Metrik FEHLER:", repr(e))

    return result

def search_projects(terms):
    if not terms:
        return []

    con = sql_connection()
    cur = con.cursor()

    conditions = []
    params = []

    # Alle Suchbegriffe müssen irgendwo im Projekt/Kunden-Datensatz vorkommen.
    for term in terms:
        like = f"%{term}%"
        conditions.append(
            """
            (
                ISNULL(p.sProjektNummer, '') LIKE ?
                OR ISNULL(p.sProjekt, '') LIKE ?
                OR ISNULL(p.sBaustelle, '') LIKE ?
                OR ISNULL(p.sBauvorhaben, '') LIKE ?
                OR ISNULL(k.sFirma, '') LIKE ?
                OR ISNULL(k.sName, '') LIKE ?
                OR ISNULL(k.sVorname, '') LIKE ?
                OR ISNULL(k.sStrasse, '') LIKE ?
                OR ISNULL(k.sPLZ, '') LIKE ?
                OR ISNULL(k.sOrt, '') LIKE ?
            )
            """
        )
        params.extend([like] * 10)

    # Numerische Suchbegriffe werden nur zur Sortierung genutzt:
    # exakte Projektnummer zuerst, flexible Suche bleibt vollständig erhalten.
    numeric_terms = [t for t in terms if re.fullmatch(r"\d+", t)]
    order_params = []
    order_parts = []
    if numeric_terms:
        placeholders = ",".join("?" for _ in numeric_terms)
        order_parts.append(
            f"CASE WHEN p.sProjektNummer IN ({placeholders}) THEN 0 ELSE 1 END"
        )
        order_params.extend(numeric_terms)

    order_parts.extend([
        "CASE WHEN k.lKundenNr IS NULL THEN 1 ELSE 0 END",
        "k.lKundenNr ASC",
        "MAX(b.dzDocDatum) DESC",
        "p.ProjektIndex DESC",
    ])
    order_by = ",\n            ".join(order_parts)

    sql = f"""
        SELECT TOP 100
            p.ProjektIndex,
            p.sProjektNummer,
            p.sProjekt,
            p.sBaustelle,
            p.sBauvorhaben,
            p.KundenIndex,
            k.lKundenNr,
            k.sFirma,
            k.sName,
            k.sVorname,
            k.sStrasse,
            k.sPLZ,
            k.sOrt,
            MIN(b.dzDocDatum) AS ErstesDatum,
            MAX(b.dzDocDatum) AS LetztesDatum
        FROM dbo.Projekte AS p
        LEFT JOIN WinWorker_Adressen_Standard.dbo.Kunden AS k
            ON p.KundenIndex = k.StammIndex
        LEFT JOIN dbo.Bücher AS b
            ON b.ProjektIndex = p.ProjektIndex
        WHERE {" AND ".join(conditions)}
        GROUP BY
            p.ProjektIndex,
            p.sProjektNummer,
            p.sProjekt,
            p.sBaustelle,
            p.sBauvorhaben,
            p.KundenIndex,
            k.lKundenNr,
            k.sFirma,
            k.sName,
            k.sVorname,
            k.sStrasse,
            k.sPLZ,
            k.sOrt
        ORDER BY
            {order_by}
    """

    cur.execute(sql, params + order_params)
    rows = cur.fetchall()
    con.close()

    result = []
    for row in rows:
        street = row.sStrasse or ""
        postal = row.sPLZ or ""
        city = row.sOrt or ""
        address = " ".join(x for x in [street, postal, city] if x).strip()

        customer = " ".join(
            x for x in [row.sVorname or "", row.sName or ""] if x
        ).strip()

        result.append({
            "projectIndex": row.ProjektIndex,
            "projectNumber": row.sProjektNummer or "",
            "title": row.sProjekt or row.sBaustelle or row.sBauvorhaben or "",
            "site": row.sBaustelle or "",
            "projectDescription": row.sBauvorhaben or "",
            "customerIndex": row.KundenIndex,
            "customerNumber": row.lKundenNr,
            "company": row.sFirma or "",
            "firstName": row.sVorname or "",
            "lastName": row.sName or "",
            "customer": customer,
            "street": street,
            "postalCode": postal,
            "city": city,
            "address": address,
            "firstDate": clean_date(row.ErstesDatum),
            "lastDate": clean_date(row.LetztesDatum),
        })


    metrics = project_metrics([item.get("projectIndex") for item in result])
    for item in result:
        project_index = item.get("projectIndex")
        metric = metrics.get(int(project_index)) if project_index is not None else None
        item["hoursTotal"] = metric.get("hoursTotal") if metric else None
        item["netInvoiced"] = metric.get("netInvoiced") if metric else None

    return result



def discover_metric_columns():
    """
    Findet nur Kandidaten für Stunden-/Rechnungsfelder.
    Es wird noch NICHT automatisch auf unbekannte Tabellen summiert.
    """
    con = sql_connection()
    cur = con.cursor()

    sql = """
        SELECT
            TABLE_SCHEMA,
            TABLE_NAME,
            COLUMN_NAME,
            DATA_TYPE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE
            LOWER(COLUMN_NAME) LIKE '%stund%'
            OR LOWER(COLUMN_NAME) LIKE '%hour%'
            OR LOWER(COLUMN_NAME) LIKE '%zeit%'
            OR LOWER(COLUMN_NAME) LIKE '%netto%'
            OR LOWER(COLUMN_NAME) LIKE '%rechnung%'
            OR LOWER(COLUMN_NAME) LIKE '%betrag%'
            OR LOWER(COLUMN_NAME) LIKE '%summe%'
            OR LOWER(COLUMN_NAME) LIKE '%umsatz%'
        ORDER BY TABLE_NAME, ORDINAL_POSITION
    """

    rows = cur.execute(sql).fetchall()
    con.close()

    result = []
    for row in rows:
        result.append({
            "schema": row.TABLE_SCHEMA,
            "table": row.TABLE_NAME,
            "column": row.COLUMN_NAME,
            "dataType": row.DATA_TYPE,
        })
    return result


def parse_print_time(filename, modified):
    # WinWorker benennt Kundenexemplare z.B.
    # 2205110 (2022-05-10 11.36.47).pdf
    match = re.search(
        r"\((\d{4}-\d{2}-\d{2})\s+(\d{2})\.(\d{2})\.(\d{2})\)",
        filename or "",
    )
    if match:
        iso = f"{match.group(1)}T{match.group(2)}:{match.group(3)}:{match.group(4)}"
        try:
            dt = datetime.fromisoformat(iso)
            return dt
        except ValueError:
            pass

    try:
        return datetime.fromtimestamp(float(modified))
    except Exception:
        return None


def search_pdf(terms):
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row

    sql = """
        SELECT
            filename,
            path,
            dokumenttyp,
            modified
        FROM pdf_index
        WHERE 1=1
    """
    params = []

    for term in terms:
        sql += """
            AND (
                text LIKE ?
                OR filename LIKE ?
                OR path LIKE ?
            )
        """
        like = f"%{term}%"
        params.extend([like, like, like])

    sql += " ORDER BY modified DESC LIMIT 300"
    rows = con.execute(sql, params).fetchall()
    con.close()

    result = []
    for row in rows:
        item = dict(row)
        dt = parse_print_time(item.get("filename"), item.get("modified"))
        item["printDate"] = dt.date().isoformat() if dt else None
        item["printDateTime"] = dt.isoformat(timespec="seconds") if dt else None
        item["year"] = dt.year if dt else None
        result.append(item)

    # Letzter Druck zuerst. Filename-Zeit ist zuverlässiger als Netzwerk-mtime.
    result.sort(key=lambda x: x.get("printDateTime") or "", reverse=True)
    return result


def validate_pdf_path(raw_path):
    path = Path(str(raw_path or "").strip())
    if not str(path):
        raise ValueError("PDF-Pfad fehlt")
    if path.suffix.lower() != ".pdf":
        raise ValueError("Keine PDF-Datei")
    if not path.is_file():
        raise FileNotFoundError("Datei nicht gefunden")
    return path


@app.get("/status")
def status():
    return jsonify({
        "ok": True,
        "connector": "kristine-archive",
        "version": "0.9.4",
        "pdfIndex": str(DB),
        "pdfIndexExists": DB.exists(),
        "sqlServer": SQL_SERVER,
        "sqlDatabase": SQL_DATABASE,
        "sqlUser": SQL_USER,
        "sqlPasswordConfigured": bool(os.environ.get("KRISTINE_SQL_PASSWORD", "").strip()),
    })



@app.get("/project-metrics/<int:project_index>")
def project_metrics_debug(project_index):
    try:
        return jsonify({
            "ok": True,
            "projectIndex": project_index,
            "metrics": project_metrics([project_index]).get(project_index, {})
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/project-invoices/<int:project_index>")
def project_invoices_debug(project_index):
    try:
        con = sql_connection("WinWorker_Projekte_Standard")
        cur = con.cursor()
        rows = cur.execute("""
            SELECT
                b.sBuchNummer,
                b.Buchart,
                b.gID,
                b.dzDocDatum,
                b.Geändert,
                r.cUmsatzNetto,
                r.dzRechnungsdatum
            FROM dbo.[Bücher] AS b
            LEFT JOIN dbo.Rechnung AS r
                ON r.gBuchID = b.gID
            WHERE b.ProjektIndex = ?
              AND ISNULL(b.Storno, 0) = 0
              AND r.cUmsatzNetto IS NOT NULL
            ORDER BY
                b.sBuchNummer,
                COALESCE(b.Geändert, b.dzInhaltGeaendert, b.dzDocDatum, b.Aufgenommen) DESC,
                b.gID DESC
        """, project_index).fetchall()
        con.close()

        items = []
        for row in rows:
            items.append({
                "sBuchNummer": row.sBuchNummer,
                "Buchart": row.Buchart,
                "gID": str(row.gID) if row.gID is not None else None,
                "dzDocDatum": clean_date(row.dzDocDatum),
                "Geaendert": clean_date(row.Geändert),
                "cUmsatzNetto": float(row.cUmsatzNetto) if row.cUmsatzNetto is not None else None,
                "dzRechnungsdatum": clean_date(row.dzRechnungsdatum),
            })
        return jsonify({"ok": True, "projectIndex": project_index, "rows": items})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500



@app.get("/schema-hints")
def schema_hints():
    try:
        rows = discover_metric_columns()
        return jsonify({
            "ok": True,
            "count": len(rows),
            "columns": rows,
            "note": "Diagnose-Endpunkt. V0.8 verwendet bereits Stundenmitschreibung und pro Rechnungsnummer nur die neueste Version."
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/search")
def search():
    q = str(request.args.get("q", "")).strip()
    if not q:
        return jsonify({
            "ok": True,
            "query": "",
            "terms": [],
            "projects": [],
            "documents": [],
            "sqlError": None,
        })

    terms = [x.strip() for x in q.split() if x.strip()]

    try:
        documents = search_pdf(terms)
    except Exception as e:
        return jsonify({"ok": False, "error": f"PDF-Index: {e}"}), 500

    projects = []
    sql_error = None
    try:
        projects = search_projects(terms)
    except Exception as e:
        sql_error = str(e)
        print("SQL-Fehler:", e)

    return jsonify({
        "ok": True,
        "query": q,
        "terms": terms,
        "projects": projects,
        "documents": documents,
        "sqlError": sql_error,
    })


@app.post("/open")
def open_pdf():
    try:
        data = request.get_json(silent=True) or {}
        path = validate_pdf_path(data.get("path"))
        os.startfile(str(path))
        return jsonify({"ok": True, "path": str(path)})
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except FileNotFoundError as e:
        return jsonify({"ok": False, "error": str(e)}), 404
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/thumb")
def thumbnail():
    try:
        path = validate_pdf_path(request.args.get("path"))
        with pymupdf.open(path) as doc:
            if len(doc) < 1:
                raise ValueError("PDF hat keine Seiten")
            page = doc[0]
            pix = page.get_pixmap(matrix=pymupdf.Matrix(0.72, 0.72), alpha=False)
            png = pix.tobytes("png")

        return send_file(BytesIO(png), mimetype="image/png", max_age=300)
    except (ValueError, FileNotFoundError):
        return ("", 404)
    except Exception as e:
        print("Thumbnail-Fehler:", e)
        return ("", 500)


if __name__ == "__main__":
    print()
    print("KRISTINE ARCHIV CONNECTOR")
    print("-------------------------")
    print("Status : http://127.0.0.1:5051/status")
    print("Suche  : http://127.0.0.1:5051/search?q=6844%20Fusonic")
    print("Schema : http://127.0.0.1:5051/schema-hints")
    print("Version: 0.9.4 - Kunde + Stunden + Netto + Kundenjahr")
    print()

    app.run(host="127.0.0.1", port=5051, debug=False)
