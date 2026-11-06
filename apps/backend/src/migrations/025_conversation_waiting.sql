-- Explicit v2 conversation waiting: the Agent's explanation shown with its Needs input matter.
-- Existing attention has no such explanation and keeps NULL.
ALTER TABLE run_attention ADD COLUMN message TEXT;
