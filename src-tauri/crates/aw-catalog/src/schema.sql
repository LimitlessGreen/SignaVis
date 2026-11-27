-- SignaVis catalog, schema 1 (draft, Phase 0 spike).
-- Portable to Postgres: INTEGER ids are local, `uid` (UUIDv7 text) identifies rows across
-- machines/sync; times are UTC milliseconds (BIGINT); no SQLite-only types.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS catalog_info (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Named roots; the absolute path is per machine (root_location), assets are relative to a root.
CREATE TABLE IF NOT EXISTS root (
    id      INTEGER PRIMARY KEY,
    uid     TEXT NOT NULL UNIQUE,
    name    TEXT NOT NULL UNIQUE,
    kind    TEXT NOT NULL CHECK (kind IN ('managed', 'referenced'))
);
CREATE TABLE IF NOT EXISTS root_location (
    root_id INTEGER NOT NULL REFERENCES root(id) ON DELETE CASCADE,
    machine TEXT NOT NULL,
    path    TEXT NOT NULL,
    PRIMARY KEY (root_id, machine)
);

CREATE TABLE IF NOT EXISTS import_batch (
    id         INTEGER PRIMARY KEY,
    uid        TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    root_id    INTEGER REFERENCES root(id),
    source     TEXT NOT NULL,          -- folder / files / xc / csv
    pattern    TEXT,                   -- path template(s) used
    n_assets   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS asset (
    id          INTEGER PRIMARY KEY,
    uid         TEXT NOT NULL UNIQUE,
    root_id     INTEGER NOT NULL REFERENCES root(id),
    rel_path    TEXT NOT NULL,
    size        INTEGER NOT NULL,
    mtime       INTEGER NOT NULL,
    quick_hash  TEXT,                  -- size + head/tail hash, for re-link and duplicates
    full_hash   TEXT,                  -- 'sha256:<hex>' over the whole file
    status      TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'missing', 'changed')),
    derived_of  INTEGER REFERENCES asset(id),   -- normalised copy, excerpt, …
    import_id   INTEGER REFERENCES import_batch(id),
    UNIQUE (root_id, rel_path)
);
CREATE INDEX IF NOT EXISTS asset_quick_hash ON asset(quick_hash);
CREATE INDEX IF NOT EXISTS asset_full_hash ON asset(full_hash);

CREATE TABLE IF NOT EXISTS site (
    id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE, name TEXT NOT NULL UNIQUE,
    lat REAL, lon REAL, elevation REAL, habitat TEXT, notes TEXT,
    tz TEXT,                                      -- recorder clock: IANA zone or 'UTC+01:00'
    photo TEXT                                    -- photo file (absolute or project-relative)
);
CREATE TABLE IF NOT EXISTS device (
    id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE, name TEXT NOT NULL UNIQUE,
    model TEXT, serial TEXT, notes TEXT
);
-- Device × site × period.
CREATE TABLE IF NOT EXISTS deployment (
    id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE,
    site_id INTEGER REFERENCES site(id), device_id INTEGER REFERENCES device(id),
    start_ms INTEGER, end_ms INTEGER, notes TEXT
);

-- Recorder clock over time: from wall time `from_wall_ms` (recorder clock, NULL = from the start) the
-- clock is `clock` (IANA zone or 'UTC+01:00'). Recorders get set by hand (e.g. to summer time at a visit).
CREATE TABLE IF NOT EXISTS clock_period (
    id           INTEGER PRIMARY KEY,
    device_id    INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE,
    from_wall_ms INTEGER,
    -- First file under the new clock. Needed when the clock is set back while recording: the same
    -- wall times then occur twice, and file order (folder, name) decides which side a file is on.
    from_path    TEXT,
    clock        TEXT NOT NULL,
    note         TEXT,
    UNIQUE (device_id, from_wall_ms)
);

CREATE TABLE IF NOT EXISTS recording (
    id            INTEGER PRIMARY KEY,
    uid           TEXT NOT NULL UNIQUE,
    asset_id      INTEGER REFERENCES asset(id),   -- NULL for remote-only (xc/url) entries
    source        TEXT NOT NULL CHECK (source IN ('file', 'xc', 'url', 'sample')),
    xc_id         TEXT,
    url           TEXT,
    duration_s    REAL,
    sample_rate   INTEGER,
    channels      INTEGER,
    start_ms      INTEGER,                         -- UTC
    local_offset_min INTEGER,                      -- local clock − UTC at start (for time-of-day filters)
    header_offset_min INTEGER,                     -- offset written by the recorder (GUANO/AudioMoth); wins over clock periods
    tz            TEXT,                            -- IANA zone of the local clock
    site_id       INTEGER REFERENCES site(id),
    device_id     INTEGER REFERENCES device(id),
    deployment_id INTEGER REFERENCES deployment(id),
    -- Own position (mobile recorder, GPS in the header, phone app); wins over the site's coordinates.
    lat REAL, lon REAL, alt REAL, pos_accuracy_m REAL,
    pos_origin TEXT,                               -- manual / header / track
    track_id INTEGER,                              -- track the position came from
    review TEXT,                                   -- NULL (new), 'open' (opened), 'done' (Annotate: Mark done)
    review_ms INTEGER                              -- when the review state was set (UTC ms)
);
CREATE INDEX IF NOT EXISTS recording_asset ON recording(asset_id);
CREATE INDEX IF NOT EXISTS recording_site_time ON recording(site_id, start_ms);
CREATE INDEX IF NOT EXISTS recording_time ON recording(start_ms, id);
CREATE INDEX IF NOT EXISTS recording_device ON recording(device_id);

