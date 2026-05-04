# Session Handover — 2026-05-04 (session 2)

## Current state

| Component | Status |
|-----------|--------|
| Railway backend | ✅ Live — https://dtr-range-finder-production.up.railway.app |
| Vercel frontend | ✅ Live — https://project-wonf5.vercel.app |
| Mode buttons | ✅ Fixed |
| Risk Controls fields | ✅ Fixed — camelCase, populate correctly |
| Risk settings persistence | ✅ Fixed — Supabase-backed |
| Account auth | ✅ Working — id 22459438, $50,000, canTrade=true |
| Account balance display | ✅ Fixed — instant update after switch |
| Account selector | ✅ Fixed — collapse/expand, shows with 1+ accounts |
| Manual trade endpoint | ✅ Fixed — uses contract_ids not instruments |
| Contract search (IDs) | ✅ Fixed — MNQ/MYM/MGC resolve to CON.F.US.* |
| Bar history (OHLCV) | ❌ BLOCKED — errorCode=1 from TopstepX (see below) |
| LAST PRICE / RANGE | ❌ Shows "---" / 0.00 — depends on bars |
| Strategy | ❌ HALT — needs bars working first |
| MCLK26 (MCL crude) | ❌ Not found by search — expired contract |

---

## What was done this session

### 1. AccountSelector — collapse/expand + visibility fix
- Added `ChevronDown`/`ChevronUp` toggle, collapsed by default, state persisted in `localStorage`
- Header click anywhere to toggle; collapsed view shows active account name + balance
- **Fixed visibility bug**: guard was `if (length <= 1) return null` → was hidden when only 1 account → changed to `length >= 1`

### 2. Account balance — instant update after switch
- Added `overrideBalance` state in dashboard; set immediately when account switch succeeds
- `/api/accounts/select` backend now runs `set_active_account + get_account_summary` in one coroutine, returns `balance` in response
- `queryClient.invalidateQueries()` triggered on switch so full status refreshes immediately
- Previously: waited up to 2 minutes for the 60s tick cycle

### 3. Wrong active account — fixed
- `PROJECTX_ACCOUNT_ID=27501559` is TopstepX's **display number**, not the API integer id
- Real tradeable account: `id=22459438`, name=`"50KTC-V2-415514-27501559"`, `canTrade=true`
- Added 3-tier matching in `projectx_api.get_account()` and orchestrator boot:
  1. Exact API `id` match
  2. Account `name` contains the env var number
  3. Auto-select the only `canTrade=True` account
- Orchestrator now syncs `self.active_account_id` and `self.api.account_id` to the real API id

