-- Theme colors survive a backend restart while T3 is unreachable: the last valid dual-mode
-- presentation is kept as one snapshot beside the T3 endpoint it was read from. It mirrors what
-- the backend publishes and is deleted with it; it is a cache, never a credential, and a
-- snapshot that no longer matches the current source, grant or resolver is discarded on read.
CREATE TABLE appearance_snapshot (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  endpoint TEXT NOT NULL,
  presentation TEXT NOT NULL
)
-- statement-breakpoint
-- This Factory server's identity. Clients bind their own cached theme colors to it so a
-- different server at the same address never shows them.
CREATE TABLE factory_server (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  id TEXT NOT NULL
)
-- statement-breakpoint
INSERT INTO factory_server (singleton, id) VALUES (1, lower(hex(randomblob(16))))
