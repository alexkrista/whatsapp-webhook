"""Shared form settings; the unchanged invoice defines the defaults."""
from copy import deepcopy
import json
import logging
import math
import os
from pathlib import Path
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
DEFAULTS = json.loads((ROOT / "document-layout-defaults.json").read_text(encoding="utf-8"))
_last_check = 0
_cached = None


def clean_layout(value):
    result = deepcopy(DEFAULTS)
    groups = [(result, value, {"fontSizePt": (8, 13), "titleSizePt": (12, 24), "lineHeight": (1.1, 1.8), "paragraphGapMm": (1, 10), "sectionGapMm": (1, 20), "rowPaddingMm": (0, 4)})]
    for page in ("firstPage", "followingPages"):
        fields = {"topMm": (10, 40), "leftMm": (10, 28), "rightMm": (10, 28), "bottomMm": (25, 40), "logoWidthMm": (20, 80)}
        if page == "firstPage":
            fields.update(addressTopMm=(32, 60), addressHeightMm=(20, 35), bodyTopMm=(60, 105))
        groups.append((result[page], value.get(page, {}), fields))
    for target, source, fields in groups:
        for field, (low, high) in fields.items():
            number = float(source.get(field, target[field]))
            if not math.isfinite(number) or not low <= number <= high:
                raise ValueError(f"Ungültiger Formularwert: {field}")
            target[field] = number
    first = result["firstPage"]
    if first["bodyTopMm"] < first["addressTopMm"] + first["addressHeightMm"] + 3:
        raise ValueError("Anschriftsbereich überschneidet sich mit dem Dokumenttitel.")
    for field in ("leftMm", "rightMm"):
        result["followingPages"][field] = first[field]
    return result


def load_layout(settings=None):
    global _last_check, _cached
    if isinstance((settings or {}).get("document_layout"), dict):
        return clean_layout(settings["document_layout"])
    # Offline tools/tests use the invoice defaults. The configured Brain syncs KRISADMIN.
    base = os.environ.get("KRISTINE_API_BASE")
    if not base and not (os.environ.get("KRISTINE_ADMIN_TOKEN") or os.environ.get("ADMIN_TOKEN")):
        return deepcopy(DEFAULTS)
    if _cached is not None and time.monotonic() - _last_check < 30:
        return deepcopy(_cached)
    cache = Path(os.environ.get("BRAIN_DATA_DIR") or ROOT / "data") / "_system" / "document-layout-cache.json"
    if _cached is None and cache.exists():
        try:
            _cached = clean_layout(json.loads(cache.read_text(encoding="utf-8")))
        except (ValueError, OSError, TypeError):
            pass
    _last_check = time.monotonic()
    try:
        request = urllib.request.Request((base or "https://protokoll.krista.at").rstrip("/") + "/api/document-layout", headers={"Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=3) as response:
            value = json.loads(response.read(65536))
        if value.get("ok") is not True:
            raise ValueError("Formularvorlage nicht verfügbar")
        _cached = clean_layout(value["layout"])
        cache.parent.mkdir(parents=True, exist_ok=True)
        temporary = cache.with_suffix(".tmp")
        temporary.write_text(json.dumps(_cached), encoding="utf-8")
        temporary.replace(cache)
    except (OSError, ValueError, TypeError, KeyError) as error:
        logging.getLogger(__name__).warning("Formularvorlage: letzte verfügbare Fassung wird verwendet (%s)", type(error).__name__)
    return deepcopy(_cached or DEFAULTS)