### 4. Manual trade "Network error" — fixed
- `POST /api/agent/manual-order` was calling `orchestrator.instruments.get(symbol)` → `AttributeError` (attribute doesn't exist)
- Fixed to `orchestrator.contract_ids.get(symbol)`
- Added global JSON error handler to Flask so all unhandled exceptions return JSON 500, never HTML

### 5. Contract search `live` flag — critical fix
- Previous commit (`b912fe4`) changed `search_contracts` to `live=True` which broke contract resolution (TopstepX search only works with `live=False`)
- Reverted to `live=False` for search; `live=True` stays only in `get_bars()`
- MGCM26 → `CON.F.US.MGC.M26` ✅, MNQM26 → `CON.F.US.MNQ.M26` ✅, MYMM26 → `CON.F.US.MYM.M26` ✅

### 6. Bar history API — partial fix (request valid, still errorCode=1)
- **Missing `endTime`**: `/api/History/retrieveBars` requires `endTime` as a required field — was absent, causing 400 validation errors. Fixed: always pass `endTime=now_utc`.
- **Wrong `unit`**: was `unit=1` (seconds), changed to `unit=2` (minutes).
- **`bars=null` handling**: API returns `{"bars": null}` (key present, value null) not `{"bars": []}`. Fixed `.get("bars", [])` → `.get("bars") or []`.
- **Still failing**: `{"success": false, "errorCode": 1, "bars": null}` — see below.

---

## The remaining blocker — bar history errorCode=1

### What we know
- HTTP 200, JSON response, no validation errors (those are fixed)
- `{"bars": null, "errorCode": 1, "errorMessage": null, "success": false}`
- `errorCode: 1` = generic failure on TopstepX's side (no description in errorMessage)
- All correct params: `contractId=CON.F.US.MYM.M26`, `unit=2`, `unitNumber=1`, `live=True`, `startTime`, `endTime`
- Tested `live=True` and `live=False` — both return `errorCode=1`

### Two likely causes

**Cause A — Markets are closed right now**
CME futures trade Sunday 6pm ET → Friday 5pm ET with a 1hr daily break at 5pm ET. If Craig is testing outside those hours, TopstepX legitimately returns no bars. `errorCode: 1` is the "no data" code, not just auth failure.

**Cause B — Combine account data restriction**
TopstepX Combine/Evaluation accounts may not have REST market data API access. Real-time data on Combine accounts typically goes through their WebSocket feed (`/hubs/market`), not the REST history endpoint.

### How to confirm

1. **Test during confirmed market hours** (10am–3pm ET Monday–Friday):
   ```
   GET https://dtr-range-finder-production.up.railway.app/api/debug/contracts
   ```
   If `bars_returned > 0` → was just market hours. Done.

2. **If still errorCode=1 during market hours** → Combine restriction.
   Contact TopstepX support: "Can I access `/api/History/retrieveBars` for my Combine account via API key auth?"

### Workaround if Combine restriction is confirmed
TopstepX provides a WebSocket hub for market data: `wss://api.topstepx.com/hubs/market`
The orchestrator would need to subscribe to `SubscribeContractQuotes` or `SubscribeDOMLevel2` via SignalR instead of polling REST bars. This is a bigger refactor but is the standard pattern for Combine accounts.

---

## MCLK26 — expired contract

MCLK26 = Micro Crude Oil May 2026 futures — this contract expired around May 2026. The current front-month is likely:
- `MCLN26` = July 2026 (N = July in CME month codes)

**Fix**: Update `MULTI_INSTRUMENT_CONFIG` in `multi_instrument_config.py` (or equivalent) to replace `"MCLK26"` with `"MCLN26"`. Also update the Railway `PROJECTX_ACCOUNT_ID` comment if it references the symbol.

---

## Commits this session

| Hash | Description |
|------|-------------|
| `9b4d7f1` | Fix wrong account + add contract/bar debug endpoints |
| `b912fe4` | (bad) switched search to live=True — broke contract resolution |
| `d44eef2` | Revert contract search to live=False, keep bars at live=True |
| `87e48b6` | Debug probe: test unit values 1–5 for bars |
| `d2b7b1f` | **Add required endTime + unit=2 for minute bars** |
| `51170d5` | Fix bars=null handling (or [] not .get(..., [])) |
| `5daec28` | Add accountId to bar history requests (didn't fix errorCode=1) |
| `56c1151` | Debug: test live=True and live=False for bars (both return errorCode=1) |

---

## Immediate next steps (priority order)

1. **During market hours (10am–3pm ET weekday)**, hit the debug endpoint and confirm bars:
   `https://dtr-range-finder-production.up.railway.app/api/debug/contracts`
   → If `bars_returned > 0`: market data is working, proceed to step 3.
   → If still `errorCode: 1`: contact TopstepX support re: Combine API data access.

2. **Update MCLK26 → MCLN26** in `multi_instrument_config.py` (MCL crude oil symbol expired)

3. **Click DTR on the dashboard** to activate strategy once bars are confirmed working

4. **Verify Telegram** — send `/help` to `@decanatorfxbot`. Should reply with command list.
   - Check Railway env: `TELEGRAM_BOT_TOKEN=8396207281:AAEa...` (old `.replit` token is expired — do NOT use it)
   - Chat ID = `332762243` (@cchaos21)

5. **Monitor forward test** — Railway logs + Telegram notifications for trade entries

---

## Gotchas / known issues

- `search_contracts` MUST use `live=False` — TopstepX's contract search endpoint returns empty with `live=True`
- `get_bars` MUST use `live=True` — returns errorCode=1 with live=False too (same result for now, but live=True is architecturally correct)
- `endTime` is a **required** field on `/api/History/retrieveBars` — always pass it (default: `datetime.utcnow()`)
- `unit=2` = minute bars. `unit=1` = second bars (useless for strategy).
- TopstepX `bars` field comes back as JSON `null` (not missing key) when empty — must use `data.get("bars") or []`
- Account ID `22459438` is the API integer id. `27501559` is the display/TopstepX number. They're different. The 3-tier matching handles this automatically but don't set `PROJECTX_ACCOUNT_ID=22459438` — the name-matching logic already handles the display number correctly.
- `AGENT_CONTROL_SECRET` must be set in Railway for dashboard authentication
- `XXX` mode in the backend sets `mode="DTR"` + `activeStrategy="XXX"` — this is intentional
- The debug endpoint `/api/debug/contracts` now only tests `unit_2_live_True` and `unit_2_live_False` to keep response fast

## Key URLs

| Resource | URL |
|---------|-----|
| Railway backend | https://dtr-range-finder-production.up.railway.app |
| Vercel frontend | https://project-wonf5.vercel.app |
| Supabase | https://gphoaubbvimcetlehvmk.supabase.co |
| Debug account | https://dtr-range-finder-production.up.railway.app/api/debug/account |
| Debug contracts/bars | https://dtr-range-finder-production.up.railway.app/api/debug/contracts |
| Telegram bot | @decanatorfxbot (Craig's chat: @cchaos21, ID: 332762243) |

## Key files changed this session

| File | What changed |
|------|-------------|
| `dtr-complete-final/flask_autonomous_trading.py` | Global JSON error handler, /api/debug/contracts endpoint (bar probe + search), /api/accounts/select returns balance, manual-order uses contract_ids |
| `dtr-complete-final/projectx_api.py` | 3-tier account matching, search_contracts live=False, get_bars: endTime required + unit=2 + bars=null handling |
| `dtr-complete-final/market_data_orchestrator.py` | 3-tier account matching on boot, syncs api.account_id to real API id |
| `artifacts/dtr-dashboard/src/components/account-selector.tsx` | Collapse/expand toggle, localStorage persist, balance preview when collapsed, onAccountChange passes balance |
| `artifacts/dtr-dashboard/src/pages/dashboard.tsx` | overrideBalance state, AccountSelector visibility fix (>=1), onAccountChange sets overrideBalance + invalidates query |
