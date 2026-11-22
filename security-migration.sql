
-- ===== Security and legal tables (safe to run again) =====
-- shared counters for rate limiting and login lockout
CREATE TABLE IF NOT EXISTS rate_hits (
  k       TEXT NOT NULL,
  win     BIGINT NOT NULL,
  n       INT NOT NULL DEFAULT 0,
  created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (k, win)
);
CREATE INDEX IF NOT EXISTS rate_hits_created ON rate_hits (created);

-- optional marketing consent (parents and teachers only). contact_hash = HMAC of the e-mail / phone, never the raw value
CREATE TABLE IF NOT EXISTS consent_records (
  id                    TEXT PRIMARY KEY,
  user_id               INT REFERENCES users(id) ON DELETE SET NULL,
  institution_id        INT,
  consent_type          TEXT NOT NULL DEFAULT 'marketing',
  business_name         TEXT NOT NULL,
  communication_channel TEXT NOT NULL CHECK (communication_channel IN ('email','whatsapp','sms','phone')),
  consent_status        TEXT NOT NULL CHECK (consent_status IN ('granted','withdrawn')),
  policy_version        TEXT,
  consent_timestamp     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  withdrawal_timestamp  TIMESTAMPTZ,
  source                TEXT,
  contact_hash          TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS consent_user ON consent_records (user_id);

-- people who withdrew consent: check this list before sending any promotion
CREATE TABLE IF NOT EXISTS marketing_suppression (
  id                    TEXT PRIMARY KEY,
  contact_hash          TEXT NOT NULL,
  business_name         TEXT,
  communication_channel TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS suppression_hash ON marketing_suppression (contact_hash);

CREATE TABLE IF NOT EXISTS privacy_requests (
  id               TEXT PRIMARY KEY,
  reference_number TEXT NOT NULL UNIQUE,
  user_id          INT REFERENCES users(id) ON DELETE SET NULL,
  institution_id   INT,
  request_type     TEXT NOT NULL,
  description      TEXT,
  contact          TEXT,
  name             TEXT,
  status           TEXT NOT NULL DEFAULT 'open',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS grievance_records (
  id               TEXT PRIMARY KEY,
  reference_number TEXT NOT NULL UNIQUE,
  user_id          INT REFERENCES users(id) ON DELETE SET NULL,
  complaint_type   TEXT NOT NULL,
  description      TEXT,
  contact          TEXT,
  name             TEXT,
  status           TEXT NOT NULL DEFAULT 'open',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS cookie_preferences (
  anonymous_session_id TEXT PRIMARY KEY,
  user_id              INT REFERENCES users(id) ON DELETE SET NULL,
  essential_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  analytics_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  marketing_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS legal_audit_log (
  id            TEXT PRIMARY KEY,
  actor_user_id INT,
  action        TEXT NOT NULL,
  object_type   TEXT,
  object_id     TEXT,
  ip            TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- these tables are reachable only through this server (row security on, no policies)
ALTER TABLE rate_hits ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_suppression ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE grievance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE cookie_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_audit_log ENABLE ROW LEVEL SECURITY;
