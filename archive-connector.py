from flask import Flask, request, jsonify
import sqlite3
from pathlib import Path

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

    sql += """
        ORDER BY modified DESC
        LIMIT 200
    """

    rows = con.execute(sql, params).fetchall()
    con.close()

    return [dict(row) for row in rows]


@app.get("/status")
def status():
    return jsonify({
        "ok": True,
        "connector": "kristine-archive",
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


if __name__ == "__main__":
    print()
    print("KRISTINE ARCHIV CONNECTOR")
    print("-------------------------")
    print("Status: http://127.0.0.1:5051/status")
    print("Suche : http://127.0.0.1:5051/search?q=6844%20Fusonic")
    print()

    app.run(
        host="127.0.0.1",
        port=5051,
        debug=False
    )