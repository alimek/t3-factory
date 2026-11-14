-- Continuation and section handles Chat control's read tools hand to the model. A handle names
-- what to read next (a search position or the sections of one Run read with their versions) and
-- grants nothing: every use rechecks access and the source. It belongs to the conversation
-- generation and the invocation whose interpretation issued it, and is usable only while that
-- generation is current and the invocation's turn is retained. Clearing a conversation deletes
-- its handles.
CREATE TABLE chat_conversation_handles (
  application_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  generation INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('run-search', 'run-read')),
  payload_json TEXT NOT NULL,
  PRIMARY KEY (application_id, thread_id, handle),
  FOREIGN KEY (application_id, thread_id) REFERENCES chat_conversations(application_id, thread_id)
)
