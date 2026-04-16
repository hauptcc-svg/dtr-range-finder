# ⚡ QUICK FIX - DO THIS NOW (2 Minutes)

## 🎯 The Problem
Your dashboard isn't showing position limits because the Flask file imports the OLD version.

## ✅ The Solution

### **Step 1: Download File**
```
From /outputs/:
flask_autonomous_trading_CORRECTED.py
```

### **Step 2: In Replit**
```
1. Go to your file list (left sidebar)
2. Find: flask_autonomous_trading.py
3. Right-click → Delete
4. Upload: flask_autonomous_trading_CORRECTED.py
5. Rename to: flask_autonomous_trading.py
```

### **Step 3: Click RUN**
```
Flask restarts with correct imports
Dashboard refreshes
Position limits now show
```

### **Step 4: Verify**
```
Dashboard should show:
✓ Position limits: ENFORCED
✓ Daily loss limit: -$200
✓ Daily profit limit: +$1,400
✓ One per symbol: YES
```

---

## 🚀 Then You're Ready

```
Click mode button (DTR or CLAUDE)
System trades automatically
Position limits protect you
Done!
```

---

## 📋 What Changed

### **OLD (Incorrect)**
```python
from AUTONOMOUS_TRADING_ENGINE import MasterTradingOrchestrator
orchestrator = MasterTradingOrchestrator(...)
```

### **NEW (Correct)**
```python
from AUTONOMOUS_TRADING_ENGINE_WITH_LIMITS import MasterTradingOrchestratorWithLimits
orchestrator = MasterTradingOrchestratorWithLimits(...)
```

---

## ⏱️ Should Take 2 Minutes Total

- Download: 10 seconds
- Delete old file: 10 seconds
- Upload new file: 30 seconds
- Rename: 10 seconds
- Click RUN: 5 seconds
- Refresh dashboard: 10 seconds

**Total: ~2 minutes**

---

## ✅ You're Done

Dashboard now shows position limits.
System now protects you.
48-hour test ready to go.

**That's it!** 🚀

