-- Monthly schedule drafts. New tables only. Existing tables are not changed.

CREATE TABLE class_history (
  id TEXT PRIMARY KEY,
  start TEXT NOT NULL,
  "end" TEXT NOT NULL,
  name TEXT NOT NULL,
  staff_id TEXT,
  staff_name TEXT,
  location TEXT,
  location_id TEXT,
  class_schedule_id TEXT,
  class_description_id TEXT,
  resource_id TEXT,
  capacity INTEGER,
  web_capacity INTEGER,
  waitlist_capacity INTEGER,
  booking_status TEXT,
  staff_pay_rate INTEGER,
  booked INTEGER,
  cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  synced_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX class_history_start ON class_history(start);
CREATE INDEX class_history_location ON class_history(location, start);

CREATE TABLE schedule_drafts (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  location TEXT NOT NULL,
  target_start TEXT NOT NULL,
  target_end TEXT NOT NULL,
  pattern_start TEXT NOT NULL,
  pattern_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'discarded')),
  created_by INTEGER REFERENCES instructors(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'fifteenth')),
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX schedule_drafts_target ON schedule_drafts(location, target_start, status);

CREATE TABLE schedule_draft_slots (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES schedule_drafts(id) ON DELETE CASCADE,
  slot_date TEXT NOT NULL,
  start TEXT NOT NULL,
  "end" TEXT NOT NULL,
  name TEXT NOT NULL,
  location TEXT NOT NULL,
  class_id TEXT,
  class_description_id TEXT,
  location_id TEXT,
  class_schedule_id TEXT,
  resource_id TEXT,
  staff_pay_rate INTEGER,
  max_capacity INTEGER,
  web_capacity INTEGER,
  waitlist_capacity INTEGER,
  booking_status TEXT,
  current_staff_id TEXT,
  current_staff_name TEXT,
  proposed_instructor_id INTEGER REFERENCES instructors(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fill', 'missing', 'extra', 'added')),
  removed BOOLEAN NOT NULL DEFAULT FALSE,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  booked INTEGER,
  eligible_ids JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX schedule_draft_slots_draft ON schedule_draft_slots(draft_id, start);
