"""
ProjectX API Client — TopstepX REST API
Base URL: https://api.topstepx.com
"""

import aiohttp
import asyncio
import logging
from typing import Optional, Dict, Any, List
from datetime import datetime, timedelta
import os

logger = logging.getLogger(__name__)


class ProjectXAPI:
    """TopstepX / ProjectX Gateway API Client"""

    def __init__(
        self,
        username: str,
        password: str,
        account_id: str
    ):
        self.username = username
        self.password = password
        self.account_id = account_id
        self.app_id = os.environ.get("PROJECTX_APP_ID", "")
        self.app_version = os.environ.get("PROJECTX_APP_VERSION", "1.0.0")
        self.cid = int(os.environ.get("PROJECTX_CID", "0"))
        self.device_id = os.environ.get("PROJECTX_DEVICE_ID", "dtr-trading-agent-v1")

        self.base_url = os.environ.get("PROJECTX_BASE_URL", "https://api.topstepx.com").rstrip("/")
        self.session: Optional[aiohttp.ClientSession] = None
        self.access_token = None
        self.token_expires_at = None
        self.logger = logging.getLogger(__name__)

    # ═══════════════════════════════════════════════════════════════════════
    # AUTHENTICATION
    # ═══════════════════════════════════════════════════════════════════════

    async def connect(self) -> bool:
        self.session = aiohttp.ClientSession()
        return await self.authenticate()

    async def authenticate(self) -> bool:
        try:
            self.logger.info(f"🔐 Authenticating as {self.username}...")

            auth_data = {
                "userName": self.username,
                "password": self.password,
                "appId": self.app_id,
                "appVersion": self.app_version,
                "cid": self.cid,
                "deviceId": self.device_id,
            }

            async with self.session.post(
                f"{self.base_url}/api/Auth/signIn",
                json=auth_data,
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    if not data.get("success", False):
                        self.logger.error(f"❌ Auth failed: {data}")
                        return False
                    self.access_token = data.get("token")
                    expire_str = data.get("tokenExpireAtUTC")
                    if expire_str:
                        try:
                            self.token_expires_at = datetime.fromisoformat(expire_str.replace("Z", "+00:00"))
                        except Exception:
                            self.token_expires_at = datetime.utcnow() + timedelta(hours=24)
                    else:
                        self.token_expires_at = datetime.utcnow() + timedelta(hours=24)
                    self.logger.info(f"✅ Authenticated. Token expires: {self.token_expires_at}")
                    return True
                else:
                    error = await resp.text()
                    self.logger.error(f"❌ Auth failed: {resp.status} {error}")
                    return False

        except Exception as e:
            self.logger.error(f"❌ Auth error: {e}")
            return False

    async def refresh_token_if_needed(self) -> bool:
        try:
            if not self.token_expires_at:
                return False
            if datetime.utcnow() > (self.token_expires_at.replace(tzinfo=None) - timedelta(hours=1)):
                self.logger.info("🔄 Refreshing access token...")
                async with self.session.post(
                    f"{self.base_url}/api/Auth/refreshToken",
                    json={"oldToken": self.access_token},
                    timeout=aiohttp.ClientTimeout(total=30)
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        if data.get("success"):
                            self.access_token = data.get("token")
                            self.logger.info("✅ Token refreshed")
                            return True
                    return await self.authenticate()
            return True
        except Exception as e:
            self.logger.error(f"❌ Token refresh error: {e}")
            return False

    # ═══════════════════════════════════════════════════════════════════════
    # ACCOUNTS
    # ═══════════════════════════════════════════════════════════════════════

    async def get_accounts(self) -> List[Dict[str, Any]]:
        try:
            await self.refresh_token_if_needed()
            async with self.session.get(
                f"{self.base_url}/api/Account/search",
                params={"onlyActive": "true"},
                headers=self._get_headers(),
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("accounts", [])
                return []
        except Exception as e:
            self.logger.error(f"❌ Error getting accounts: {e}")
            return []

    async def set_active_account(self, account_id: str) -> bool:
        self.account_id = account_id
        return True

    async def get_account(self) -> Optional[Dict[str, Any]]:
        try:
            accounts = await self.get_accounts()
            if not accounts:
                return None
            if self.account_id:
                for acc in accounts:
                    if str(acc.get("id")) == str(self.account_id):
                        return acc
            return accounts[0]
        except Exception as e:
            self.logger.error(f"❌ Error getting account: {e}")
            return None

    async def get_account_balance(self) -> Optional[float]:
        account = await self.get_account()
        return account.get("balance") if account else None

    async def get_account_equity(self) -> Optional[float]:
        account = await self.get_account()
        return account.get("equity") if account else None

    async def get_account_summary(self) -> Optional[Dict[str, Any]]:
        account = await self.get_account()
        if not account:
            return None
        return {
            "balance": account.get("balance"),
            "equity": account.get("equity"),
            "unrealized_pnl": account.get("openPnl", account.get("unrealizedPnl")),
            "realized_pnl": account.get("closedPnl", account.get("realizedPnl")),
            "buying_power": account.get("buyingPower"),
        }

    # ═══════════════════════════════════════════════════════════════════════
    # MARKET DATA
    # ═══════════════════════════════════════════════════════════════════════

    async def get_bars(
        self,
        contract_id: str,
        time_frame: str = "1m",
        limit: int = 100,
        from_time: Optional[str] = None,
        to_time: Optional[str] = None
    ) -> Optional[List[Dict[str, Any]]]:
        try:
            await self.refresh_token_if_needed()
            body = {
                "contractId": int(contract_id) if contract_id.isdigit() else contract_id,
                "live": False,
                "limit": limit,
                "unit": 1,
                "unitNumber": 1,
                "includePartialBar": False,
            }
            if from_time:
                body["startTime"] = from_time
            if to_time:
                body["endTime"] = to_time

            async with self.session.post(
                f"{self.base_url}/api/History/retrieveBars",
                json=body,
                headers=self._get_headers(),
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("bars", [])
                return None
        except Exception as e:
            self.logger.error(f"❌ Error getting bars: {e}")
            return None

    async def search_contracts(self, symbol: str) -> Optional[List[Dict[str, Any]]]:
        try:
            await self.refresh_token_if_needed()
            async with self.session.post(
                f"{self.base_url}/api/Contract/search",
                json={"searchText": symbol, "live": False},
                headers=self._get_headers(),
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("contracts", [])
                return None
        except Exception as e:
            self.logger.error(f"❌ Error searching contracts: {e}")
            return None

    async def list_available_contracts(self) -> Optional[List[Dict[str, Any]]]:
        try:
            await self.refresh_token_if_needed()
            async with self.session.get(
                f"{self.base_url}/api/Contract/searchTradeable",
                headers=self._get_headers(),
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("contracts", [])
                return None
        except Exception as e:
            self.logger.error(f"❌ Error listing contracts: {e}")
            return None

    # ═══════════════════════════════════════════════════════════════════════
    # ORDERS
    # ═══════════════════════════════════════════════════════════════════════

    async def place_order(
        self,
        contract_id: str,
        side: str,
        quantity: int,
        order_type: str = "MARKET",
        limit_price: Optional[float] = None,
        stop_price: Optional[float] = None,
        comment: str = ""
    ) -> Optional[Dict[str, Any]]:
        try:
            await self.refresh_token_if_needed()

            type_map = {"MARKET": 1, "LIMIT": 2, "STOP": 3, "STOP_LIMIT": 4}
            side_map = {"BUY": 0, "LONG": 0, "SELL": 1, "SHORT": 1}

            order_data = {
                "accountId": int(self.account_id) if str(self.account_id).isdigit() else self.account_id,
                "contractId": int(contract_id) if str(contract_id).isdigit() else contract_id,
                "type": type_map.get(order_type.upper(), 1),
                "side": side_map.get(side.upper(), 0),
                "size": quantity,
                "customTag": comment or "dtr-agent",
            }
            if limit_price is not None:
                order_data["limitPrice"] = limit_price
            if stop_price is not None:
                order_data["stopPrice"] = stop_price

            self.logger.info(f"📤 Placing order: {side} {quantity} {contract_id} @ {order_type}")

            async with self.session.post(
                f"{self.base_url}/api/Order/place",
                json=order_data,
                headers=self._get_headers(),
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status in [200, 201]:
                    order = await resp.json()
                    self.logger.info(f"✅ Order placed: {order}")
                    return order
                else:
                    error = await resp.text()
                    self.logger.error(f"❌ Order failed: {resp.status} {error}")
                    return None
        except Exception as e:
            self.logger.error(f"❌ Error placing order: {e}")
            return None

    async def get_open_orders(self) -> List[Dict[str, Any]]:
        try:
            await self.refresh_token_if_needed()
            body = {
                "accountId": int(self.account_id) if str(self.account_id).isdigit() else self.account_id,
            }
            async with self.session.post(
                f"{self.base_url}/api/Order/search",
                json=body,
                headers=self._get_headers(),
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("orders", [])
                return []
        except Exception as e:
            self.logger.error(f"❌ Error getting open orders: {e}")
            return []

    async def search_orders(
        self,
        contract_id: Optional[str] = None,
        status: Optional[str] = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        return await self.get_open_orders()

    async def cancel_order(self, order_id: str) -> bool:
        try:
            await self.refresh_token_if_needed()
            self.logger.info(f"🗑️ Cancelling order: {order_id}")
            async with self.session.post(
                f"{self.base_url}/api/Order/cancel",
                json={"orderId": int(order_id) if str(order_id).isdigit() else order_id},
                headers=self._get_headers(),
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 200:
                    self.logger.info(f"✅ Order cancelled: {order_id}")
                    return True
                return False
        except Exception as e:
            self.logger.error(f"❌ Error cancelling order: {e}")
            return False

    async def modify_order(
        self,
        order_id: str,
        quantity: Optional[int] = None,
        limit_price: Optional[float] = None,
        stop_price: Optional[float] = None
    ) -> bool:
        try:
            await self.refresh_token_if_needed()
            body = {"orderId": int(order_id) if str(order_id).isdigit() else order_id}
            if quantity is not None:
                body["size"] = quantity
            if limit_price is not None:
                body["limitPrice"] = limit_price
            if stop_price is not None:
                body["stopPrice"] = stop_price

            async with self.session.post(
                f"{self.base_url}/api/Order/modify",
                json=body,
                headers=self._get_headers(),
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 200:
                    self.logger.info(f"✅ Order modified: {order_id}")
                    return True
                return False
        except Exception as e:
            self.logger.error(f"❌ Error modifying order: {e}")
            return False

    # ═══════════════════════════════════════════════════════════════════════
    # POSITIONS
    # ═══════════════════════════════════════════════════════════════════════

    async def get_positions(self) -> List[Dict[str, Any]]:
        try:
            await self.refresh_token_if_needed()
            async with self.session.get(
                f"{self.base_url}/api/Position/search",
                params={"accountId": self.account_id},
                headers=self._get_headers(),
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("positions", [])
                return []
        except Exception as e:
            self.logger.error(f"❌ Error getting positions: {e}")
            return []

    async def close_all_positions(self) -> bool:
        try:
            positions = await self.get_positions()
            if not positions:
                return True
            for pos in positions:
                contract = pos.get("contractId", pos.get("contract_id"))
                side = pos.get("side")
                qty = abs(pos.get("size", pos.get("quantity", 1)))
                close_side = "SELL" if side in ["BUY", "LONG", 0] else "BUY"
                await self.place_order(
                    contract_id=str(contract),
                    side=close_side,
                    quantity=qty,
                    order_type="MARKET",
                    comment="CLOSE_ALL_POSITIONS"
                )
            return True
        except Exception as e:
            self.logger.error(f"❌ Error closing positions: {e}")
            return False

    # ═══════════════════════════════════════════════════════════════════════
    # TRADES / FILLS
    # ═══════════════════════════════════════════════════════════════════════

    async def search_trades(
        self,
        contract_id: Optional[str] = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        try:
            await self.refresh_token_if_needed()
            body = {
                "accountId": int(self.account_id) if str(self.account_id).isdigit() else self.account_id,
            }
            if contract_id:
                body["contractId"] = int(contract_id) if str(contract_id).isdigit() else contract_id

            async with self.session.post(
                f"{self.base_url}/api/Fill/search",
                json=body,
                headers=self._get_headers(),
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("fills", data.get("trades", []))
                return []
        except Exception as e:
            self.logger.error(f"❌ Error searching trades: {e}")
            return []

    # ═══════════════════════════════════════════════════════════════════════
    # UTILITIES
    # ═══════════════════════════════════════════════════════════════════════

    def _get_headers(self) -> Dict[str, str]:
        return {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.access_token}",
        }

    async def validate_session(self) -> bool:
        try:
            await self.refresh_token_if_needed()
            account = await self.get_account()
            return account is not None
        except Exception as e:
            self.logger.error(f"❌ Session validation failed: {e}")
            return False

    async def close(self):
        if self.session:
            await self.session.close()
