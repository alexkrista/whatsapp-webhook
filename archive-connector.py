from flask import Flask, request, jsonify, send_file, render_template_string
import sqlite3
from pathlib import Path
from io import BytesIO
from datetime import datetime
import os
import re
import json
import hmac

import pymupdf
import pyodbc
from waitress import serve

app = Flask(__name__)

# ---------------------------------------------------------------------------
# HANDY-ZUGANG / SICHERHEIT
# ---------------------------------------------------------------------------
# Der Dienst lauscht nur auf localhost UND auf der Tailscale-IP dieses PCs.
# Er wird NICHT auf 0.0.0.0 geöffnet.
TAILSCALE_IP = os.environ.get("KRISTINE_TAILSCALE_IP", "100.98.155.39").strip()
ARCHIVE_USER = os.environ.get("KRISTINE_ARCHIVE_USER", "kristine").strip()
ARCHIVE_PASSWORD = os.environ.get("KRISTINE_ARCHIVE_PASSWORD", "").strip()

# Vom Handy aus werden absichtlich nur diese vier Endpunkte freigegeben.
# Diagnose-, Schema-, Fusion- und /open-Endpunkte bleiben ausschließlich lokal.
MOBILE_ALLOWED_PATHS = {"/", "/mobile", "/status", "/search", "/thumb", "/pdf"}


def _request_is_local():
    return (request.remote_addr or "") in {"127.0.0.1", "::1"}


@app.before_request
def protect_remote_archive_access():
    # Bestehende lokale KRISTINE-Aufrufe auf 127.0.0.1 bleiben unverändert.
    if _request_is_local():
        return None

    # Über Tailscale nur die minimale Handy-API freigeben.
    if request.path not in MOBILE_ALLOWED_PATHS:
        return jsonify({"ok": False, "error": "Nicht verfügbar"}), 404

    # Fail closed: Ohne gesetztes Passwort gibt es KEINEN Remote-Zugriff.
    if not ARCHIVE_PASSWORD:
        return jsonify({
            "ok": False,
            "error": "Remote-Zugriff gesperrt: KRISTINE_ARCHIVE_PASSWORD fehlt."
        }), 503

    auth = request.authorization
    username_ok = bool(auth) and hmac.compare_digest(auth.username or "", ARCHIVE_USER)
    password_ok = bool(auth) and hmac.compare_digest(auth.password or "", ARCHIVE_PASSWORD)

    if not (username_ok and password_ok):
        response = jsonify({"ok": False, "error": "Anmeldung erforderlich"})
        response.status_code = 401
        response.headers["WWW-Authenticate"] = 'Basic realm="KRISTINE Archive", charset="UTF-8"'
        return response

    return None


@app.after_request
def archive_security_headers(response):
    # Keine sensiblen Archivantworten im Browser-/Proxy-Cache behalten.
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
    return response

DB = Path(r"N:\OneDrive\Dokumente\Kristine\Daten\kristine_pdf_index_v2.db")
SQL_SERVER = r"SRV-DB01\WINWORKER"
SQL_DATABASE = "WinWorker_Projekte_Standard"
SQL_USER = "kristine_reader"

SCHEMA_INDEX_FILE = DB.parent / "winworker_sql_structure_index.json"


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




def _schema_safe_name(value):
    value = str(value or "")
    if not re.fullmatch(r"[A-Za-z0-9_]+", value):
        raise ValueError(f"Unsicherer SQL-Name: {value}")
    return value


