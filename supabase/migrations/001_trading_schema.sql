-- DTR Trading Platform — Core Schema
-- Hermes writes to trading_context; Claude reads it before every entry

-- Core trading memory store
CREATE TABLE IF NOT EXISTS trading_context (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol      TEXT NOT NULL UNIQUE,
  context     JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Full trade history
CREATE TABLE IF NOT EXISTS trades (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol            TEXT NOT NULL,
  session           TEXT NOT NULL CHECK (session IN ('2AM', '9AM')),
  direction         TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  entry_price       FLOAT NOT NULL,
  sl_level          FLOAT NOT NULL,
  tp_level          FLOAT NOT NULL,
  exit_price        FLOAT,
  pnl               FLOAT,
  outcome           TEXT CHECK (outcome IN ('WIN', 'LOSS', 'BREAKEVEN', 'OPEN')),
  stage_sequence    JSONB,
  market_conditions JSONB,
  hermes_confidence FLOAT,
  claude_decision   TEXT,
  claude_reasoning  TEXT,
  opened_at         TIMESTAMPTZ DEFAULT NOW(),
  closed_at         TIMESTAMPTZ
);

-- Agent audit log (Hermes + Claude decisions)
CREATE TABLE IF NOT EXISTS agent_audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name   TEXT NOT NULL,
  action       TEXT NOT NULL,
  symbol       TEXT,
  result       JSONB,
  quality_score JSONB,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Strategy parameter history (Hermes proposals + Craig approvals)
CREATE TABLE IF NOT EXISTS strategy_params_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol      TEXT NOT NULL,
  params      JSONB NOT NULL,
  proposed_by TEXT NOT NULL,
  reasoning   TEXT,
  approved_by TEXT,
  status      TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'auto')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Performance snapshots (daily)
CREATE TABLE IF NOT EXISTS performance_snapshots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date        DATE NOT NULL,
  equity      FLOAT,
  daily_pnl   FLOAT,
  win_rate    FLOAT,
  trade_count INT,
  wins        INT,
  losses      INT,
  metadata    JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_opened_at ON trades(opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_outcome ON trades(outcome);
CREATE INDEX IF NOT EXISTS idx_audit_agent ON agent_audit_log(agent_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_params_symbol ON strategy_params_history(symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_perf_date ON performance_snapshots(date DESC);
