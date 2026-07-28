-- BetSend schema. Applied on every boot; all statements are idempotent.

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  name            TEXT    NOT NULL,        -- canonical display form, e.g. "J.Johnson"
  name_key        TEXT    NOT NULL UNIQUE, -- lowercased, for case-insensitive uniqueness
  source          TEXT    NOT NULL DEFAULT 'self',  -- 'self' | 'admin'
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER,
  active          INTEGER NOT NULL DEFAULT 1,
  password_hash   TEXT,                    -- null until the person sets one
  password_set_at INTEGER,
  is_admin        INTEGER NOT NULL DEFAULT 0
);

-- Server-side sessions, so a login can be revoked centrally (a lost laptop
-- should not stay signed in for a month).
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT    PRIMARY KEY,        -- sha256 of the cookie value
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  user_agent   TEXT
);

-- One-time links that let a person set their first password, or reset it.
CREATE TABLE IF NOT EXISTS setup_tokens (
  id         TEXT    PRIMARY KEY,          -- sha256 of the token in the URL
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

-- One row = one physical copy of bytes on disk. Bulk sends reference the same
-- blob from many recipients; the bytes are never duplicated.
CREATE TABLE IF NOT EXISTS blobs (
  id            TEXT    PRIMARY KEY,       -- tus upload id, also the filename on disk
  original_name TEXT    NOT NULL,
  size          INTEGER NOT NULL,
  mime          TEXT,
  storage_key   TEXT    NOT NULL,
  owner_id      INTEGER REFERENCES users(id),
  ref_count     INTEGER NOT NULL DEFAULT 0,
  state         TEXT    NOT NULL DEFAULT 'ready', -- 'ready' | 'deleted'
  created_at    INTEGER NOT NULL,
  committed_at  INTEGER                    -- set when attached to a transfer
);

CREATE TABLE IF NOT EXISTS transfers (
  id         TEXT    PRIMARY KEY,
  sender_id  INTEGER NOT NULL REFERENCES users(id),
  note       TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state      TEXT    NOT NULL DEFAULT 'active', -- 'active'|'revoked'|'expired'|'completed'|'deleted'
  total_size INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  purged_at  INTEGER                            -- set once its blob refs were released
);

CREATE TABLE IF NOT EXISTS transfer_files (
  transfer_id TEXT    NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  blob_id     TEXT    NOT NULL REFERENCES blobs(id),
  ordinal     INTEGER NOT NULL,
  PRIMARY KEY (transfer_id, blob_id)
);

CREATE TABLE IF NOT EXISTS recipients (
  id             INTEGER PRIMARY KEY,
  transfer_id    TEXT    NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  seen_at        INTEGER,
  downloaded_at  INTEGER,
  download_count INTEGER NOT NULL DEFAULT 0,
  notified_at    INTEGER,
  UNIQUE (transfer_id, user_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  type        TEXT    NOT NULL,
  transfer_id TEXT,
  user_id     INTEGER,
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_recipients_user     ON recipients(user_id);
CREATE INDEX IF NOT EXISTS idx_recipients_transfer ON recipients(transfer_id);
CREATE INDEX IF NOT EXISTS idx_transfers_sender    ON transfers(sender_id);
CREATE INDEX IF NOT EXISTS idx_transfers_state     ON transfers(state, expires_at);
CREATE INDEX IF NOT EXISTS idx_transfer_files_blob ON transfer_files(blob_id);
CREATE INDEX IF NOT EXISTS idx_blobs_state         ON blobs(state, ref_count);
CREATE INDEX IF NOT EXISTS idx_events_ts           ON events(ts);
CREATE INDEX IF NOT EXISTS idx_sessions_user       ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry     ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_setup_tokens_user   ON setup_tokens(user_id);