def build_winworker_schema_index():
    """
    Baut einen reinen STRUKTURINDEX der WinWorker-SQL-Landschaft.
    Keine Geschäftsdaten werden kopiert.

    Erfasst – soweit der Reader darauf zugreifen darf:
    - Datenbanken WinWorker_*
    - Tabellen und Views
    - Spalten + Datentyp + NULL
    - Primärschlüssel
    - Fremdschlüssel
    - normale/unique Indizes

    Nicht erreichbare Datenbanken werden protokolliert und übersprungen.
    """
    master = sql_connection("master")
    cur = master.cursor()
    db_rows = cur.execute("""
        SELECT name
        FROM sys.databases
        WHERE name LIKE 'WinWorker[_]%'
          AND state_desc = 'ONLINE'
        ORDER BY name
    """).fetchall()
    master.close()

    db_names = [str(row.name) for row in db_rows]
    result = {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "server": SQL_SERVER,
        "databaseCount": len(db_names),
        "databases": [],
        "errors": [],
    }

    for db_name in db_names:
        db_name = _schema_safe_name(db_name)
        db_item = {
            "name": db_name,
            "objects": [],
            "foreignKeys": [],
            "indexes": [],
        }
        try:
            con = sql_connection(db_name)
            cur = con.cursor()

            # Tables + views + columns + PK flag.
            rows = cur.execute("""
                SELECT
                    s.name AS schema_name,
                    o.name AS object_name,
                    CASE o.type WHEN 'U' THEN 'TABLE' WHEN 'V' THEN 'VIEW' ELSE o.type_desc END AS object_type,
                    c.column_id,
                    c.name AS column_name,
                    t.name AS data_type,
                    c.max_length,
                    c.precision,
                    c.scale,
                    c.is_nullable,
                    CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END AS is_primary_key
                FROM sys.objects o
                JOIN sys.schemas s ON s.schema_id = o.schema_id
                JOIN sys.columns c ON c.object_id = o.object_id
                JOIN sys.types t ON t.user_type_id = c.user_type_id
                LEFT JOIN (
                    SELECT ic.object_id, ic.column_id
                    FROM sys.indexes i
                    JOIN sys.index_columns ic
                      ON ic.object_id = i.object_id
                     AND ic.index_id = i.index_id
                    WHERE i.is_primary_key = 1
                ) pk
                  ON pk.object_id = c.object_id
                 AND pk.column_id = c.column_id
                WHERE o.type IN ('U','V')
                  AND o.is_ms_shipped = 0
                ORDER BY s.name, o.name, c.column_id
            """).fetchall()

            object_map = {}
            for row in rows:
                key = (str(row.schema_name), str(row.object_name), str(row.object_type))
                if key not in object_map:
                    object_map[key] = {
                        "schema": key[0],
                        "name": key[1],
                        "type": key[2],
                        "columns": [],
                    }
                object_map[key]["columns"].append({
                    "ordinal": int(row.column_id),
                    "name": str(row.column_name),
                    "dataType": str(row.data_type),
                    "maxLength": int(row.max_length) if row.max_length is not None else None,
                    "precision": int(row.precision) if row.precision is not None else None,
                    "scale": int(row.scale) if row.scale is not None else None,
                    "nullable": bool(row.is_nullable),
                    "primaryKey": bool(row.is_primary_key),
                })
            db_item["objects"] = list(object_map.values())

            # Foreign keys.
            fk_rows = cur.execute("""
                SELECT
                    fk.name AS fk_name,
                    ps.name AS parent_schema,
                    pt.name AS parent_table,
                    pc.name AS parent_column,
                    rs.name AS ref_schema,
                    rt.name AS ref_table,
                    rc.name AS ref_column
                FROM sys.foreign_keys fk
                JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
                JOIN sys.tables pt ON pt.object_id = fkc.parent_object_id
                JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
                JOIN sys.columns pc
                  ON pc.object_id = fkc.parent_object_id
                 AND pc.column_id = fkc.parent_column_id
                JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
                JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
                JOIN sys.columns rc
                  ON rc.object_id = fkc.referenced_object_id
                 AND rc.column_id = fkc.referenced_column_id
                ORDER BY fk.name, fkc.constraint_column_id
            """).fetchall()
            db_item["foreignKeys"] = [{
                "name": str(r.fk_name),
                "from": f"{r.parent_schema}.{r.parent_table}.{r.parent_column}",
                "to": f"{r.ref_schema}.{r.ref_table}.{r.ref_column}",
            } for r in fk_rows]

            # Indexes: useful for identifying stable keys even where no FK exists.
            idx_rows = cur.execute("""
                SELECT
                    s.name AS schema_name,
                    t.name AS table_name,
                    i.name AS index_name,
                    i.is_unique,
                    i.is_primary_key,
                    c.name AS column_name,
                    ic.key_ordinal
                FROM sys.indexes i
                JOIN sys.tables t ON t.object_id = i.object_id
                JOIN sys.schemas s ON s.schema_id = t.schema_id
                JOIN sys.index_columns ic
                  ON ic.object_id = i.object_id
                 AND ic.index_id = i.index_id
                JOIN sys.columns c
                  ON c.object_id = ic.object_id
                 AND c.column_id = ic.column_id
                WHERE i.name IS NOT NULL
                  AND i.is_hypothetical = 0
                ORDER BY s.name, t.name, i.name, ic.key_ordinal, c.column_id
            """).fetchall()
            idx_map = {}
            for r in idx_rows:
                key = (str(r.schema_name), str(r.table_name), str(r.index_name))
                idx_map.setdefault(key, {
                    "schema": key[0],
                    "table": key[1],
                    "name": key[2],
                    "unique": bool(r.is_unique),
                    "primaryKey": bool(r.is_primary_key),
                    "columns": [],
                })
                idx_map[key]["columns"].append(str(r.column_name))
            db_item["indexes"] = list(idx_map.values())

            con.close()
        except Exception as e:
            db_item["error"] = str(e)
            result["errors"].append({"database": db_name, "error": str(e)})

        db_item["objectCount"] = len(db_item["objects"])
        db_item["columnCount"] = sum(len(obj["columns"]) for obj in db_item["objects"])
        result["databases"].append(db_item)

    SCHEMA_INDEX_FILE.parent.mkdir(parents=True, exist_ok=True)
    SCHEMA_INDEX_FILE.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    return result


