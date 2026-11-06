ALTER TABLE runs ADD COLUMN title TEXT NOT NULL DEFAULT ''
-- statement-breakpoint
WITH RECURSIVE lines(run_id, rest, line, ordinal) AS (
  SELECT id, input || char(10), '', 0 FROM runs
  UNION ALL
  SELECT run_id, substr(rest, instr(rest, char(10)) + 1),
    trim(substr(rest, 1, instr(rest, char(10)) - 1), char(9, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)), ordinal + 1
  FROM lines WHERE rest <> '' AND line = ''
)
UPDATE runs SET title = substr(coalesce(
  (SELECT line FROM lines WHERE run_id=runs.id AND line <> '' ORDER BY ordinal LIMIT 1),
  nullif(trim((SELECT title FROM tasks WHERE id=runs.task_id)), ''),
  'Untitled Run'), 1, 500)
