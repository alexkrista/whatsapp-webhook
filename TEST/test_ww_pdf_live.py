import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "archive_connector_ww_pdf_test",
    ROOT / "archive-connector.py",
)
ARCHIVE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ARCHIVE)


class WinWorkerLivePdfTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.old_db = ARCHIVE.DB
        self.old_dokman = ARCHIVE.DOKMAN_ROOT
        ARCHIVE.DB = root / "index.db"
        ARCHIVE.DOKMAN_ROOT = root / "Dokman"
        con = sqlite3.connect(ARCHIVE.DB)
        try:
            con.execute("""
                CREATE TABLE pdf_index (
                    filename TEXT, path TEXT, dokumenttyp TEXT, modified REAL,
                    size INTEGER, fingerprint TEXT, text TEXT, source TEXT,
                    doc_year INTEGER, doc_month INTEGER, logical_id TEXT,
                    original_path TEXT, file_size INTEGER, indexed_at TEXT
                )
            """)
            con.commit()
        finally:
            con.close()

    def tearDown(self):
        ARCHIVE.DB = self.old_db
        ARCHIVE.DOKMAN_ROOT = self.old_dokman
        self.temp.cleanup()

    def test_fresh_ww_pdf_is_found_and_indexed_immediately(self):
        doc_id = "11502600999"
        folder = ARCHIVE.DOKMAN_ROOT / "2026" / "08"
        folder.mkdir(parents=True)
        pdf = folder / f"{doc_id}.pdf"
        original = folder / f"{doc_id}_Original.pdf"
        pdf.write_bytes(b"%PDF-1.4\n%%EOF\n")
        original.write_bytes(b"%PDF-1.4\n%%EOF\n")

        found = ARCHIVE._pdf_paths_by_docids(
            [doc_id],
            invoice_dates={doc_id: "2026-08-31 08:09:26"},
        )[doc_id]

        self.assertEqual(found["pdfPath"], str(pdf))
        self.assertEqual(found["originalPath"], str(original))
        self.assertEqual(ARCHIVE.validate_indexed_pdf_path(str(pdf)), pdf)
        con = sqlite3.connect(ARCHIVE.DB)
        try:
            row = con.execute(
                "SELECT source, logical_id, doc_year, doc_month FROM pdf_index"
            ).fetchone()
        finally:
            con.close()
        self.assertEqual(row, ("EINGANG", doc_id, 2026, 8))

    def test_unreferenced_filename_is_not_guessed(self):
        found = ARCHIVE._pdf_paths_by_docids(
            ["not-a-ww-document"],
            invoice_dates={"not-a-ww-document": "2026-08-31"},
        )
        self.assertEqual(found, {})


if __name__ == "__main__":
    unittest.main()
