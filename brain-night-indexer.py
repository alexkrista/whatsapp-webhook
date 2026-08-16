from __future__ import annotations

import os
import re
import sys
import time
import json
import shutil
import sqlite3
import traceback
from pathlib import Path
from datetime import datetime

import pymupdf


# ============================================================
# KRISTINE / THE BRAIN - NACHT INDEXER V1.0
# ============================================================

DB = Path(r"N:\OneDrive\Dokumente\Kristine\Daten\kristine_pdf_index_v2.db")

WW_OUT = Path(r"\\srv-db01\WWDaten\PDF Output\Farben_Krista\Kundenexemplare")
DOKMAN_ROOT = Path(r"\\srv-db01\WWDaten\Dokman\{FF8BE8FE-F2DA-409B-B71B-8737C40B510F}")

LOG_DIR = DB.parent / "index_logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

RUN_ID = datetime.now().strftime("%Y%m%d_%H%M%S")
LOG_FILE = LOG_DIR / f"brain_index_{RUN_ID}.log"
SUMMARY_FILE = LOG_DIR / f"brain_index_{RUN_ID}_summary.json"

COMMIT_EVERY = 100
PRINT_EVERY = 50


def log(msg: str):
    line = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def connect():
    con = sqlite3.connect(DB, timeout=60)
    con.execute("PRAGMA busy_timeout=60000")
    # WAL ist auf OneDrive/Netzpfaden nicht immer ideal; DELETE ist konservativer.
    con.execute("PRAGMA journal_mode=DELETE")
    con.execute("PRAGMA synchronous=NORMAL")
    return con


def ensure_schema(con: sqlite3.Connection):
    con.execute("""
        CREATE TABLE IF NOT EXISTS pdf_index (
            filename TEXT,
            path TEXT,
            dokumenttyp TEXT,
            modified REAL,
            text TEXT
        )
    """)

    cols = {r[1] for r in con.execute("PRAGMA table_info(pdf_index)").fetchall()}
    additions = {
        "source": "TEXT",
        "doc_year": "INTEGER",
        "doc_month": "TEXT",
        "logical_id": "TEXT",
        "original_path": "TEXT",
        "file_size": "INTEGER",
        "indexed_at": "TEXT",
    }
    for name, typ in additions.items():
        if name not in cols:
            log(f"Schema-Erweiterung: + {name}")
            con.execute(f"ALTER TABLE pdf_index ADD COLUMN {name} {typ}")

    # Bestehende Dubletten verhindern wir künftig über die Pfadprüfung.
    con.execute("CREATE INDEX IF NOT EXISTS idx_pdf_index_path ON pdf_index(path)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_pdf_index_source ON pdf_index(source)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_pdf_index_logical_id ON pdf_index(logical_id)")
    con.commit()


def backup_db():
    if not DB.exists():
        log("Index existiert noch nicht - kein Backup nötig.")
        return None

    backup = DB.with_name(f"{DB.stem}_backup_{RUN_ID}{DB.suffix}")
    log(f"Backup wird erstellt: {backup.name}")
    src = sqlite3.connect(DB, timeout=60)
    dst = sqlite3.connect(backup)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    log("Backup fertig.")
    return backup


def pdf_text(path: Path) -> str:
    """Nur vorhandenen PDF-Text lesen. Kein OCR-Nachtlauf."""
    chunks = []
    with pymupdf.open(path) as doc:
        for page in doc:
            try:
                t = page.get_text("text") or ""
                if t:
                    chunks.append(t)
            except Exception:
                pass
    return "\n".join(chunks).strip()


def file_sig(path: Path):
    st = path.stat()
    return float(st.st_mtime), int(st.st_size)


def existing_row(con, path: Path):
    return con.execute(
        """SELECT rowid, modified, file_size, LENGTH(COALESCE(text,'')), source
           FROM pdf_index WHERE path=? ORDER BY rowid DESC LIMIT 1""",
        (str(path),)
    ).fetchone()


