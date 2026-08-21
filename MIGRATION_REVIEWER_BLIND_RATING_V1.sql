-- ScoreSys 评委个人评级与盲评统计迁移
-- 可重复执行；不修改旧 scores、Walker 官方评级或历史总分。

CREATE TABLE IF NOT EXISTS project_reviewer_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  reviewer_code TEXT NOT NULL,
  round_no SMALLINT NOT NULL CHECK (round_no IN (1, 2)),
  attempt_no SMALLINT NOT NULL DEFAULT 1 CHECK (attempt_no IN (1, 2)),
  rating TEXT NOT NULL CHECK (rating IN ('S', 'A', 'B', 'C')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT project_reviewer_ratings_assignment_key UNIQUE (meeting_id, project_id, reviewer_code, round_no, attempt_no)
);

-- 兼容早期预览版可能创建过的较窄唯一约束，确保不同评审会/次数保留历史。
DO $$
DECLARE constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.project_reviewer_ratings'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) LIKE '%project_id%'
      AND pg_get_constraintdef(oid) LIKE '%reviewer_code%'
      AND conname <> 'project_reviewer_ratings_assignment_key'
  LOOP
    EXECUTE format('ALTER TABLE public.project_reviewer_ratings DROP CONSTRAINT %I', constraint_name);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.project_reviewer_ratings'::regclass
      AND conname = 'project_reviewer_ratings_assignment_key'
  ) THEN
    ALTER TABLE public.project_reviewer_ratings
      ADD CONSTRAINT project_reviewer_ratings_assignment_key
      UNIQUE (meeting_id, project_id, reviewer_code, round_no, attempt_no);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_project_reviewer_ratings_meeting
  ON project_reviewer_ratings(meeting_id, round_no, attempt_no);

CREATE INDEX IF NOT EXISTS idx_project_reviewer_ratings_project
  ON project_reviewer_ratings(project_id, reviewer_code);
