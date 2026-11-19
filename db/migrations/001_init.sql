-- Kaizen Sensei portal. Times on the schedule are studio-local text
-- ('YYYY-MM-DDTHH:MM' and 'YYYY-MM-DD'), matching the reference app, so the
-- scheduling comparisons stay plain string comparisons.

CREATE TABLE instructors (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  mb_staff_id TEXT,
  mb_name TEXT,
  pin_hash TEXT,
  role TEXT NOT NULL DEFAULT 'sensei' CHECK (role IN ('sensei', 'front_desk', 'manager')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  instructor_id INTEGER NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE availability (
  instructor_id INTEGER NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  dow INTEGER NOT NULL CHECK (dow BETWEEN 0 AND 6),
  hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
  PRIMARY KEY (instructor_id, dow, hour)
);

CREATE TABLE unavailability (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instructor_id INTEGER NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX unavailability_instructor ON unavailability(instructor_id, start_date, end_date);

CREATE TABLE classes (
  id TEXT PRIMARY KEY,
  start TEXT NOT NULL,
  "end" TEXT NOT NULL,
  name TEXT NOT NULL,
  staff_id TEXT,
  staff_name TEXT,
  location TEXT,
  booked INTEGER,
  capacity INTEGER,
  cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX classes_start ON classes(start);

CREATE TABLE shifts (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  class_id TEXT,
  auto BOOLEAN NOT NULL DEFAULT FALSE,
  start TEXT NOT NULL,
  "end" TEXT NOT NULL,
  name TEXT NOT NULL,
  location TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('sensei', 'unavailable', 'manual')),
  original_instructor_id INTEGER REFERENCES instructors(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filled', 'closed')),
  assigned_instructor_id INTEGER REFERENCES instructors(id) ON DELETE SET NULL,
  note TEXT,
  mb_note TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX shifts_class ON shifts(class_id);
CREATE INDEX shifts_status_start ON shifts(status, start);

CREATE TABLE claims (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  instructor_id INTEGER NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'withdrawn')),
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  UNIQUE (shift_id, instructor_id)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Per login ID, so the limit holds across serverless instances.
CREATE TABLE login_attempts (
  code TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  locked_until BIGINT
);

-- One row per desk alert (WhatsApp, email, or log).
CREATE TABLE alerts (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('timeoff', 'sensei', 'unavailable', 'claim', 'reminder')),
  shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
  timeoff_id INTEGER REFERENCES unavailability(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('queued', 'pending', 'sent', 'logged', 'failed')),
  channel TEXT,
  detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  sent_at TEXT
);
CREATE INDEX alerts_status ON alerts(status);
