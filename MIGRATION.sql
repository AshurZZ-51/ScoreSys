-- 立项评估打分系统 数据库迁移 (2026-06-25)
-- 在 Supabase Dashboard > SQL Editor 粘贴并运行此脚本

-- 1. meetings 表加字段
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS is_current BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scheduled_purge_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notes TEXT;

-- 2. projects 表加 is_template 字段
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS is_template BOOLEAN DEFAULT false;

-- 3. 同一时间只允许一条 is_current=true
CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_single_current
  ON meetings (is_current) WHERE is_current = true;

-- 4. 设当前评审会（标记 2026-06-23 那条为当前）
UPDATE meetings
  SET is_current = true
  WHERE name = '2026-06-23 立项评审会议'
    AND deleted_at IS NULL
    AND is_current = false;

-- 5. 给现有评审会补 8 个空模板项目（如果还没有）
DO $$
DECLARE
  m_id UUID;
  existing_count INT;
  i INT;
BEGIN
  FOR m_id IN SELECT id FROM meetings WHERE deleted_at IS NULL LOOP
    SELECT COUNT(*) INTO existing_count
      FROM projects WHERE meeting_id = m_id;
    IF existing_count < 8 THEN
      FOR i IN (existing_count + 1)..8 LOOP
        INSERT INTO projects (meeting_id, seq_no, name, submitter, description, is_template, problems, actions)
        VALUES (m_id, i, '', '', '', true, '{}', '{}')
        ON CONFLICT DO NOTHING;
      END LOOP;
    END IF;
  END LOOP;
END $$;

-- 6. 检查结果
SELECT
  '迁移完成' as status,
  (SELECT COUNT(*) FROM meetings WHERE is_current = true) as current_meetings,
  (SELECT COUNT(*) FROM meetings WHERE deleted_at IS NULL) as active_meetings,
  (SELECT COUNT(*) FROM projects WHERE is_template = true) as template_projects,
  (SELECT COUNT(*) FROM projects WHERE name != '' AND submitter != '') as filled_projects;
