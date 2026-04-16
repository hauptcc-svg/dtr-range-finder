"""
Multi-Instrument DTR 2 AM Trading Configuration
===============================================
Trade all four Topstep instruments simultaneously with the same DTR strategy

Instruments:
  MYMM26 - Mini Yen Futures
  MCLK26 - Micro Crude Oil Futures
  MGCM26 - Micro Gold Futures
  MNQM26 - Micro NQ (Nasdaq 100)
"""

MULTI_INSTRUMENT_CONFIG = {
    # ═══════════════════════════════════════════════════════════════════════
    # SHARED SETTINGS (all instruments)
    # ═══════════════════════════════════════════════════════════════════════
    
    "timezone": "America/New_York",
    
    # Daily Limits (SHARED across ALL instruments)
    "daily_loss_limit": 200.0,      # Combined max loss (all 4 instruments)
    "daily_profit_target": 1400.0,  # Combined max profit (all 4 instruments)
    "trading_days": [0, 1, 2, 3, 4],  # Mon-Fri
    
    # ═══════════════════════════════════════════════════════════════════════
    # INSTRUMENT 1: MYMM26 (Mini Yen)
    # ═══════════════════════════════════════════════════════════════════════
    
    "MYMM26": {
        "enabled": True,
        "name": "Mini Yen",
        "contract": "MYMM26",
        
        # Position Sizing
        "qty": 2,
        "tp1_qty": 1,
        
        # Session Times (NY timezone)
        # LONDON SESSION
        "london_range_start": "01:12",    # Range forms 1:12 AM
        "london_range_end": "02:13",      # Range complete 2:13 AM
        "london_entry_start": "03:13",    # Entries open 3:13 AM (NOT 2:13)
        "london_entry_end": "07:00",      # Entries close 7:00 AM (strict cutoff)
        
        # NEW YORK SESSION
        "ny_range_start": "08:12",        # Range forms 8:12 AM
        "ny_range_end": "09:13",          # Range complete 9:13 AM
        "ny_entry_start": "09:13",        # Entries open 9:13 AM
        "ny_entry_end": "14:00",          # Entries close 2:00 PM (14:00)
        
        # Entry Filters
        "bias_candle_atr_mult": 0.5,
        "sl_atr_buffer": 0.0,
        "tp_mode": "Range Target",
        
        # Daily Limits (per instrument)
        "max_trades_per_day": 4,
        "max_losses_per_direction": 2,
        
        # Contract Specifications
        "point_value": 12.50,
        "min_tick": 0.01,
    },
    
    # ═══════════════════════════════════════════════════════════════════════
    # INSTRUMENT 2: MCLK26 (Micro Crude Oil)
    # ═══════════════════════════════════════════════════════════════════════
    
    "MCLK26": {
        "enabled": True,
        "name": "Micro Crude Oil",
        "contract": "MCLK26",
        
        # Position Sizing
        "qty": 2,
        "tp1_qty": 1,
        
        # Session Times
        "london_range_start": "01:12",
        "london_range_end": "02:13",
        "london_entry_start": "03:13",
        "london_entry_end": "07:00",
        
        "ny_range_start": "08:12",
        "ny_range_end": "09:13",
        "ny_entry_start": "09:13",
        "ny_entry_end": "14:00",
        
        # Entry Filters
        "bias_candle_atr_mult": 0.5,
        "sl_atr_buffer": 0.0,
        "tp_mode": "Range Target",
        
        # Daily Limits
        "max_trades_per_day": 4,
        "max_losses_per_direction": 2,
        
        # Contract Specifications
        "point_value": 10.00,
        "min_tick": 0.01,
    },
    
    # ═══════════════════════════════════════════════════════════════════════
    # INSTRUMENT 3: MGCM26 (Micro Gold)
    # ═══════════════════════════════════════════════════════════════════════
    
    "MGCM26": {
        "enabled": True,
        "name": "Micro Gold",
        "contract": "MGCM26",
        
        # Position Sizing
        "qty": 2,
        "tp1_qty": 1,
        
        # Session Times
        "london_range_start": "01:12",
        "london_range_end": "02:13",
        "london_entry_start": "03:13",
        "london_entry_end": "07:00",
        
        "ny_range_start": "08:12",
        "ny_range_end": "09:13",
        "ny_entry_start": "09:13",
        "ny_entry_end": "14:00",
        
        # Entry Filters
        "bias_candle_atr_mult": 0.5,
        "sl_atr_buffer": 0.0,
        "tp_mode": "Range Target",
        
        # Daily Limits
        "max_trades_per_day": 4,
        "max_losses_per_direction": 2,
        
        # Contract Specifications
        "point_value": 10.00,
        "min_tick": 0.10,
    },
    
    # ═══════════════════════════════════════════════════════════════════════
    # INSTRUMENT 4: MNQM26 (Micro NQ)
    # ═══════════════════════════════════════════════════════════════════════
    
    "MNQM26": {
        "enabled": True,
        "name": "Micro NQ (Nasdaq 100)",
        "contract": "MNQM26",
        
        # Position Sizing
        "qty": 3,
        "tp1_qty": 1,
        
        # Session Times
        "london_range_start": "01:12",
        "london_range_end": "02:13",
        "london_entry_start": "03:13",
        "london_entry_end": "07:00",
        
        "ny_range_start": "08:12",
        "ny_range_end": "09:13",
        "ny_entry_start": "09:13",
        "ny_entry_end": "14:00",
        
        # Entry Filters
        "bias_candle_atr_mult": 0.5,
        "sl_atr_buffer": 0.0,
        "tp_mode": "Range Target",
        
        # Daily Limits
        "max_trades_per_day": 4,
        "max_losses_per_direction": 2,
        
        # Contract Specifications
        "point_value": 20.00,
        "min_tick": 0.25,
    },
    
    # ═══════════════════════════════════════════════════════════════════════
    # PROJECTX API
    # ═══════════════════════════════════════════════════════════════════════
    
    "projectx": {
        "api_key": None,           # Set via environment
        "username": None,          # hauptcc@gmail.com
        "account_id": None,        # 29127
        "base_url": "https://api.projectx.com",
        "timeout": 30,
    },
    
    # ═══════════════════════════════════════════════════════════════════════
    # MARKET DATA
    # ═══════════════════════════════════════════════════════════════════════
    
    "market_data": {
        "source": "projectx",
        "timeframe": "1m",
        "history_bars": 500,
        "stream_all_instruments": True,
    },
    
    # ═══════════════════════════════════════════════════════════════════════
    # LOGGING
    # ═══════════════════════════════════════════════════════════════════════
    
    "logging": {
        "level": "INFO",
        "log_dir": "logs",
        "file_retention_days": 30,
    },
}

