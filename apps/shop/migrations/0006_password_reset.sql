-- T-25 (C07): password-reset flow. password_resets holds a hash of the reset
-- code/token (never the code itself); mailbox is the internal sandbox the reset
-- "email" is written to (readable only by the test-only API under VM_TEST, never
-- by players). No BEGIN/COMMIT here — the runner wraps this file.

CREATE TABLE password_resets (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  code_hash   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  used        INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id);

CREATE TABLE mailbox (
  id         INTEGER PRIMARY KEY,
  to_email   TEXT NOT NULL,
  subject    TEXT,
  body       TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
