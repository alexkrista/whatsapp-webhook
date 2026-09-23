"""Restore the current Windows user's configured SQL setting for fresh services."""
import os


def restore_sql_password():
    """Use only the existing current-user setting; never log or replace a secret."""
    if os.environ.get("KRISTINE_SQL_PASSWORD", "").strip() or os.name != "nt":
        return
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            value, kind = winreg.QueryValueEx(key, "KRISTINE_SQL_PASSWORD")
        if kind in (winreg.REG_SZ, winreg.REG_EXPAND_SZ) and isinstance(value, str) and value.strip():
            os.environ["KRISTINE_SQL_PASSWORD"] = value
    except OSError:
        pass
