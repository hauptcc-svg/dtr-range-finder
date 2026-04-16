"""
ProjectX API Client
===================
Complete REST API integration for DTR Trading Agent
Handles authentication, market data, orders, positions, and account management
"""

import aiohttp
import aiohttp.resolver
import asyncio
import logging
from typing import Optional, Dict, Any, List
from datetime import datetime, timedelta
import os

logger = logging.getLogger(__name__)


class ProjectXAPI:
    """ProjectX Gateway API Client"""
    
    def __init__(
        self,
        username: str,
        api_key: str,
        account_id: str
    ):
        self.username = username
        self.api_key = api_key
        self.account_id = account_id
        
        self.base_url = "https://gateway.projectx.com"
        self.session: Optional[aiohttp.ClientSession] = None
        self.access_token = None
        self.refresh_token = None
        self.token_expires_at = None
        self.logger = logging.getLogger(__name__)
    
    # ═══════════════════════════════════════════════════════════════════════
    # AUTHENTICATION
    # ═══════════════════════════════════════════════════════════════════════
    
    async def connect(self) -> bool:
        """Connect and authenticate to ProjectX"""
        # Use ThreadedResolver so aiohttp falls back to the system's standard
        # DNS resolver (getaddrinfo in a thread pool) — required on Replit where
        # the default async DNS resolver cannot resolve external hostnames.
        resolver = aiohttp.resolver.ThreadedResolver()
        connector = aiohttp.TCPConnector(resolver=resolver)
        self.session = aiohttp.ClientSession(connector=connector)
        return await self.authenticate()
    
    async def authenticate(self) -> bool:
        """Login and get access token using API key"""
        try:
            self.logger.info(f"🔐 Authenticating as {self.username} (API key)...")
            
            auth_data = {
                "userName": self.username,
                "apiKey": self.api_key
            }
            
            async with self.session.post(
                f"{self.base_url}/api/Auth/loginKey",
                json=auth_data,
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    self.access_token = data.get("token") or data.get("access_token")
                    self.refresh_token = data.get("refresh_token")
                    expires_in = data.get("expires_in", 86400)
                    self.token_expires_at = datetime.now() + timedelta(seconds=expires_in)
                    
                    self.logger.info(f"✅ Authenticated successfully")
                    self.logger.info(f"   Token expires: {self.token_expires_at}")
                    return True
                else:
                    error = await resp.text()
                    self.logger.error(f"❌ Auth failed: {resp.status} {error}")
                    return False
        
        except Exception as e:
            self.logger.error(f"❌ Auth error: {e}")
            return False
    
    async def refresh_token_if_needed(self) -> bool:
        """Refresh token if expired or close to expiration"""
        try:
            if not self.token_expires_at:
                return False
            
            # Refresh if less than 1 hour remaining
            if datetime.now() > (self.token_expires_at - timedelta(hours=1)):
                self.logger.info("🔄 Refreshing access token...")
                
                refresh_data = {
                    "refresh_token": self.refresh_token
                }
                
                async with self.session.post(
                    f"{self.base_url}/auth/refresh",
                    json=refresh_data,
                    timeout=aiohttp.ClientTimeout(total=30)
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        self.access_token = data.get("access_token")
                        expires_in = data.get("expires_in", 86400)
                        self.token_expires_at = datetime.now() + timedelta(seconds=expires_in)
                        self.logger.info("✅ Token refreshed")
                        return True
                    else:
                        self.logger.error(f"❌ Token refresh failed: {resp.status}")
                        return await self.authenticate()
            
            return True
        
        except Exception as e:
            self.logger.error(f"❌ Token refresh error: {e}")
            return False
    
    # ═══════════════════════════════════════════════════════════════════════
    # MARKET DATA API
    # ═══════════════════════════════════════════════════════════════════════
    
    async def get_bars(
        self,
        contract_id: str,
        time_frame: str = "1m",
        limit: int = 100,
        from_time: Optional[str] = None,
        to_time: Optional[str] = None
    ) -> Optional[List[Dict[str, Any]]]:
        """Get OHLC bars for a contract"""
        try:
            await self.refresh_token_if_needed()
            
            params = {
                "contract_id": contract_id,
                "time_frame": time_frame,
                "limit": limit
            }
            
            if from_time:
                params["from"] = from_time
            if to_time:
                params["to"] = to_time
            
            async with self.session.get(
                f"{self.base_url}/v1/bars/retrieve",
                params=params,
                headers=self._get_headers(),
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    bars = data.get("bars", [])
                    self.logger.debug(f"✓ Retrieved {len(bars)} bars for {contract_id}")
                    return bars
                else:
                    self.logger.error(f"❌ Error getting bars: {resp.status}")
                    return None
        
        except Exception as e:
            self.logger.error(f"❌ Error getting bars: {e}")
            return None
    
    async def search_contracts(self, symbol: str) -> Optional[List[Dict[str, Any]]]:
        """Search for contracts by symbol"""
        try:
            await self.refresh_token_if_needed()
            
            async with self.session.get(
                f"{self.base_url}/v1/contracts/search",
                params={"symbol": symbol},
                headers=self._get_headers(),
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("contracts", [])
                else:
                    return None
        
        except Exception as e:
            self.logger.error(f"❌ Error searching contracts: {e}")
            return None
    
    async def list_available_contracts(self) -> Optional[List[Dict[str, Any]]]:
        """List all available contracts"""
        try:
            await self.refresh_token_if_needed()
            
            async with self.session.get(
                f"{self.base_url}/v1/contracts/available",
                headers=self._get_headers(),
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("contracts", [])
                else:
                    return None
        
        except Exception as e:
            self.logger.error(f"❌ Error listing contracts: {e}")
            return None
    
    # ═══════════════════════════════════════════════════════════════════════
    # ORDERS API
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
        """Place an order"""
        try:
            await self.refresh_token_if_needed()
            
            order_data = {
                "contract_id": contract_id,
                "side": side,
                "quantity": quantity,
                "order_type": order_type,
                "comment": comment
            }
            
            if limit_price is not None:
                order_data["limit_price"] = limit_price
            if stop_price is not None:
                order_data["stop_price"] = stop_price
            
            self.logger.info(f"📤 Placing order: {side} {quantity} {contract_id} @ {order_type}")
            
            async with self.session.post(
                f"{self.base_url}/v1/orders/place",
                json=order_data,
                headers=self._get_headers(),
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status in [200, 201]:
                    order = await resp.json()
                    order_id = order.get("order_id")
                    status = order.get("status")
                    
                    self.logger.info(f"✅ Order placed: {order_id} ({status})")
                    return order
                else:
                    error = await resp.text()
                    self.logger.error(f"❌ Order failed: {resp.status} {error}")
                    return None
        
        except Exception as e:
            self.logger.error(f"❌ Error placing order: {e}")
            return None
    
    async def get_open_orders(self) -> List[Dict[str, Any]]:
        """Get all open orders"""
        try:
            await self.refresh_token_if_needed()
            
            async with self.session.get(
                f"{self.base_url}/v1/orders/open",
                headers=self._get_headers(),
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    orders = data.get("orders", [])
                    return orders
                else:
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
        """Search for orders"""
        try:
            await self.refresh_token_if_needed()
            
            params = {"limit": limit}
            if contract_id:
                params["contract_id"] = contract_id
            if status:
                params["status"] = status
            
            async with self.session.get(
                f"{self.base_url}/v1/orders/search",
                params=params,
                headers=self._get_headers(),
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("orders", [])
                else:
                    return []
        
        except Exception as e:
            self.logger.error(f"❌ Error searching orders: {e}")
            return []
    
    async def cancel_order(self, order_id: str) -> bool:
        """Cancel an order"""
        try:
            await self.refresh_token_if_needed()
            
            self.logger.info(f"🗑️ Cancelling order: {order_id}")
            
            async with self.session.delete(
                f"{self.base_url}/v1/orders/cancel/{order_id}",
                headers=self._get_headers(),
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 200:
                    self.logger.info(f"✅ Order cancelled: {order_id}")
                    return True
                else:
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
        """Modify an open order"""
        try:
            await self.refresh_token_if_needed()
            
            modify_data = {}
            if quantity is not None:
                modify_data["quantity"] = quantity
            if limit_price is not None:
                modify_data["limit_price"] = limit_price
            if stop_price is not None:
                modify_data["stop_price"] = stop_price
            
            async with self.session.put(
                f"{self.base_url}/v1/orders/modify/{order_id}",
                json=modify_data,
                headers=self._get_headers(),
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 200:
                    self.logger.info(f"✅ Order modified: {order_id}")
                    return True
                else:
                    return False
        
        except Exception as e:
            self.logger.error(f"❌ Error modifying order: {e}")
            return False
    
    # ═══════════════════════════════════════════════════════════════════════
    # POSITIONS API
    # ═══════════════════════════════════════════════════════════════════════
    
    async def get_positions(self) -> List[Dict[str, Any]]:
        """Get all open positions"""
        try:
            await self.refresh_token_if_needed()
            
            async with self.session.get(
                f"{self.base_url}/v1/positions",
                headers=self._get_headers(),
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    positions = data.get("positions", [])
                    return positions
                else:
                    return []
        
        except Exception as e:
            self.logger.error(f"❌ Error getting positions: {e}")
            return []
    
    async def close_all_positions(self) -> bool:
        """Close all open positions at market"""
        try:
            positions = await self.get_positions()
            if not positions:
                return True
            
            for pos in positions:
                contract = pos.get("contract_id")
                side = pos.get("side")
                qty = pos.get("quantity")
                
                close_side = "SELL" if side == "LONG" else "BUY"
                
                await self.place_order(
                    contract_id=contract,
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
    # ACCOUNT API
    # ═══════════════════════════════════════════════════════════════════════
    
    async def get_account(self) -> Optional[Dict[str, Any]]:
        """Get account details"""
        try:
            await self.refresh_token_if_needed()
            
            async with self.session.get(
                f"{self.base_url}/v1/account/{self.account_id}",
                headers=self._get_headers(),
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data
                else:
                    return None
        
        except Exception as e:
            self.logger.error(f"❌ Error getting account: {e}")
            return None
    
    async def get_account_balance(self) -> Optional[float]:
        """Get current account balance"""
        try:
            account = await self.get_account()
            if account:
                return account.get("balance")
            return None
        except Exception as e:
            self.logger.error(f"❌ Error getting balance: {e}")
            return None
    
    async def get_account_equity(self) -> Optional[float]:
        """Get current account equity"""
        try:
            account = await self.get_account()
            if account:
                return account.get("equity")
            return None
        except Exception as e:
            self.logger.error(f"❌ Error getting equity: {e}")
            return None
    
    async def get_account_summary(self) -> Optional[Dict[str, Any]]:
        """Get account summary"""
        try:
            account = await self.get_account()
            if account:
                return {
                    "balance": account.get("balance"),
                    "equity": account.get("equity"),
                    "unrealized_pnl": account.get("unrealized_pnl"),
                    "realized_pnl": account.get("realized_pnl"),
                    "buying_power": account.get("buying_power"),
                }
            return None
        except Exception as e:
            self.logger.error(f"❌ Error getting summary: {e}")
            return None
    
    # ═══════════════════════════════════════════════════════════════════════
    # TRADES API
    # ═══════════════════════════════════════════════════════════════════════
    
    async def search_trades(
        self,
        contract_id: Optional[str] = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """Search for trades"""
        try:
            await self.refresh_token_if_needed()
            
            params = {"limit": limit}
            if contract_id:
                params["contract_id"] = contract_id
            
            async with self.session.get(
                f"{self.base_url}/v1/trades/search",
                params=params,
                headers=self._get_headers(),
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("trades", [])
                else:
                    return []
        
        except Exception as e:
            self.logger.error(f"❌ Error searching trades: {e}")
            return []
    
    # ═══════════════════════════════════════════════════════════════════════
    # UTILITIES
    # ═══════════════════════════════════════════════════════════════════════
    
    def _get_headers(self) -> Dict[str, str]:
        """Get request headers with authentication"""
        return {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.access_token}",
        }
    
    async def validate_session(self) -> bool:
        """Validate that the session is still active"""
        try:
            await self.refresh_token_if_needed()
            account = await self.get_account()
            return account is not None
        except Exception as e:
            self.logger.error(f"❌ Session validation failed: {e}")
            return False
    
    async def close(self):
        """Close the session"""
        if self.session:
            await self.session.close()
