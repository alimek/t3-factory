-- The message carrying a presented review's confirmation button, so Factory can show the button
-- disabled once the review can no longer be confirmed. Existing proposals have no recorded
-- button message and are never edited.
ALTER TABLE chat_proposals ADD COLUMN button_message_id TEXT
-- statement-breakpoint
-- 1 once the button's message needs no further visual update: Factory updated it, tried once, or
-- skipped it because the review became unusable while no session served.
ALTER TABLE chat_proposals ADD COLUMN button_settled INTEGER NOT NULL DEFAULT 0
  CHECK (button_settled IN (0, 1))