# ═══════════════════════════════════════════════════════════════════════════
# EXPECTED PERFORMANCE (all 4 instruments)
# ═══════════════════════════════════════════════════════════════════════════

PERFORMANCE_TARGETS = {
    "mymm26": {
        "contract": "MYMM26",
        "point_value": 12.50,
        "avg_win": 50,           # 50 points × $12.50 = $625
        "avg_loss": 30,          # 30 points × $12.50 = $375
        "expected_daily_profit": 150,
    },
    "mclk26": {
        "contract": "MCLK26",
        "point_value": 10.00,
        "avg_win": 40,           # 40 points × $10 = $400
        "avg_loss": 25,          # 25 points × $10 = $250
        "expected_daily_profit": 100,
    },
    "mgcm26": {
        "contract": "MGCM26",
        "point_value": 10.00,
        "avg_win": 35,           # 35 points × $10 = $350
        "avg_loss": 20,          # 20 points × $10 = $200
        "expected_daily_profit": 100,
    },
    "mnqm26": {
        "contract": "MNQM26",
        "point_value": 20.00,
        "avg_win": 50,           # 50 points × $20 = $1,000
        "avg_loss": 30,          # 30 points × $20 = $600
        "expected_daily_profit": 250,
    },
    "combined": {
        "total_instruments": 4,
        "combined_daily_limit": 200,      # Shared limit across all 4
        "combined_daily_target": 1400,    # Shared target across all 4
        "expected_avg_daily_profit": 600, # $150+100+100+250
        "best_day_potential": 1400,       # All 4 hit targets
        "worst_day_limit": -200,          # Hit loss limit
    },
}

# ═══════════════════════════════════════════════════════════════════════════
# USAGE EXAMPLE
# ═══════════════════════════════════════════════════════════════════════════

"""
Load configuration:

    from multi_instrument_config import MULTI_INSTRUMENT_CONFIG
    
    # Trade all 4 instruments
    for symbol, config in MULTI_INSTRUMENT_CONFIG.items():
        if symbol not in ["projectx", "market_data", "logging"]:
            if config["enabled"]:
                print(f"Trading {config['name']} ({symbol})")
    
    # Trade specific instrument
    yen_config = MULTI_INSTRUMENT_CONFIG["MYMM26"]
    
    # Shared daily limits
    daily_loss = MULTI_INSTRUMENT_CONFIG["daily_loss_limit"]  # -$200
    daily_profit = MULTI_INSTRUMENT_CONFIG["daily_profit_target"]  # +$1,400
"""

# ═══════════════════════════════════════════════════════════════════════════
# POSITION SIZING RATIONALE
# ═══════════════════════════════════════════════════════════════════════════

"""
Why 2-3 contracts per instrument?

Daily Loss Limit: -$200
Daily Profit Target: +$1,400

Trading 4 instruments simultaneously means:
  - Up to 4 trades/day per instrument = 16 total trades possible
  - With 2 contracts each, max exposure = 8 contracts
  - With 3 contracts (MNQ), max exposure = 11 contracts

Risk per trade (MNQ example):
  Entry: 19,250, SL: 19,230 (20 pts)
  Risk = 20 pts × $20/pt × 3 contracts = $1,200 total
  
  BUT: With $200 daily limit, you can only afford 1 SL hit
  So you'll naturally stop after first loss and wait for win
  
Aggressive strategy:
  - Each instrument can go 2-4 trades before hitting limits
  - Diversification across 4 markets reduces drawdown
  - If Yen stops you, Gold/Oil/NQ can still trade
  - Shared $200 loss limit means TOTAL across all 4
"""
