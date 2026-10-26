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
  is_admin        INTEGER NOT NULL DEFAULT 0,
  -- The work email address is the identity: it is what people sign in with,
  -- what the recipient picker matches on, and what proves somebody works
  -- here. Nullable only so an existing database can be migrated; every new
  -- account requires it.
  email           TEXT,
  email_key       TEXT,                    -- lowercased, for matching
  email_verified_at INTEGER                -- set when they follow the link sent to it
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

-- In-flight tus uploads: who started them, and how big they claim to be.
-- Needed to stop one person's upload being resumed, inspected or cancelled by
-- another, and to account for space a user has reserved but not yet committed.
-- A row is dropped once the upload is attached to a transfer (a `blobs` row
-- takes over) or when the upload is cancelled or swept away.
CREATE TABLE IF NOT EXISTS uploads (
  id         TEXT    PRIMARY KEY,       -- tus upload id
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  size       INTEGER NOT NULL,          -- declared Upload-Length
  created_at INTEGER NOT NULL
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
  purged_at  INTEGER,                           -- set once its blob refs were released
  -- 'server' means the bytes passed through here and a blob exists for each
  -- file. 'direct' means they went machine to machine and this row is only a
  -- record that it happened -- there is nothing on disk to download, release
  -- or sweep.
  delivery   TEXT    NOT NULL DEFAULT 'server'  -- 'server'|'direct'
);

-- The file list of a direct transfer.
--
-- It cannot live in transfer_files, because that references blobs and a
-- direct transfer never produced one. Keeping it in its own table is also
-- what guarantees the retention sweeper can never see these rows as
-- something holding bytes: there is no path from here to a blob at all.
CREATE TABLE IF NOT EXISTS direct_files (
  transfer_id TEXT    NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  size        INTEGER NOT NULL,
  PRIMARY KEY (transfer_id, ordinal)
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
CREATE INDEX IF NOT EXISTS idx_uploads_user         ON uploads(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email    ON users(email_key) WHERE email_key IS NOT NULL;
