-- Existing Runs keep Run-level settlement only; newly started Runs opt into per-Block settlement.
ALTER TABLE runs ADD COLUMN block_settlement_enabled INTEGER NOT NULL DEFAULT 0 CHECK(block_settlement_enabled IN (0,1));
