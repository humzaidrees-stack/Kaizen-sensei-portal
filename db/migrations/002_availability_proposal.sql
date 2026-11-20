-- Desk can pre-fill a sensei's weekly hours. The sensei confirms later.
ALTER TABLE instructors
  ADD COLUMN availability_prefilled_by INTEGER REFERENCES instructors(id) ON DELETE SET NULL,
  ADD COLUMN availability_prefilled_at TEXT,
  ADD COLUMN availability_confirmed_at TEXT;
