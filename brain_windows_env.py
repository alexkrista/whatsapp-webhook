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

    if not os.environ.get("KRISTINE_SQL_PASSWORD", "").strip():
        # SYSTEM services cannot read the interactive user's environment.
        # This machine-DPAPI blob is provisioned by an administrator and its
        # directory permits only SYSTEM and Administrators.
        from pathlib import Path
        file = Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "KRISTA" / "brain-runtime" / "sql-password.dpapi"
        if file.is_file():
            from brain_konfipay import protect
            value = protect(file.read_bytes(), decrypt=True).decode("utf-8")
            if value.strip():
                os.environ["KRISTINE_SQL_PASSWORD"] = value
