from flask import Flask, request, jsonify, send_file
import sqlite3
from pathlib import Path
from io import BytesIO
import os

import pymupdf

app = Flask(__name__)

DB = Path(r"N:\OneDrive\Dokumente\Kristine\Daten\kristine_pdf_index_v2.db")


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
    return jsonify({
        "ok": True,
        "connector": "kristine-archive",
        "version": "0.2",
        "pdfIndex": str(DB),
        "pdfIndexExists": DB.exists()
    })


@app.get("/search")
def search():
    q = str(request.args.get("q", "")).strip()

    if not q:
        return jsonify({
            "ok": True,
            "query": "",
            "documents": []
        })

    terms = [x.strip() for x in q.split() if x.strip()]

    try:
        documents = search_pdf(terms)

        return jsonify({
            "ok": True,
            "query": q,
            "terms": terms,
            "documents": documents
        })

    except Exception as e:
        return jsonify({
            "ok": False,
            "error": str(e)
        }), 500


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
                matrix=pymupdf.Matrix(0.55, 0.55),
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
    print("Version: 0.2 - Snippet + Öffnen + Miniatur")
    print()

    app.run(
        host="127.0.0.1",
        port=5051,
        debug=False
    )
