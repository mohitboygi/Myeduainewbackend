MyEduAI PostgreSQL schema (runs automatically on server start, safe to re-run)

CREATE TABLE IF NOT EXISTS institutions (
  id           SERIAL PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('school', 'tuition')),
  name         TEXT NOT NULL,
  phone        TEXT,
  email        TEXT,
  trial_start  DATE NOT NULL DEFAULT CURRENT_DATE,
  subscribed   BOOLEAN NOT NULL DEFAULT FALSE,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Roles: owner (app owner = Mohit), inst_owner (tuition owner),
-- admin (school admin), teacher, student, parent
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  institution_id INT REFERENCES institutions(id) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK (
    role IN ('owner', 'inst_owner', 'admin', 'teacher', 'student', 'parent')
  ),
  login_id       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  name           TEXT NOT NULL,
  phone          TEXT,
  email          TEXT,
  class_name     TEXT,
  division       TEXT,
  stream         TEXT,
  created_by     INT REFERENCES users(id) ON DELETE SET NULL,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_inst_role
  ON users (institution_id, role);

CREATE TABLE IF NOT EXISTS parent_student (
  parent_id  INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (parent_id, student_id)
);

-- Get Started form requests
CREATE TABLE IF NOT EXISTS leads (
  id          SERIAL PRIMARY KEY,
  type        TEXT,
  inst_name   TEXT NOT NULL,
  person_name TEXT NOT NULL,
  phone       TEXT NOT NULL,
  email       TEXT NOT NULL,
  students    TEXT,
  status      TEXT NOT NULL DEFAULT 'new',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attendance (
  id             SERIAL PRIMARY KEY,
  institution_id INT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  student_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day            DATE NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('present', 'absent')),
  marked_by      INT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (student_id, day)
);

-- In-app notifications
CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT,
  kind       TEXT NOT NULL DEFAULT 'info',
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notif_user
  ON notifications (user_id, is_read, created_at DESC);

CREATE TABLE IF NOT EXISTS announcements (
  id             SERIAL PRIMARY KEY,
  institution_id INT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  audience       TEXT NOT NULL CHECK (
    audience IN ('all', 'students', 'parents', 'teachers')
  ),
  title          TEXT NOT NULL,
  body           TEXT,
  created_by     INT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Study material PDFs: only the Google Drive file ID is stored
CREATE TABLE IF NOT EXISTS documents (
  id             SERIAL PRIMARY KEY,
  institution_id INT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  class_name     TEXT,
  subject        TEXT,
  title          TEXT NOT NULL,
  drive_file_id  TEXT NOT NULL,
  uploaded_by    INT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
