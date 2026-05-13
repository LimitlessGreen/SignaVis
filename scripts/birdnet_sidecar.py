#!/usr/bin/env python3
"""
BirdNET sidecar script for Signavis.

Protocol
--------
stdin:  single JSON line with analysis configuration (see Input schema).
stdout: JSON Lines — one event per line, each terminated with \\n.
stderr: debug / traceback output (forwarded to Tauri console).

Input schema
~~~~~~~~~~~~
{
    "filepaths":         ["path1.wav", "path2.wav", ...],
    "min_conf":          0.25,    // optional, default 0.25
    "lat":               null,    // optional float
    "lon":               null,    // optional float
    "week":              null,    // optional int 1-48
    "version":           "2.4",   // optional, default "2.4"
    "merge_consecutive": 1,       // optional, default 1
    "sensitivity":       1.0      // optional, default 1.0
}

Output events
~~~~~~~~~~~~~
{"type":"progress","current":N,"total":M,"filepath":null}
{"type":"result","filepath":"...","detections":[...]}
{"type":"error","filepath":"...","message":"..."}
{"type":"done","processed":N,"errors":M}

Detection object
~~~~~~~~~~~~~~~~
{
    "label":      "Turdus merula",      // scientific name
    "commonName": "Common Blackbird",   // common name
    "confidence": 0.9234,
    "support":    [0.0, 3.0]            // [start_s, end_s]
}
"""

from __future__ import annotations

import json
import sys
import traceback
from typing import Any


def emit(event: dict[str, Any]) -> None:
    """Write a single JSON event to stdout and flush immediately."""
    print(json.dumps(event, ensure_ascii=False), flush=True)


def analyze_file(filepath: str, config: dict[str, Any]) -> list[dict[str, Any]]:
    """
    Run BirdNET on a single audio file and return detections.

    Uses ``_return_only=True`` to get the predictions object back instead of
    writing result files to disk. The DataFrame columns used here are:

    - ``input``        – source filepath
    - ``species_name`` – "ScientificName_CommonName" (BirdNET convention)
    - ``start_time``   – float, seconds
    - ``end_time``     – float, seconds
    - ``confidence``   – float 0-1
    """
    from birdnet_analyzer.analyze import analyze  # type: ignore[import]

    lat: float | None = config.get("lat")
    lon: float | None = config.get("lon")

    predictions = analyze(
        audio_input=filepath,
        min_conf=float(config.get("min_conf", 0.25)),
        lat=lat,
        lon=lon,
        week=config.get("week"),
        birdnet=str(config.get("version", "2.4")),
        merge_consecutive=int(config.get("merge_consecutive", 1)),
        sensitivity=float(config.get("sensitivity", 1.0)),
        _return_only=True,
    )

    df = predictions.to_dataframe()
    if df.empty:
        return []

    detections: list[dict[str, Any]] = []
    for _, row in df.iterrows():
        species_name = str(row.get("species_name", ""))
        parts = species_name.split("_", 1)
        label = parts[0] if parts else species_name
        common_name = parts[1] if len(parts) > 1 else ""

        confidence = float(row.get("confidence", 0.0))
        start_s = float(row.get("start_time", 0.0))
        end_s = float(row.get("end_time", 3.0))

        detections.append(
            {
                "label": label,
                "commonName": common_name,
                "confidence": round(confidence, 4),
                "support": [round(start_s, 3), round(end_s, 3)],
            }
        )

    return detections


def main() -> None:
    raw = sys.stdin.readline()
    if not raw.strip():
        emit(
            {
                "type": "error",
                "filepath": None,
                "message": "No config received on stdin",
            }
        )
        sys.exit(1)

    try:
        config: dict[str, Any] = json.loads(raw)
    except json.JSONDecodeError as exc:
        emit(
            {
                "type": "error",
                "filepath": None,
                "message": f"Invalid JSON config: {exc}",
            }
        )
        sys.exit(1)

    filepaths: list[str] = config.get("filepaths", [])
    total = len(filepaths)
    processed = 0
    errors = 0

    emit({"type": "progress", "current": 0, "total": total, "filepath": None})

    for filepath in filepaths:
        try:
            detections = analyze_file(filepath, config)
            emit({"type": "result", "filepath": filepath, "detections": detections})
            processed += 1
        except Exception:  # noqa: BLE001
            errors += 1
            emit(
                {
                    "type": "error",
                    "filepath": filepath,
                    "message": traceback.format_exc(limit=5),
                }
            )

        emit(
            {
                "type": "progress",
                "current": processed + errors,
                "total": total,
                "filepath": filepath,
            }
        )

    emit({"type": "done", "processed": processed, "errors": errors})


if __name__ == "__main__":
    main()
