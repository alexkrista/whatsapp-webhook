# coding: utf-8
"""Brain-Laufzeitstatus + Bootstrap fuer den separaten KRISTA Dienstemanager."""
from __future__ import annotations


import hmac
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path


BRAIN_CONNECTOR_VERSION = "0.14.62"
SERVICE_MANAGER_PORT = int(os.environ.get("KRISTA_SERVICE_MANAGER_PORT", "8765"))
REPO_ROOT = Path(__file__).resolve().parent
RUNTIME_DIR = Path(tempfile.gettempdir()) / "krista-service-manager"
RUNTIME_FILE = RUNTIME_DIR / "brain-runtime.json"
MANAGER_TASK_NAME = "KRISTA Dienstemanager"




def _git_head() -> str:
    try:
        cp = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=3,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return cp.stdout.strip() if cp.returncode == 0 else ""
    except Exception:
