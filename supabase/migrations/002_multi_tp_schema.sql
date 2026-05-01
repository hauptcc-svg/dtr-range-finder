-- Migration 002: Multi-TP bracket + strategy tracking
-- Run after 001_trading_schema.sql

-- Add 3-TP columns to trades
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS tp1_level        FLOAT,
  ADD COLUMN IF NOT EXISTS tp2_level        FLOAT,
  ADD COLUMN IF NOT EXISTS tp3_level        FLOAT,
  ADD COLUMN IF NOT EXISTS tp1_filled       BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS tp2_filled       BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS tp3_filled       BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS current_sl_level FLOAT,
  ADD COLUMN IF NOT EXISTS close_reason     TEXT,
  ADD COLUMN IF NOT EXISTS strategy         TEXT DEFAULT 'DTR',
  ADD COLUMN IF NOT EXISTS account_id       TEXT;

-- Update outcome constraint to include PARTIAL
ALTER TABLE trades DROP CONSTRAINT IF EXISTS trades_outcome_check;
ALTER TABLE trades ADD CONSTRAINT trades_outcome_check
  CHECK (outcome IN ('WIN', 'LOSS', 'BREAKEVEN', 'OPEN', 'PARTIAL'));

-- Update session constraint to include XXX session
ALTER TABLE trades DROP CONSTRAINT IF EXISTS trades_session_check;
ALTER TABLE trades ADD CONSTRAINT trades_session_check
  CHECK (session IN ('2AM', '9AM', 'LONDON_NY'));

-- Backfill existing rows
UPDATE trades SET
  tp3_level = tp_level,
  strategy  = 'DTR'
WHERE tp3_level IS NULL;

-- Confirm
SELECT COUNT(*)          AS total_trades,
       COUNT(tp3_level)  AS with_tp3,
       COUNT(strategy)   AS with_strategy
FROM trades;

-- Add index on strategy + account_id
CREATE INDEX IF NOT EXISTS idx_trades_strategy    ON trades(strategy);
CREATE INDEX IF NOT EXISTS idx_trades_account_id  ON trades(account_id);
