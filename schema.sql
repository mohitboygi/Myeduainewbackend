MyEduAI PostgreSQL schema (runs automatically on server start, safe to re-run)
CREATE TABLE IF NOT EXISTS institutions (
  id           SERIAL PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('school','tuition')),
  name         TEXT NOT NULL,
  phone        TEXT,
  email        TEXT,
  trial_start  DATE NOT NULL DEFAULT CURRENT_DATE,
  subscribed   BOOLEAN NOT NULL DEFAULT FALSE,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- roles: owner (app owner = Mohit), inst_owner (tuition owner), admin (school admin), teacher, student, parent
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  institution_id INT REFERENCES institutions(id) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK (role IN ('owner','inst_owner','admin','teacher','student','parent')),
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
CREATE INDEX IF NOT EXISTS users_inst_role ON users (institution_id, role);

CREATE TABLE IF NOT EXISTS parent_student (
  parent_id  INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (parent_id, student_id)
);

-- "Get Started" form requests (also emailed to the app owner)
CREATE TABLE IF NOT EXISTS leads (
  id          SERIAL PRIMARY KEY,
  type        TEXT,
  inst_name   TEXT NOT NULL,
  person_name TEXT NOT NULL,
  phone       TEXT NOT NULL,
  email       TEXT NOT NULL,
  students    TEXT,
  status      TEXT NOT NULL DEFAULT 'new',   -- new | contacted | account_created
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attendance (
  id             SERIAL PRIMARY KEY,
  institution_id INT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  student_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day            DATE NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('present','absent')),
  marked_by      INT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (student_id, day)
);

-- in-app notifications only (e.g. parent is told when the child is absent)
CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT,
  kind       TEXT NOT NULL DEFAULT 'info',
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notif_user ON notifications (user_id, is_read, created_at DESC);

CREATE TABLE IF NOT EXISTS announcements (
  id             SERIAL PRIMARY KEY,
  institution_id INT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  audience       TEXT NOT NULL CHECK (audience IN ('all','students','parents','teachers')),
  title          TEXT NOT NULL,
  body           TEXT,
  created_by     INT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- study material PDFs: file lives in the owner's Google Drive, only the Drive id is stored here
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
