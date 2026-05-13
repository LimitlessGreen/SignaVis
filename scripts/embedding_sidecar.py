#!/usr/bin/env python3
"""
Embedding sidecar script for Signavis — Phase 3 + 4.

Protocol
--------
stdin:  single JSON line with the operation config (see Input schemas below).
stdout: JSON Lines — one event per line, each terminated with \\n.
stderr: debug / traceback output.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Mode: "embedding"
-----------------
Extracts a single file-level embedding per audio file using BirdNET.
The embedding is the mean-pooled vector across all valid 3-second segments.

Input:
{
    "mode":          "embedding",
    "recording_ids": ["id1", "id2", ...],   // parallel to filepaths
    "filepaths":     ["path1.wav", ...],
    "version":       "2.4"                  // optional, default "2.4"
}

Output events:
    {"type":"progress",         "current":N, "total":M}
    {"type":"embedding_result", "recording_id":"...", "filepath":"...",
                                "embedding":[...]}           // float32 list, len 1024
    {"type":"error",            "recording_id":"...", "filepath":"...",
                                "message":"..."}
    {"type":"done",             "processed":N, "errors":M}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Mode: "umap"
------------
Reduces a list of embedding vectors to 2-D coordinates via UMAP.
Requires: umap-learn, numpy.

Input:
{
    "mode":  "umap",
    "items": [
        {"id": "recording_id", "embedding": [...]},
        ...
    ],
    "n_neighbors":     15,     // optional, UMAP param
    "min_dist":        0.1,    // optional, UMAP param
    "random_state":    42      // optional
}

Output events:
    {"type":"umap_progress", "message":"..."}
    {"type":"umap_result",   "recording_id":"...", "x":0.1234, "y":-0.5678}
    {"type":"done",          "processed":N, "errors":0}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Mode: "uniqueness"
------------------
Computes a uniqueness score for each item as 1 - mean_cosine_similarity
to its k nearest neighbours in embedding space.

Input:
{
    "mode":  "uniqueness",
    "items": [
        {"id": "recording_id", "embedding": [...]},
        ...
    ],
    "k": 10    // optional, number of nearest neighbours, default 10
}

Output events:
    {"type":"uniqueness_result", "recording_id":"...", "score":0.8234}
    {"type":"done",              "processed":N, "errors":0}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Mode: "clustering"
------------------
Clusters embeddings via HDBSCAN.  Noise points receive cluster_id -1.
Requires: hdbscan (pip install hdbscan) or scikit-learn >= 1.3.

Falls back to scikit-learn HDBSCAN when the standalone 'hdbscan' package
is not available (scikit-learn >= 1.3 ships its own HDBSCAN implementation).

Input:
{
    "mode":              "clustering",
    "items":             [{"id": "...", "embedding": [...]},...],
    "min_cluster_size":  5,    // optional, default 5
    "min_samples":       null  // optional, default = min_cluster_size
}

Output events:
    {"type":"clustering_progress", "message":"..."}
    {"type":"cluster_result",      "recording_id":"...", "cluster_id":-1|N,
                                   "probability":0.0..1.0}
    {"type":"done",                "processed":N, "errors":0,
                                   "n_clusters":K, "n_noise":M}
"""

from __future__ import annotations

import json
import sys
import traceback
from typing import Any


# ── Helpers ───────────────────────────────────────────────────────────────────

def emit(event: dict[str, Any]) -> None:
    """Write a single JSON event to stdout and flush immediately."""
    print(json.dumps(event, ensure_ascii=False), flush=True)


# ── Embedding mode ────────────────────────────────────────────────────────────

def extract_file_embedding(filepath: str, version: str = "2.4") -> list[float]:
    """
    Run BirdNET on a single audio file and return a mean-pooled embedding vector.

    The BirdNET encoder produces one embedding per 3-second segment; we mean-pool
    across all valid segments to obtain a single file-level descriptor.

    Returns a Python list of float32 values (length 1024 for BirdNET v2.4).
    """
    import numpy as np
    from birdnet_analyzer.model_utils import get_embeddings  # type: ignore[import]

    result = get_embeddings(filepath, version=version)

    # result.embeddings shape: (n_inputs=1, n_segments, emb_dim)
    # result.embeddings_masked shape: same; True = dimension should be masked out
    emb   = result.embeddings[0]          # (n_segments, emb_dim)
    masked = result.embeddings_masked[0]  # (n_segments, emb_dim)

    # A segment is "valid" if not all dimensions are masked.
    valid_segs = ~masked.all(axis=-1)     # (n_segments,)

    if not valid_segs.any():
        # Fall back to the raw mean if no segment survived the mask
        pooled = emb.mean(axis=0)
    else:
        pooled = emb[valid_segs].mean(axis=0)

    return pooled.astype(np.float32).tolist()


