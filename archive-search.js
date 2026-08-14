from flask import Flask, request, jsonify, send_file
import sqlite3
from pathlib import Path
from io import BytesIO
import os
from datetime import datetime

import pymupdf
import pyodbc

app = Flask(__name__)

DB = Path(r"N:\OneDrive\Dokumente\Kristine\Daten\kristine_pdf_index_v2.db")
SQL_SERVER = r"SRV-DB01\WINWORKER"
SQL_DATABASE = "WinWorker_Projekte_Standard"


def get_sql_driver():
    drivers = pyodbc.drivers()
    preferred = [
        "ODBC Driver 18 for SQL Server",
        "ODBC Driver 17 for SQL Server",
        "SQL Server Native Client 11.0",
        "SQL Server",
    ]
    for driver in preferred:
        if driver in drivers:
            return driver
    raise RuntimeError(
        "Kein SQL-Server-ODBC-Treiber gefunden. Installiert: " + ", ".join(drivers)
    )


def sql_connection():
    driver = get_sql_driver()
    parts = [
        f"DRIVER={{{driver}}}",
        f"SERVER={SQL_SERVER}",
        f"DATABASE={SQL_DATABASE}",
        "Trusted_Connection=yes",
    ]
    if driver.startswith("ODBC Driver"):
        parts.append("TrustServerCertificate=yes")
    return pyodbc.connect(";".join(parts) + ";", timeout=5)


def iso_date(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    try:
        return value.isoformat()
    except Exception:
        return str(value)


def search_projects(terms):
    if not terms:
        return []

    conditions = []
    params = []

    for term in terms:
        like = f"%{term}%"
        conditions.append("""
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
        """)
        params.extend([like] * 10)

    sql = f"""
        SELECT TOP 50
            p.ProjektIndex,
            p.sProjektNummer AS Projektnummer,
            p.sProjekt AS Projekt,
            p.sBaustelle AS Baustelle,
            p.sBauvorhaben AS Bauvorhaben,
            p.KundenIndex,
            k.sFirma AS Firma,
            k.sName AS Name,
            k.sVorname AS Vorname,
            k.sStrasse AS Strasse,
            k.sPLZ AS PLZ,
            k.sOrt AS Ort,
            MIN(b.dzDocDatum) AS ErstesDatum,
            MAX(b.dzDocDatum) AS LetztesDatum
        FROM dbo.Projekte AS p
        LEFT JOIN WinWorker_Adressen_Standard.dbo.Kunden AS k
            ON p.KundenIndex = k.StammIndex
        LEFT JOIN dbo.Bücher AS b
            ON b.ProjektIndex = p.ProjektIndex
        WHERE {' AND '.join(conditions)}
        GROUP BY
            p.ProjektIndex,
            p.sProjektNummer,
            p.sProjekt,
            p.sBaustelle,
            p.sBauvorhaben,
            p.KundenIndex,
            k.sFirma,
            k.sName,
            k.sVorname,
            k.sStrasse,
            k.sPLZ,
            k.sOrt
        ORDER BY MAX(b.dzDocDatum) DESC, p.ProjektIndex DESC
    """

    con = sql_connection()
    try:
        cur = con.cursor()
        cur.execute(sql, params)
        rows = cur.fetchall()

        result = []
        for row in rows:
            customer = " ".join(
                x for x in [row.Firma, row.Vorname, row.Name] if x
            ).strip()
            address = " ".join(
                x for x in [row.Strasse, row.PLZ, row.Ort] if x
            ).strip()

            result.append({
                "projectIndex": row.ProjektIndex,
                "projectNumber": row.Projektnummer,
                "title": row.Projekt or row.Baustelle or row.Bauvorhaben or "",
                "site": row.Baustelle or "",
                "projectDescription": row.Bauvorhaben or "",
                "customerIndex": row.KundenIndex,
                "customer": customer,
                "company": row.Firma or "",
                "firstName": row.Vorname or "",
                "lastName": row.Name or "",
                "street": row.Strasse or "",
                "postalCode": row.PLZ or "",
                "city": row.Ort or "",
                "address": address,
                "firstDate": iso_date(row.ErstesDatum),
                "lastDate": iso_date(row.LetztesDatum),
            })

        return result
    finally:
        con.close()


def search_pdf(terms):
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row

    sql = """
        SELECT
            filename,
            path,
            dokumenttyp,
            modified,
            text
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

    sql += """
        ORDER BY modified DESC
        LIMIT 200
    """

    rows = con.execute(sql, params).fetchall()
    con.close()

    result = []

    for row in rows:
        item = dict(row)

        text = item.get("text") or ""
        lower = text.lower()

        positions = []
        for term in terms:
            pos = lower.find(term.lower())
            if pos >= 0:
                positions.append(pos)

        if positions:
            pos = min(positions)
            start = max(0, pos - 140)
            end = min(len(text), pos + 520)
            snippet = text[start:end]
        else:
            snippet = text[:600]

        item["snippet"] = " ".join(snippet.split())
        item.pop("text", None)

        if item.get("modified"):
            try:
                dt = datetime.fromtimestamp(float(item["modified"]))
                item["year"] = dt.year
                item["modifiedIso"] = dt.isoformat(timespec="seconds")
            except Exception:
                item["year"] = None
                item["modifiedIso"] = None
        else:
            item["year"] = None
            item["modifiedIso"] = None

        result.append(item)

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
    sql_ok = False
    sql_error = None
    driver = None

    try:
        driver = get_sql_driver()
        con = sql_connection()
        try:
            cur = con.cursor()
            cur.execute("SELECT 1")
            cur.fetchone()
            sql_ok = True
        finally:
            con.close()
    except Exception as e:
        sql_error = str(e)

    return jsonify({
        "ok": True,
        "connector": "kristine-archive",
        "version": "0.4",
        "pdfIndex": str(DB),
        "pdfIndexExists": DB.exists(),
        "sqlServer": SQL_SERVER,
        "sqlDatabase": SQL_DATABASE,
        "sqlDriver": driver,
        "sqlOk": sql_ok,
        "sqlError": sql_error,
    })


@app.get("/search")
def search():
    q = str(request.args.get("q", "")).strip()

    if not q:
        return jsonify({
            "ok": True,
            "query": "",
            "projects": [],
            "documents": [],
            "sqlError": None,
        })

    terms = [x.strip() for x in q.split() if x.strip()]

    try:
        documents = search_pdf(terms)
    except Exception as e:
        return jsonify({
            "ok": False,
            "error": f"PDF-Index: {e}"
        }), 500

    projects = []
    sql_error = None
    try:
        projects = search_projects(terms)
    except Exception as e:
        sql_error = str(e)
        print("SQL-Suche:", e)

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

        return jsonify({
            "ok": True,
            "path": str(path)
        })

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
            pix = page.get_pixmap(
                matrix=pymupdf.Matrix(0.70, 0.70),
                alpha=False
            )
            png = pix.tobytes("png")

        return send_file(
            BytesIO(png),
            mimetype="image/png",
            max_age=300
        )

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
    print("Version: 0.4 - PDF + WinWorker SQL")
    print()

    app.run(
        host="127.0.0.1",
        port=5051,
        debug=False
    )
