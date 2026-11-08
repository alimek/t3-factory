-- Results accepted from now on settle their worker thread in T3 once it is finished. Results
-- accepted before keep 0, so upgrading settles no existing thread; Run settlement covers them.
ALTER TABLE runtime_reports ADD COLUMN settles_thread INTEGER NOT NULL DEFAULT 0