def upsert_document(
    con,
    *,
    path: Path,
    dokumenttyp: str,
    source: str,
    year: int | None = None,
    month: str | None = None,
    logical_id: str | None = None,
    original_path: str | None = None,
    force_text: bool = False,
):
    modified, size = file_sig(path)
    row = existing_row(con, path)

    # Bereits vorhandene Datei: Metadaten nachziehen. Text nur neu lesen,
    # wenn Datei geändert wurde oder Text leer ist.
    need_text = True
    if row:
        rowid, old_modified, old_size, text_len, old_source = row
        same = (
            old_modified is not None
            and abs(float(old_modified) - modified) < 0.01
            and (old_size is None or int(old_size) == size)
        )
        need_text = force_text or not same or not text_len

        text_value = None
        if need_text:
            text_value = pdf_text(path)

        if need_text:
            con.execute("""
                UPDATE pdf_index
                SET filename=?, dokumenttyp=?, modified=?, text=?, source=?,
                    doc_year=?, doc_month=?, logical_id=?, original_path=?,
                    file_size=?, indexed_at=?
                WHERE rowid=?
            """, (
                path.name, dokumenttyp, modified, text_value, source,
                year, month, logical_id, original_path, size,
                datetime.now().isoformat(timespec="seconds"), rowid
            ))
            return "updated_text"
        else:
            con.execute("""
                UPDATE pdf_index
                SET filename=?, dokumenttyp=?, source=?, doc_year=?, doc_month=?,
                    logical_id=?, original_path=?, file_size=?, indexed_at=?
                WHERE rowid=?
            """, (
                path.name, dokumenttyp, source, year, month,
                logical_id, original_path, size,
                datetime.now().isoformat(timespec="seconds"), rowid
            ))
            return "metadata"

    text_value = pdf_text(path)
    con.execute("""
        INSERT INTO pdf_index
        (filename, path, dokumenttyp, modified, text, source, doc_year, doc_month,
         logical_id, original_path, file_size, indexed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    """, (
        path.name, str(path), dokumenttyp, modified, text_value, source,
        year, month, logical_id, original_path, size,
        datetime.now().isoformat(timespec="seconds")
    ))
    return "inserted"


def parse_ww_meta(path: Path):
    rel = path.relative_to(WW_OUT)
    parts = rel.parts

    dokumenttyp = parts[0] if len(parts) >= 1 else "WW"
    year = None
    month = None

    for p in parts[1:]:
        if re.fullmatch(r"20\d{2}", p):
            year = int(p)
            break

    if year is not None:
        try:
            yi = parts.index(str(year))
            if yi + 1 < len(parts) - 1:
                month = parts[yi + 1]
        except ValueError:
            pass

    return dokumenttyp, year, month


def iter_pdfs(root: Path):
    if not root.exists():
        raise FileNotFoundError(f"Quelle nicht erreichbar: {root}")
    yield from root.rglob("*.pdf")


def index_ww(con, stats):
    log("")
    log("=== 1/2 WINWORKER AUSGANGSDOKUMENTE ===")
    log(str(WW_OUT))

    files = list(iter_pdfs(WW_OUT))
    stats["ww_found"] = len(files)
    log(f"Gefunden: {len(files):,} PDFs")

    for i, path in enumerate(files, 1):
        try:
            typ, year, month = parse_ww_meta(path)
            status = upsert_document(
                con,
                path=path,
                dokumenttyp=typ,
                source="WW",
                year=year,
                month=month,
            )
            stats[f"ww_{status}"] = stats.get(f"ww_{status}", 0) + 1
        except Exception as e:
            stats["ww_errors"] = stats.get("ww_errors", 0) + 1
            log(f"FEHLER WW: {path} :: {e}")

        if i % COMMIT_EVERY == 0:
            con.commit()
        if i % PRINT_EVERY == 0 or i == len(files):
            log(f"WW {i:,}/{len(files):,} ({i/len(files)*100:.1f} %)")

    con.commit()