def load_winworker_schema_index():
    if not SCHEMA_INDEX_FILE.exists():
        return None
    try:
        return json.loads(SCHEMA_INDEX_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None


def search_winworker_schema_index(query, limit=100):
    index = load_winworker_schema_index()
    if not index:
        return {"ok": False, "error": "SQL-Strukturindex fehlt. Zuerst /schema-index/rebuild aufrufen."}

    terms = [t for t in re.split(r"\\s+", str(query or "").strip().lower()) if t]
    if not terms:
        return {"ok": True, "query": query, "hits": [], "generatedAt": index.get("generatedAt")}

    hits = []
    for db in index.get("databases", []):
        db_name = str(db.get("name") or "")
        for obj in db.get("objects", []):
            schema = str(obj.get("schema") or "")
            name = str(obj.get("name") or "")
            for col in obj.get("columns", []):
                col_name = str(col.get("name") or "")
                hay = f"{db_name} {schema} {name} {col_name} {col.get('dataType','')}".lower()
                if all(term in hay for term in terms):
                    hits.append({
                        "database": db_name,
                        "schema": schema,
                        "object": name,
                        "objectType": obj.get("type"),
                        "column": col_name,
                        "dataType": col.get("dataType"),
                        "nullable": col.get("nullable"),
                        "primaryKey": col.get("primaryKey"),
                    })
                    if len(hits) >= max(1, min(int(limit or 100), 500)):
                        return {"ok": True, "query": query, "hits": hits, "generatedAt": index.get("generatedAt")}

    return {"ok": True, "query": query, "hits": hits, "generatedAt": index.get("generatedAt")}




def ww_hours_fusion_source(project_indices):
    """
    Liefert WinWorker-Stunden als Rohmaterial für die Fusion mit KRISTINE.

    Regel:
    - relevante Mitarbeiter/Tage werden über die angefragten Projekte bestimmt
    - für diese Mitarbeiter/Tage werden ALLE produktiven Projektstunden des Tages
      berücksichtigt, damit die 15 Minuten korrekt proportional verteilt werden
    - pro MA + Tag werden maximal 0,25 h abgezogen
    - die Mitarbeiteridentität kommt über
      Stundenmitschreibung.MAIndex = LohnEmpfaenger.StammIndex
      und LohnEmpfaenger.sMANr = Fink-Personalnummer
    """
    ids = sorted({int(x) for x in project_indices if x is not None})
    if not ids:
        return []

    placeholders = ",".join("?" for _ in ids)
    con = sql_connection("WinWorker_Projekte_Standard")
    cur = con.cursor()

    sql = f"""
        WITH RelevantDays AS (
            SELECT DISTINCT
                sm.MAIndex,
                CAST(sm.Tag AS date) AS Arbeitstag
            FROM WinWorker_Mitschreibung_Standard.dbo.Stundenmitschreibung AS sm
            WHERE sm.ProjektIndex IN ({placeholders})
              AND sm.MAIndex IS NOT NULL
              AND sm.Tag IS NOT NULL
              AND ISNULL(sm.bNichtAuswerten, 0) = 0
        ),
        DayProject AS (
            SELECT
                sm.MAIndex,
                CAST(sm.Tag AS date) AS Arbeitstag,
                sm.ProjektIndex,
                SUM(CAST(ISNULL(sm.dStundenErfasst, 0) AS decimal(18,6))) AS RawHours
            FROM WinWorker_Mitschreibung_Standard.dbo.Stundenmitschreibung AS sm
            INNER JOIN RelevantDays AS rd
                ON rd.MAIndex = sm.MAIndex
               AND rd.Arbeitstag = CAST(sm.Tag AS date)
            WHERE sm.ProjektIndex IS NOT NULL
              AND ISNULL(sm.bNichtAuswerten, 0) = 0
              AND ISNULL(sm.bUnproduktiv, 0) = 0
            GROUP BY
                sm.MAIndex,
                CAST(sm.Tag AS date),
                sm.ProjektIndex
        ),
        DayTotals AS (
            SELECT
                MAIndex,
                Arbeitstag,
                SUM(RawHours) AS TotalRawHours
            FROM DayProject
            GROUP BY MAIndex, Arbeitstag
        )
        SELECT
            dp.MAIndex,
            LTRIM(RTRIM(ISNULL(le.sMANr, ''))) AS FinkNumber,
            LTRIM(RTRIM(ISNULL(le.sVorname, ''))) AS FirstName,
            LTRIM(RTRIM(ISNULL(le.sName, ''))) AS LastName,
            dp.Arbeitstag,
            dp.ProjektIndex,
            p.sProjektNummer,
            CAST(dp.RawHours AS decimal(18,6)) AS RawHours,
            CAST(dt.TotalRawHours AS decimal(18,6)) AS TotalDayHours,
            CAST(
                CASE
                    WHEN dt.TotalRawHours <= 0 THEN dp.RawHours
                    ELSE dp.RawHours
                       - (
                           CASE
                               WHEN dt.TotalRawHours < CAST(0.25 AS decimal(18,6))
                                   THEN dt.TotalRawHours
                               ELSE CAST(0.25 AS decimal(18,6))
                           END
                           * (dp.RawHours / dt.TotalRawHours)
                         )
                END
                AS decimal(18,6)
            ) AS NetHours,
            CAST(
                CASE
                    WHEN dt.TotalRawHours <= 0 THEN 0
                    ELSE (
                        CASE
                            WHEN dt.TotalRawHours < CAST(0.25 AS decimal(18,6))
                                THEN dt.TotalRawHours
                            ELSE CAST(0.25 AS decimal(18,6))
                        END
                        * (dp.RawHours / dt.TotalRawHours)
                    )
                END
                AS decimal(18,6)
            ) AS BreakHours
        FROM DayProject AS dp
        INNER JOIN DayTotals AS dt
            ON dt.MAIndex = dp.MAIndex
           AND dt.Arbeitstag = dp.Arbeitstag
        LEFT JOIN WinWorker_Personal_Standard.dbo.LohnEmpfaenger AS le
            ON le.StammIndex = dp.MAIndex
        LEFT JOIN dbo.Projekte AS p
            ON p.ProjektIndex = dp.ProjektIndex
        WHERE dp.ProjektIndex IN ({placeholders})
        ORDER BY
            dp.Arbeitstag,
            dp.MAIndex,
            dp.ProjektIndex
    """

    rows = cur.execute(sql, *(ids + ids)).fetchall()
    con.close()

    result = []
    for row in rows:
        result.append({
            "maIndex": int(row.MAIndex) if row.MAIndex is not None else None,
            "finkNumber": row.FinkNumber or "",
            "employeeName": " ".join(
                x for x in [row.FirstName or "", row.LastName or ""] if x
            ).strip(),
            "date": clean_date(row.Arbeitstag),
            "projectIndex": int(row.ProjektIndex) if row.ProjektIndex is not None else None,
            "projectNumber": row.sProjektNummer or "",
            "rawHours": float(row.RawHours or 0),
            "totalDayHours": float(row.TotalDayHours or 0),
            "netHours": float(row.NetHours or 0),
            "breakHours": float(row.BreakHours or 0),
        })

    return result



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


def validate_indexed_pdf_path(raw_path):
    """
    Remote-Ausgabe nur für PDFs, die tatsächlich im KRISTINE-PDF-Index stehen.
    Dadurch kann ein Client nicht einfach irgendeinen anderen PDF-Pfad des PCs
    erraten und abrufen.
    """
    path = validate_pdf_path(raw_path)

    con = sqlite3.connect(DB)
    try:
        row = con.execute(
            "SELECT 1 FROM pdf_index WHERE path = ? LIMIT 1",
            (str(path),)
        ).fetchone()
    finally:
        con.close()

    if not row:
        raise PermissionError("PDF ist nicht im KRISTINE-Archivindex")
    return path



MOBILE_PAGE = r"""
<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#111111">
<title>KRISTINE · The Brain</title>
<style>
:root{
  --bg:#0e0f11;
  --panel:#17191d;
  --panel2:#20232a;
  --text:#f5f7fa;
  --muted:#aab0bb;
  --line:#2c313a;
  --accent:#ffffff;
  --good:#9fe0b4;
  --warn:#ffd38a;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
body{min-height:100vh}
.wrap{max-width:760px;margin:0 auto;padding:calc(18px + env(safe-area-inset-top)) 16px calc(34px + env(safe-area-inset-bottom))}
.brand{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:18px}
.brand h1{margin:0;font-size:28px;letter-spacing:-.7px}
.brand small{color:var(--muted);font-weight:600}
.hero{background:linear-gradient(180deg,var(--panel),#131519);border:1px solid var(--line);border-radius:22px;padding:16px;box-shadow:0 14px 40px rgba(0,0,0,.22)}
.searchrow{display:flex;gap:10px}
input[type=search]{width:100%;border:1px solid var(--line);background:#0d0f12;color:var(--text);border-radius:16px;padding:15px 16px;font-size:17px;outline:none}
input[type=search]:focus{border-color:#5f6774}
button{border:0;border-radius:16px;padding:0 18px;background:var(--accent);color:#111;font-size:16px;font-weight:800}
.meta{margin-top:10px;color:var(--muted);font-size:13px;min-height:18px}
.section{margin-top:18px}
.section h2{font-size:14px;text-transform:uppercase;letter-spacing:.12em;color:#d7dbe1;margin:0 0 10px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:14px;margin-bottom:10px}
.project-title{font-size:18px;font-weight:800;line-height:1.2}
.project-no{display:inline-block;margin-top:5px;font-size:12px;font-weight:800;background:var(--panel2);padding:5px 8px;border-radius:999px;color:#dfe3e8}
.sub{color:var(--muted);margin-top:8px;font-size:14px;line-height:1.45}
.metrics{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.pill{background:#111318;border:1px solid var(--line);border-radius:999px;padding:7px 9px;font-size:12px;color:#dfe3e8}
.doc{display:grid;grid-template-columns:76px 1fr;gap:12px;align-items:start}
.thumb{width:76px;height:102px;border-radius:10px;object-fit:cover;background:#0d0f12;border:1px solid var(--line)}
.docname{font-weight:750;line-height:1.3;word-break:break-word}
.doctype{margin-top:4px;color:#c8cdd5;font-size:13px}
.docmeta{margin-top:6px;color:var(--muted);font-size:12px}
.actions{display:flex;gap:8px;margin-top:10px}
a.action{display:inline-flex;align-items:center;justify-content:center;text-decoration:none;background:#f5f5f5;color:#111;border-radius:12px;padding:9px 12px;font-size:13px;font-weight:800}
.empty{color:var(--muted);background:var(--panel);border:1px dashed var(--line);border-radius:16px;padding:18px}
.loader{display:none;margin-top:12px;color:var(--muted)}
.error{color:#ffb3b3}
.footer{margin-top:24px;text-align:center;color:#6f7681;font-size:12px}
@media (max-width:480px){
  .brand h1{font-size:25px}
  .searchrow{display:grid;grid-template-columns:1fr}
  button{height:50px}
}
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">
    <div>
      <small>KRISTINE</small>
      <h1>The Brain</h1>
    </div>
    <small>Archiv · mobil</small>
  </div>

  <div class="hero">
    <div class="searchrow">
      <input id="q" type="search" placeholder="Baustelle, Kunde, Nummer, Adresse …" autocomplete="off">
      <button id="go">Suchen</button>
    </div>
    <div class="meta" id="meta">WinWorker + PDF-Archiv</div>
    <div class="loader" id="loader">Suche läuft …</div>
  </div>

  <div class="section" id="projectsSection" hidden>
    <h2>Projekte</h2>
    <div id="projects"></div>
  </div>

  <div class="section" id="docsSection" hidden>
    <h2>Dokumente</h2>
    <div id="docs"></div>
  </div>

  <div class="footer">Privater Zugriff über Tailscale</div>
</div>

<script>
const q = document.getElementById('q');
const go = document.getElementById('go');
const meta = document.getElementById('meta');
const loader = document.getElementById('loader');
const projects = document.getElementById('projects');
const docs = document.getElementById('docs');
const ps = document.getElementById('projectsSection');
const ds = document.getElementById('docsSection');

function esc(v){
  return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function money(v){
  if(v===null || v===undefined || v==='') return null;
  try { return new Intl.NumberFormat('de-AT',{style:'currency',currency:'EUR'}).format(Number(v)); }
  catch { return v; }
}
function num(v){
  if(v===null || v===undefined || v==='') return null;
  return new Intl.NumberFormat('de-AT',{maximumFractionDigits:2}).format(Number(v));
}
function urlFor(path, p){
  return path + '?path=' + encodeURIComponent(p);
}
function renderProject(p){
  const title = p.title || p.site || p.projectDescription || p.customer || 'Projekt';
  const customer = [p.company, p.customer].filter(Boolean).join(' · ');
  const addr = p.address || '';
  const h = num(p.hoursTotal);
  const n = money(p.netInvoiced);
  let metrics = '';
  if(h) metrics += `<span class="pill">${esc(h)} h IST</span>`;
  if(n) metrics += `<span class="pill">${esc(n)} netto</span>`;
  return `<div class="card">
    <div class="project-title">${esc(title)}</div>
    ${p.projectNumber ? `<span class="project-no">${esc(p.projectNumber)}</span>` : ''}
    ${customer ? `<div class="sub">${esc(customer)}</div>` : ''}
    ${addr ? `<div class="sub">${esc(addr)}</div>` : ''}
    ${metrics ? `<div class="metrics">${metrics}</div>` : ''}
  </div>`;
}
function renderDoc(d){
  const pd = d.printDate ? d.printDate.split('-').reverse().join('.') : '';
  return `<div class="card doc">
    <img class="thumb" loading="lazy" src="${urlFor('/thumb', d.path)}" alt="">
    <div>
      <div class="docname">${esc(d.filename || 'Dokument')}</div>
      ${d.dokumenttyp ? `<div class="doctype">${esc(d.dokumenttyp)}</div>` : ''}
      ${pd ? `<div class="docmeta">${esc(pd)}</div>` : ''}
      <div class="actions">
        <a class="action" href="${urlFor('/pdf', d.path)}" target="_blank" rel="noopener">PDF öffnen</a>
      </div>
    </div>
  </div>`;
}
async function search(){
  const term = q.value.trim();
  if(!term){ q.focus(); return; }
  loader.style.display='block';
  meta.textContent='Suche läuft …';
  ps.hidden=true; ds.hidden=true;
  projects.innerHTML=''; docs.innerHTML='';
  try{
    const r = await fetch('/search?q='+encodeURIComponent(term), {cache:'no-store'});
    if(!r.ok) throw new Error('HTTP '+r.status);
    const data = await r.json();
    if(!data.ok) throw new Error(data.error || 'Fehler');

    const pp = data.projects || [];
    const dd = data.documents || [];
    meta.textContent = `${pp.length} Projekte · ${dd.length} Dokumente`;

    ps.hidden=false; ds.hidden=false;
    projects.innerHTML = pp.length ? pp.map(renderProject).join('') : '<div class="empty">Keine Projekte gefunden.</div>';
    docs.innerHTML = dd.length ? dd.map(renderDoc).join('') : '<div class="empty">Keine Dokumente gefunden.</div>';
  }catch(e){
    meta.innerHTML='<span class="error">Suche fehlgeschlagen: '+esc(e.message)+'</span>';
  }finally{
    loader.style.display='none';
  }
}
go.addEventListener('click', search);
q.addEventListener('keydown', e => { if(e.key==='Enter') search(); });
q.focus();
</script>
</body>
</html>
"""


@app.get("/")
def mobile_home():
    return render_template_string(MOBILE_PAGE)


@app.get("/mobile")
def mobile_home_alias():
    return render_template_string(MOBILE_PAGE)


@app.get("/status")
def status():
    return jsonify({
        "ok": True,
        "connector": "kristine-archive",
        "version": "0.9.9",
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




@app.route("/schema-index/rebuild", methods=["GET", "POST"])
def schema_index_rebuild():
    try:
        data = build_winworker_schema_index()
        return jsonify({
            "ok": True,
            "generatedAt": data.get("generatedAt"),
            "databaseCount": data.get("databaseCount"),
            "indexedDatabases": len(data.get("databases", [])),
            "errors": data.get("errors", []),
            "file": str(SCHEMA_INDEX_FILE),
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/schema-index/status")
def schema_index_status():
    data = load_winworker_schema_index()
    if not data:
        return jsonify({"ok": True, "exists": False, "file": str(SCHEMA_INDEX_FILE)})

    return jsonify({
        "ok": True,
        "exists": True,
        "generatedAt": data.get("generatedAt"),
        "databaseCount": data.get("databaseCount"),
        "indexedDatabases": len(data.get("databases", [])),
        "errors": data.get("errors", []),
        "file": str(SCHEMA_INDEX_FILE),
    })


@app.get("/schema-index/search")
def schema_index_search():
    q = str(request.args.get("q") or "").strip()
    limit = request.args.get("limit", 100)
    try:
        return jsonify(search_winworker_schema_index(q, limit))
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/schema-index/table")
def schema_index_table():
    db_name = str(request.args.get("db") or "").strip().lower()
    table_name = str(request.args.get("table") or "").strip().lower()
    data = load_winworker_schema_index()
    if not data:
        return jsonify({"ok": False, "error": "SQL-Strukturindex fehlt."}), 404

    matches = []
    for db in data.get("databases", []):
        if db_name and str(db.get("name") or "").lower() != db_name:
            continue
        for obj in db.get("objects", []):
            if table_name and str(obj.get("name") or "").lower() != table_name:
                continue
            obj_name = str(obj.get("name") or "")
            matches.append({
                "database": db.get("name"),
                **obj,
                "foreignKeys": [
                    fk for fk in db.get("foreignKeys", [])
                    if f".{obj_name}." in str(fk.get("from"))
                    or f".{obj_name}." in str(fk.get("to"))
                ],
                "indexes": [
                    idx for idx in db.get("indexes", [])
                    if str(idx.get("table") or "").lower() == obj_name.lower()
                ],
            })

    return jsonify({
        "ok": True,
        "matches": matches,
        "generatedAt": data.get("generatedAt"),
    })



@app.post("/hours-fusion-source")
def hours_fusion_source():
    try:
        data = request.get_json(silent=True) or {}
        project_indices = data.get("projectIndices") or []
        rows = ww_hours_fusion_source(project_indices)
        return jsonify({
            "ok": True,
            "rows": rows,
            "count": len(rows),
        })
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



@app.get("/ww-hours-schema")
def ww_hours_schema():
    try:
        con = sql_connection("WinWorker_Mitschreibung_Standard")
        cur = con.cursor()
        rows = cur.execute("""
            SELECT COLUMN_NAME, DATA_TYPE, ORDINAL_POSITION
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = 'dbo'
              AND TABLE_NAME = 'Stundenmitschreibung'
            ORDER BY ORDINAL_POSITION
        """).fetchall()
        con.close()
        return jsonify({
            "ok": True,
            "table": "WinWorker_Mitschreibung_Standard.dbo.Stundenmitschreibung",
            "columns": [
                {"name": row.COLUMN_NAME, "dataType": row.DATA_TYPE, "position": row.ORDINAL_POSITION}
                for row in rows
            ],
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/ww-hours-sample/<int:project_index>")
def ww_hours_sample(project_index):
    try:
        con = sql_connection("WinWorker_Mitschreibung_Standard")
        cur = con.cursor()
        cur.execute("""
            SELECT TOP 5 *
            FROM WinWorker_Mitschreibung_Standard.dbo.Stundenmitschreibung
            WHERE ProjektIndex = ?
        """, project_index)
        columns = [desc[0] for desc in cur.description]
        rows = cur.fetchall()
        con.close()

        def safe(value):
            if value is None or isinstance(value, (str, int, float, bool)):
                return value
            return str(value)

        return jsonify({
            "ok": True,
            "projectIndex": project_index,
            "columns": columns,
            "rows": [{columns[i]: safe(row[i]) for i in range(len(columns))} for row in rows],
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
        path = validate_indexed_pdf_path(request.args.get("path"))
        with pymupdf.open(path) as doc:
            if len(doc) < 1:
                raise ValueError("PDF hat keine Seiten")
            page = doc[0]
            pix = page.get_pixmap(matrix=pymupdf.Matrix(0.72, 0.72), alpha=False)
            png = pix.tobytes("png")

        return send_file(BytesIO(png), mimetype="image/png", max_age=300)
    except (ValueError, FileNotFoundError, PermissionError):
        return ("", 404)
    except Exception as e:
        print("Thumbnail-Fehler:", e)
        return ("", 500)


@app.get("/pdf")
def pdf_inline():
    """
    Liefert ein im KRISTINE-Index vorhandenes PDF direkt an Handy/Browser.
    /open bleibt lokal und öffnet weiterhin nur am Windows-PC.
    """
    try:
        path = validate_indexed_pdf_path(request.args.get("path"))
        return send_file(
            path,
            mimetype="application/pdf",
            as_attachment=False,
            download_name=path.name,
            conditional=True,
            max_age=0,
        )
    except (ValueError, FileNotFoundError, PermissionError):
        return jsonify({"ok": False, "error": "PDF nicht gefunden"}), 404
    except Exception as e:
        print("PDF-Ausgabe-Fehler:", e)
        return jsonify({"ok": False, "error": "PDF konnte nicht geöffnet werden"}), 500


if __name__ == "__main__":
    print()
    print("KRISTINE ARCHIV CONNECTOR")
    print("-------------------------")
    print("Status : http://127.0.0.1:5051/status")
    print("Suche  : http://127.0.0.1:5051/search?q=6844%20Fusonic")
    print("Schema : http://127.0.0.1:5051/schema-hints")
    print("Version: 0.9.9 - Mobile The Brain Oberfläche")
    print(f"Handy  : http://{TAILSCALE_IP}:5051/status")
    print("Schema-Index rebuild: http://127.0.0.1:5051/schema-index/rebuild")
    print("Schema-Index status : http://127.0.0.1:5051/schema-index/status")
    print("Schema-Index search : http://127.0.0.1:5051/schema-index/search?q=personalnummer")
    print("Schema-Index table  : http://127.0.0.1:5051/schema-index/table?db=WinWorker_Mitschreibung_Standard&table=Stundenmitschreibung")
    print("Hours fusion        : POST http://127.0.0.1:5051/hours-fusion-source")
    print()

    if not TAILSCALE_IP:
        raise RuntimeError("KRISTINE_TAILSCALE_IP fehlt")

    # Zwei gezielte Listener:
    # 1) localhost für bestehende interne KRISTINE-Aufrufe
    # 2) nur die private Tailscale-IP für das Handy
    # Niemals 0.0.0.0 verwenden.
    serve(
        app,
        listen=f"127.0.0.1:5051 {TAILSCALE_IP}:5051",
        threads=8,
        expose_tracebacks=False,
        clear_untrusted_proxy_headers=True,
        ident="KRISTINE",
    )