def run_embedding_mode(config: dict[str, Any]) -> None:
    filepaths    : list[str] = config.get("filepaths", [])
    recording_ids: list[str] = config.get("recording_ids", [])
    version      : str       = config.get("version", "2.4")

    # Pad / truncate recording_ids to match filepaths length
    if len(recording_ids) != len(filepaths):
        recording_ids = [str(i) for i in range(len(filepaths))]

    total = len(filepaths)
    processed = 0
    errors = 0

    emit({"type": "progress", "current": 0, "total": total})

    for rec_id, filepath in zip(recording_ids, filepaths):
        try:
            embedding = extract_file_embedding(filepath, version=version)
            emit({
                "type":         "embedding_result",
                "recording_id": rec_id,
                "filepath":     filepath,
                "embedding":    embedding,
            })
            processed += 1
        except Exception:  # noqa: BLE001
            errors += 1
            emit({
                "type":         "error",
                "recording_id": rec_id,
                "filepath":     filepath,
                "message":      traceback.format_exc(limit=5),
            })

        emit({"type": "progress", "current": processed + errors, "total": total})

    emit({"type": "done", "processed": processed, "errors": errors})


# ── UMAP mode ─────────────────────────────────────────────────────────────────

def run_umap_mode(config: dict[str, Any]) -> None:
    try:
        import numpy as np
        import umap  # type: ignore[import]
    except ImportError as exc:
        emit({
            "type":    "error",
            "message": f"UMAP mode requires 'umap-learn' and 'numpy': {exc}",
        })
        emit({"type": "done", "processed": 0, "errors": 1})
        return

    items: list[dict[str, Any]] = config.get("items", [])
    if not items:
        emit({"type": "done", "processed": 0, "errors": 0})
        return

    n_neighbors  = int(config.get("n_neighbors", 15))
    min_dist     = float(config.get("min_dist", 0.1))
    random_state = int(config.get("random_state", 42))

    ids        = [item["id"] for item in items]
    embeddings = np.array([item["embedding"] for item in items], dtype=np.float32)

    emit({"type": "umap_progress", "message": f"Running UMAP on {len(ids)} points…"})

    reducer    = umap.UMAP(
        n_components=2,
        n_neighbors=min(n_neighbors, len(ids) - 1),
        min_dist=min_dist,
        random_state=random_state,
        low_memory=True,
    )
    coords = reducer.fit_transform(embeddings)  # (N, 2)

    for rec_id, (x, y) in zip(ids, coords):
        emit({
            "type":         "umap_result",
            "recording_id": rec_id,
            "x":            float(x),
            "y":            float(y),
        })

    emit({"type": "done", "processed": len(ids), "errors": 0})


# ── Uniqueness mode ───────────────────────────────────────────────────────────

