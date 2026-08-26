-- ScoreSys schema required before the historical migrations can run.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE TABLE IF NOT EXISTS reviewers (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reviewer_dims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_code TEXT NOT NULL REFERENCES reviewers(code),
  dim_name TEXT NOT NULL,
  max_score INTEGER NOT NULL DEFAULT 20,
  UNIQUE (reviewer_code, dim_name)
);

CREATE TABLE IF NOT EXISTS meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  meeting_date DATE NOT NULL,
  deadline DATE,
  status TEXT DEFAULT 'active',
  notes TEXT,
  is_current BOOLEAN NOT NULL DEFAULT false,
  deleted_at TIMESTAMPTZ,
  scheduled_purge_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_single_current
  ON meetings (is_current) WHERE is_current = true;

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID REFERENCES meetings(id),
  seq_no INTEGER NOT NULL,
  name TEXT DEFAULT '',
  submitter TEXT DEFAULT '',
  description TEXT DEFAULT '',
  is_template BOOLEAN NOT NULL DEFAULT false,
  is_pending BOOLEAN NOT NULL DEFAULT false,
  problems TEXT[] NOT NULL DEFAULT '{}',
  actions TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID REFERENCES meetings(id),
  project_id UUID REFERENCES projects(id),
  reviewer_code TEXT REFERENCES reviewers(code),
  dim_name TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  comment TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, project_id, reviewer_code, dim_name)
);
