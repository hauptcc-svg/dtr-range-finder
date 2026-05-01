-- Migration 003: equity snapshots enhancements
-- Add account_id, win_rate, trade_count to performance_snapshots
-- and create a composite index for efficient equity curve queries.

ALTER TABLE performance_snapshots ADD COLUMN IF NOT EXISTS account_id  TEXT;
ALTER TABLE performance_snapshots ADD COLUMN IF NOT EXISTS win_rate    FLOAT   DEFAULT 0;
ALTER TABLE performance_snapshots ADD COLUMN IF NOT EXISTS trade_count INTEGER DEFAULT 0;

-- Composite index used by /api/performance/equity queries
CREATE INDEX IF NOT EXISTS idx_perf_snapshots_account_date
    ON performance_snapshots(account_id, date DESC);

-- Backfill existing rows so account_id is never NULL
UPDATE performance_snapshots SET account_id = '' WHERE account_id IS NULL;

-- Confirm row count
SELECT COUNT(*) FROM performance_snapshots;