def run_uniqueness_mode(config: dict[str, Any]) -> None:
    try:
        import numpy as np
    except ImportError as exc:
        emit({"type": "error", "message": f"Uniqueness mode requires 'numpy': {exc}"})
        emit({"type": "done", "processed": 0, "errors": 1})
        return

    items: list[dict[str, Any]] = config.get("items", [])
    k: int = int(config.get("k", 10))

    if not items:
        emit({"type": "done", "processed": 0, "errors": 0})
        return

    ids        = [item["id"] for item in items]
    emb_matrix = np.array([item["embedding"] for item in items], dtype=np.float32)

    # L2-normalise for cosine similarity via dot product
    norms = np.linalg.norm(emb_matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    normed = emb_matrix / norms

    # Full cosine similarity matrix  (N, N)
    sim_matrix = normed @ normed.T

    n = len(ids)
    k_eff = min(k, n - 1)  # cannot have more neighbours than N-1

    for i, rec_id in enumerate(ids):
        # Exclude self-similarity (diagonal)
        row = sim_matrix[i].copy()
        row[i] = -2.0  # force below any valid cosine value
        top_k_sim = np.sort(row)[::-1][:k_eff]
        mean_sim = float(top_k_sim.mean()) if k_eff > 0 else 0.0
        uniqueness = round(1.0 - mean_sim, 6)
        emit({
            "type":         "uniqueness_result",
            "recording_id": rec_id,
            "score":        uniqueness,
        })

    emit({"type": "done", "processed": n, "errors": 0})


# ── Clustering mode ───────────────────────────────────────────────────────────

def run_clustering_mode(config: dict[str, Any]) -> None:
    """HDBSCAN clustering on pre-computed embeddings.

    Tries the standalone 'hdbscan' package first, then falls back to
    sklearn.cluster.HDBSCAN (available in scikit-learn >= 1.3).
    """
    try:
        import numpy as np
    except ImportError as exc:
        emit({"type": "error", "message": f"Clustering requires 'numpy': {exc}"})
        emit({"type": "done", "processed": 0, "errors": 1})
        return

    # Try to import HDBSCAN from either package
    HDBSCANCls = None
    try:
        import hdbscan as hdbscan_pkg  # standalone package
        HDBSCANCls = hdbscan_pkg.HDBSCAN
    except ImportError:
        try:
            from sklearn.cluster import HDBSCAN as SklearnHDBSCAN  # type: ignore[import]
            HDBSCANCls = SklearnHDBSCAN
        except ImportError:
            pass

    if HDBSCANCls is None:
        emit({
            "type":    "error",
            "message": "Clustering requires 'hdbscan' or scikit-learn >= 1.3. "
                       "Install with: pip install hdbscan",
        })
        emit({"type": "done", "processed": 0, "errors": 1})
        return

    items: list[dict[str, Any]] = config.get("items", [])
    if not items:
        emit({"type": "done", "processed": 0, "errors": 0, "n_clusters": 0, "n_noise": 0})
        return

    min_cluster_size: int = int(config.get("min_cluster_size", 5))
    min_samples_raw = config.get("min_samples")
    min_samples: int = int(min_samples_raw) if min_samples_raw is not None else min_cluster_size

    ids        = [item["id"] for item in items]
    embeddings = np.array([item["embedding"] for item in items], dtype=np.float32)

    # L2-normalise so Euclidean distance ≈ cosine distance
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    normed = embeddings / norms

    emit({"type": "clustering_progress", "message": f"Running HDBSCAN on {len(ids)} points…"})

    clusterer = HDBSCANCls(
        min_cluster_size=min(min_cluster_size, max(2, len(ids) // 10)),
        min_samples=min(min_samples, max(1, len(ids) // 20)),
    )
    labels = clusterer.fit_predict(normed)  # int array, -1 = noise

    # probabilities: standalone hdbscan has .probabilities_, sklearn doesn't
    probs: Any = getattr(clusterer, "probabilities_", None)
    if probs is None:
        probs = np.ones(len(labels), dtype=np.float32)

    n_noise    = int((labels == -1).sum())
    valid_mask = labels >= 0
    n_clusters = int(labels[valid_mask].max() + 1) if valid_mask.any() else 0

    for rec_id, cluster_id, prob in zip(ids, labels.tolist(), probs.tolist()):
        emit({
            "type":         "cluster_result",
            "recording_id": rec_id,
            "cluster_id":   int(cluster_id),
            "probability":  round(float(prob), 6),
        })

    emit({
        "type":       "done",
        "processed":  len(ids),
        "errors":     0,
        "n_clusters": n_clusters,
        "n_noise":    n_noise,
    })


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    raw = sys.stdin.readline()
    if not raw.strip():
        emit({"type": "error", "message": "No config received on stdin"})
        sys.exit(1)

    try:
        config: dict[str, Any] = json.loads(raw)
    except json.JSONDecodeError as exc:
        emit({"type": "error", "message": f"Invalid JSON config: {exc}"})
        sys.exit(1)

    mode = config.get("mode", "embedding")

    if mode == "embedding":
        run_embedding_mode(config)
    elif mode == "umap":
        run_umap_mode(config)
    elif mode == "uniqueness":
        run_uniqueness_mode(config)
    elif mode == "clustering":
        run_clustering_mode(config)
    else:
        emit({"type": "error", "message": f"Unknown mode: '{mode}'"})
        sys.exit(1)


if __name__ == "__main__":
    main()
