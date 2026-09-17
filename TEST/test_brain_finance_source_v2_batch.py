import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from brain_finance_source_v2 import FinanceStore, SQL_SERVER_ID_BATCH


class ColumnRow(tuple):
    def __new__(cls, name):
        return super().__new__(cls, (name,))

    @property
    def COLUMN_NAME(self):
        return self[0]


class Cursor:
    def __init__(self):
        self.rows = []
        self.batches = []

    def execute(self, sql, *params):
        if "INFORMATION_SCHEMA.COLUMNS" in sql:
            self.rows = [ColumnRow("SkontoProzent")]
        else:
            assert len(params) <= SQL_SERVER_ID_BATCH
            self.batches.append(list(params))
            self.rows = [SimpleNamespace(cID=value, sk_percent=2.0) for value in params]
        return self

    def fetchall(self):
        return self.rows


class Connection:
    def __init__(self):
        self.cur = Cursor()
        self.closed = False

    def cursor(self):
        return self.cur

    def close(self):
        self.closed = True


def test_large_winworker_list_is_batched_below_sql_server_limit():
    rows = [{"id": f"ww:{value}", "invoiceDate": "2026-09-17", "amount": 100.0} for value in range(1, 2506)]
    connection = Connection()
    store = FinanceStore({"sql_connection": lambda _database: connection})
    with patch("brain_finance_source_v2._BaseFinanceStore.ww", return_value=rows):
        result = store.ww(True)
    assert [len(batch) for batch in connection.cur.batches] == [1000, 1000, 505]
    assert len({value for batch in connection.cur.batches for value in batch}) == 2505
    assert len(result) == 2505
    assert all(row["skontoEnabled"] for row in result)
    assert connection.closed


if __name__ == "__main__":
    test_large_winworker_list_is_batched_below_sql_server_limit()
    print("OK: WinWorker-Skonto-Abfrage wird unter der SQL-Server-Grenze gestueckelt.")
