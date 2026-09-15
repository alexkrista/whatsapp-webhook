import ast
import re
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "archive-connector.py").read_text(encoding="utf-8")
TREE = ast.parse(SOURCE)
FUNCTION_NAMES = {
    "_norm_supplier",
    "_normalize_project_identifier",
    "canonical_project_document_type",
    "_project_pdf_reference_state",
    "_project_pdf_primary_book_number",
    "_project_pdf_fallback_score",
    "project_document_catalog",
}
FUNCTIONS = {"re": re}
selected = [
    node
    for node in TREE.body
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    and node.name in FUNCTION_NAMES
]
exec(compile(ast.Module(body=selected, type_ignores=[]), str(ROOT / "archive-connector.py"), "exec"), FUNCTIONS)
CATALOG = FUNCTIONS["project_document_catalog"]
FALLBACK_SCORE = FUNCTIONS["_project_pdf_fallback_score"]


def book(number, doc_id):
    return {
        "bookNumber": number,
        "documentType": "Teilrechnung",
        "docIds": [doc_id],
        "wwBookId": doc_id,
        "wwBookIds": [doc_id],
        "documentDate": "2026-05-01",
        "netAmount": 1000,
    }


def pdf(path, project, number, title="Abschlagsrechnung", previous=""):
    return {
        "filename": Path(path).name,
        "path": path,
        "dokumenttyp": "Weitere WW-Belege",
        "_raw_text": (
            f"Projekt: {project}\n{title}\nNr. : {number}\n{previous}"
        ),
        "printDate": "2026-05-01",
        "pdfFound": True,
    }


class ProjectDocumentCatalogTests(unittest.TestCase):
    def test_same_book_numbers_from_other_projects_are_rejected(self):
        books = [
            book("202603010", "book-1"),
            book("202604001", "book-2"),
            book("202605001", "book-3"),
        ]
        correct = [
            pdf("C:/archive/vonblon-1.pdf", "26025", "202603010"),
            pdf("C:/archive/vonblon-2.pdf", "26025", "202604001"),
            pdf(
                "C:/archive/vonblon-3.pdf",
                "26025",
                "202605001",
                previous="1. Teilrechnung 202603010\n2. Teilrechnung 202604001",
            ),
        ]
        wrong_exact = {
            "book-2": [
                pdf(
                    "C:/archive/202604001_26025.pdf",
                    "26057",
                    "202607004",
                    title="Auftragsbestätigung",
                    previous="Angebot Nr.: 202604001",
                )
            ],
            "book-3": [
                pdf(
                    "C:/archive/202605001_26025.pdf",
                    "26063",
                    "202605001",
                    title="Auftragsbestätigung",
                )
            ],
        }

        replacements = {
            "_project_by_index": lambda _index: {
                "projectIndex": 26025,
                "projectNumber": "26025",
            },
            "_ww_project_books": lambda _index: books,
            "_project_pdf_rows_by_docids": lambda _ids: wrong_exact,
            "_project_pdf_rows": lambda _project, _numbers: correct,
            "_merged_project_document_type": lambda selected_book, _pdf: selected_book["documentType"],
            "_project_type_priority": lambda _kind: 1,
        }
        with patch.dict(FUNCTIONS, replacements):
            result = CATALOG(26025)

        linked = {
            row["bookNumber"]: row["path"]
            for row in result["documents"]
            if row.get("bookNumber")
        }
        self.assertEqual(
            linked,
            {
                "202603010": "C:/archive/vonblon-1.pdf",
                "202604001": "C:/archive/vonblon-2.pdf",
                "202605001": "C:/archive/vonblon-3.pdf",
            },
        )
        self.assertNotIn("gohm", " ".join(linked.values()).lower())

    def test_current_invoice_number_beats_previous_invoice_mentions(self):
        third = pdf(
            "C:/archive/guid.pdf",
            "26025",
            "202605001",
            previous="Bisher 202603010 und 202604001",
        )
        numbers = ["202603010", "202604001", "202605001"]
        self.assertIsNone(
            FALLBACK_SCORE(
                third, book("202603010", "book-1"), "26025", numbers
            )
        )
        self.assertGreater(
            FALLBACK_SCORE(
                third, book("202605001", "book-3"), "26025", numbers
            ),
            0,
        )


if __name__ == "__main__":
    unittest.main()