-- Free metadata; `origin`: pattern / guano / header / manual / xc.
CREATE TABLE IF NOT EXISTS meta (
    recording_id INTEGER NOT NULL REFERENCES recording(id) ON DELETE CASCADE,
    key          TEXT NOT NULL,
    value        TEXT NOT NULL,
    origin       TEXT NOT NULL,
    PRIMARY KEY (recording_id, key)
);
CREATE INDEX IF NOT EXISTS meta_key_value ON meta(key, value);

CREATE TABLE IF NOT EXISTS tag (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS recording_tag (
    recording_id INTEGER NOT NULL REFERENCES recording(id) ON DELETE CASCADE,
    tag_id       INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
    PRIMARY KEY (recording_id, tag_id)
);

-- Static (members) or dynamic (filter JSON) dataset. Members may be a time range of a recording.
CREATE TABLE IF NOT EXISTS dataset (
    id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE, name TEXT NOT NULL UNIQUE,
    description TEXT, kind TEXT NOT NULL CHECK (kind IN ('static', 'filter')),
    filter_json TEXT, color TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dataset_member (
    dataset_id   INTEGER NOT NULL REFERENCES dataset(id) ON DELETE CASCADE,
    recording_id INTEGER NOT NULL REFERENCES recording(id) ON DELETE CASCADE,
    t0 REAL, t1 REAL                              -- NULL = whole recording
);
CREATE INDEX IF NOT EXISTS dataset_member_ds ON dataset_member(dataset_id, recording_id);

-- Runs: inference (birdnet, detector), classifier training/application, import of foreign results.
CREATE TABLE IF NOT EXISTS run (
    id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,                -- inference / classifier / imported
    model TEXT NOT NULL, model_version TEXT, params_json TEXT,
    status TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER, notes TEXT
);
CREATE TABLE IF NOT EXISTS run_coverage (           -- which recordings a run has processed
    run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    recording_id INTEGER NOT NULL REFERENCES recording(id) ON DELETE CASCADE,
    PRIMARY KEY (run_id, recording_id)
);
CREATE TABLE IF NOT EXISTS detection (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    recording_id INTEGER NOT NULL REFERENCES recording(id) ON DELETE CASCADE,
    t0 REAL NOT NULL, t1 REAL NOT NULL, f0 REAL, f1 REAL,
    class TEXT NOT NULL, score REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS detection_run_class_score ON detection(run_id, class, score);
CREATE INDEX IF NOT EXISTS detection_recording ON detection(recording_id);

-- One label model for editor boxes and agile window labels.
CREATE TABLE IF NOT EXISTS label_set (
    id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'annotation', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS label (
    id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE,
    label_set_id INTEGER NOT NULL REFERENCES label_set(id) ON DELETE CASCADE,
    recording_id INTEGER NOT NULL REFERENCES recording(id) ON DELETE CASCADE,
    t0 REAL NOT NULL, t1 REAL NOT NULL, f0 REAL, f1 REAL,
    class TEXT NOT NULL,
    polarity TEXT NOT NULL DEFAULT 'present' CHECK (polarity IN ('present', 'absent', 'unsure')),
    source TEXT NOT NULL DEFAULT 'manual',          -- manual / accepted / agile
    run_id INTEGER REFERENCES run(id), detection_id INTEGER REFERENCES detection(id),
    annotator TEXT, extra_json TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS label_recording ON label(recording_id);
CREATE INDEX IF NOT EXISTS label_set_class ON label(label_set_id, class, polarity);

-- Embedding stores stay files (vectors.f16 + optional usearch); the catalog maps rows.
CREATE TABLE IF NOT EXISTS embedding_store (
    id INTEGER PRIMARY KEY, model TEXT NOT NULL, model_hash TEXT NOT NULL,
    hop_s REAL NOT NULL, dim INTEGER NOT NULL, path TEXT NOT NULL,
    UNIQUE (model_hash, hop_s)
);
CREATE TABLE IF NOT EXISTS embedding_range (
    store_id INTEGER NOT NULL REFERENCES embedding_store(id) ON DELETE CASCADE,
    asset_id INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
    row0 INTEGER NOT NULL, n_rows INTEGER NOT NULL,
    PRIMARY KEY (store_id, asset_id)
);

CREATE TABLE IF NOT EXISTS job (
    id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL, target_json TEXT NOT NULL, params_json TEXT,
    status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS job_error (
    job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE CASCADE,
    asset_id INTEGER REFERENCES asset(id), message TEXT NOT NULL
);

-- Saved import profiles (ProfileSpec JSON), reusable and exportable.
CREATE TABLE IF NOT EXISTS import_profile (
    name       TEXT PRIMARY KEY,
    spec_json  TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- GPS tracks (GPX), matched to recordings by time.
CREATE TABLE IF NOT EXISTS track (
    id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE, name TEXT NOT NULL, source TEXT,
    device_id INTEGER REFERENCES device(id) ON DELETE SET NULL,
    start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, n_points INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS track_point (
    track_id INTEGER NOT NULL REFERENCES track(id) ON DELETE CASCADE,
    t_ms INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, alt REAL
);
CREATE INDEX IF NOT EXISTS track_point_t ON track_point(track_id, t_ms);

-- Spectrogram thumbnails for the library grid (cache; safe to delete). `data`: w*h bytes, row 0 = top
-- (highest frequency), 0 = quiet .. 255 = loud.
CREATE TABLE IF NOT EXISTS thumb (
    recording_id INTEGER NOT NULL REFERENCES recording(id) ON DELETE CASCADE,
    w INTEGER NOT NULL, h INTEGER NOT NULL, max_hz REAL NOT NULL, data BLOB NOT NULL, created_ms INTEGER NOT NULL,
    PRIMARY KEY (recording_id, w, h, max_hz)
);