def dokman_groups():
    """
    Pro Belegnummer genau EIN logischer Beleg.
    Bevorzugt die normale WinWorker-Datei als Haupt-PDF.
    _Original.pdf wird als original_path mitgeführt.
    Für die Volltextsuche wird zusätzlich Text aus dem Original ergänzt,
    falls dort Text vorhanden ist.
    """
    if not DOKMAN_ROOT.exists():
        raise FileNotFoundError(f"Quelle nicht erreichbar: {DOKMAN_ROOT}")

    groups = {}

    for path in DOKMAN_ROOT.rglob("*.pdf"):
        stem = path.stem
        is_original = stem.lower().endswith("_original")
        base = stem[:-9] if is_original else stem  # "_Original" = 9 Zeichen

        year = None
        for part in path.parts:
            if re.fullmatch(r"20\d{2}", part):
                year = int(part)

        key = (year, base)
        g = groups.setdefault(key, {
            "year": year,
            "logical_id": base,
            "processed": None,
            "original": None,
        })
        if is_original:
            g["original"] = path
        else:
            g["processed"] = path

    return list(groups.values())


def upsert_dokman_pair(con, group):
    processed = group["processed"]
    original = group["original"]
    primary = processed or original
    if primary is None:
        return "ignored"

    modified, size = file_sig(primary)
    row = existing_row(con, primary)

    # Beide Texte zusammenführen. Das bringt uns schon jetzt gute Volltextsuche,
    # ohne zwei Rechnungen im Brain zu zählen.
    def combined_text():
        texts = []
        for p in (processed, original):
            if p and p.exists():
                try:
                    t = pdf_text(p)
                    if t and t not in texts:
                        texts.append(t)
                except Exception:
                    pass
        return "\n\n".join(texts).strip()

    original_str = str(original) if original else None

    if row:
        rowid, old_modified, old_size, text_len, old_source = row
        same = (
            old_modified is not None
            and abs(float(old_modified) - modified) < 0.01
            and (old_size is None or int(old_size) == size)
        )
        if same and text_len:
            con.execute("""
                UPDATE pdf_index
                SET filename=?, dokumenttyp='Eingangsrechnung', source='EINGANG',
                    doc_year=?, logical_id=?, original_path=?, file_size=?, indexed_at=?
                WHERE rowid=?
            """, (
                primary.name, group["year"], group["logical_id"], original_str,
                size, datetime.now().isoformat(timespec="seconds"), rowid
            ))
            status = "metadata"
        else:
            con.execute("""
                UPDATE pdf_index
                SET filename=?, dokumenttyp='Eingangsrechnung', modified=?, text=?,
                    source='EINGANG', doc_year=?, logical_id=?, original_path=?,
                    file_size=?, indexed_at=?
                WHERE rowid=?
            """, (
                primary.name, modified, combined_text(), group["year"],
                group["logical_id"], original_str, size,
                datetime.now().isoformat(timespec="seconds"), rowid
            ))
            status = "updated_text"
    else:
        con.execute("""
            INSERT INTO pdf_index
            (filename, path, dokumenttyp, modified, text, source, doc_year, doc_month,
             logical_id, original_path, file_size, indexed_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            primary.name, str(primary), "Eingangsrechnung", modified, combined_text(),
            "EINGANG", group["year"], None, group["logical_id"], original_str,
            size, datetime.now().isoformat(timespec="seconds")
        ))
        status = "inserted"

    # Falls _Original bereits irgendwann separat im alten Index gelandet ist,
    # nicht löschen: nur als Duplikat markieren. So verlieren wir nichts.
    if original and processed:
        con.execute("""
            UPDATE pdf_index
            SET source='EINGANG_DUPLIKAT',
                logical_id=?,
                original_path=?
            WHERE path=? AND path<>?
        """, (group["logical_id"], str(original), str(original), str(primary)))

    return status


def index_dokman(con, stats):
    log("")
    log("=== 2/2 DOKMAN EINGANGSRECHNUNGEN ===")
    log(str(DOKMAN_ROOT))

    groups = dokman_groups()
    stats["eingang_logical_found"] = len(groups)
    stats["eingang_pdf_files_found"] = sum(
        (1 if g["processed"] else 0) + (1 if g["original"] else 0)
        for g in groups
    )
    log(
        f"Gefunden: {stats['eingang_pdf_files_found']:,} PDF-Dateien "
        f"= {len(groups):,} logische Belege"
    )

    for i, g in enumerate(groups, 1):
        try:
            status = upsert_dokman_pair(con, g)
            stats[f"eingang_{status}"] = stats.get(f"eingang_{status}", 0) + 1
        except Exception as e:
            stats["eingang_errors"] = stats.get("eingang_errors", 0) + 1
            log(f"FEHLER EINGANG {g.get('logical_id')}: {e}")

        if i % COMMIT_EVERY == 0:
            con.commit()
        if i % PRINT_EVERY == 0 or i == len(groups):
            log(f"EINGANG {i:,}/{len(groups):,} ({i/len(groups)*100:.1f} %)")

    con.commit()


def source_summary(con):
    rows = con.execute("""
        SELECT COALESCE(source,'ALT/UNBEKANNT') AS src, COUNT(*)
        FROM pdf_index
        GROUP BY COALESCE(source,'ALT/UNBEKANNT')
        ORDER BY 2 DESC
    """).fetchall()

    type_rows = con.execute("""
        SELECT COALESCE(source,'ALT/UNBEKANNT'), COALESCE(dokumenttyp,'?'), COUNT(*)
        FROM pdf_index
        GROUP BY COALESCE(source,'ALT/UNBEKANNT'), COALESCE(dokumenttyp,'?')
        ORDER BY 1, 3 DESC
    """).fetchall()

    return {
        "sources": [{"source": r[0], "count": r[1]} for r in rows],
        "types": [{"source": r[0], "type": r[1], "count": r[2]} for r in type_rows],
    }


def main():
    started = time.time()
    stats = {
        "started": datetime.now().isoformat(timespec="seconds"),
        "db": str(DB),
        "ww_root": str(WW_OUT),
        "dokman_root": str(DOKMAN_ROOT),
    }

    log("==========================================")
    log("KRISTINE / THE BRAIN - NACHT INDEXER V1.0")
    log("==========================================")
    log(f"Index: {DB}")

    backup = backup_db()
    stats["backup"] = str(backup) if backup else None

    con = connect()
    try:
        ensure_schema(con)

        index_ww(con, stats)
        index_dokman(con, stats)

        stats["summary"] = source_summary(con)
        stats["finished"] = datetime.now().isoformat(timespec="seconds")
        stats["duration_minutes"] = round((time.time() - started) / 60, 2)

        SUMMARY_FILE.write_text(
            json.dumps(stats, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )

        log("")
        log("==========================================")
        log("FERTIG")
        log("==========================================")
        for row in stats["summary"]["sources"]:
            log(f"{row['source']}: {row['count']:,}")
        log(f"Dauer: {stats['duration_minutes']} min")
        log(f"Zusammenfassung: {SUMMARY_FILE}")
        log("")
        log("WICHTIG: Kein OCR in diesem Lauf.")
        log("PDFs ohne eingebetteten Text bleiben im Index, können aber vorerst nur")
        log("über Dateiname/Pfad gefunden werden. OCR machen wir danach gezielt.")
    finally:
        con.commit()
        con.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("Abgebrochen durch Benutzer.")
        sys.exit(130)
    except Exception as e:
        log("ABBRUCH: " + str(e))
        log(traceback.format_exc())
        sys.exit(1)
