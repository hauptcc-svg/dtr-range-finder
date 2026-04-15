/**
 * ProjectX API Client
 * Handles authentication and order management for the ProjectX futures trading platform
 */
import { logger } from "./logger";

const BASE_URL = "https://api.topstepx.com";

export interface Bar {
  t: number; // timestamp ms
  o: number; // open
  h: number; // high
  l: number; // low
  c: number; // close
  v: number; // volume
}

export interface AccountInfo {
  id: number;
  name: string;
  balance: number;
  buyingPower: number;
}

export interface OrderResult {
  orderId: string;
  status: string;
}

export interface OpenPosition {
  contractId: string;
  size: number; // positive = long, negative = short (we negate short internally)
  averagePrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
}

export interface ContractInfo {
  id: string; // API returns string IDs
  name: string;
  contractGroupName?: string;
  tickSize?: number;
}

export class ProjectXClient {
  private token: string | null = null;
  private tokenExpiry: number = 0;
  private accountId: number;
  private username: string;
  private apiKey: string;

  constructor(username: string, apiKey: string, accountId: number) {
    this.username = username;
    this.apiKey = apiKey;
    this.accountId = accountId;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    requiresAuth = true
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (requiresAuth) {
      const token = await this.ensureAuthenticated();
      headers["Authorization"] = `Bearer ${token}`;
    }

    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`ProjectX API error ${response.status}: ${text}`);
    }

    const data = await response.json() as { errorCode: number; errorMessage: string } & T;
    if (data.errorCode && data.errorCode !== 0) {
      throw new Error(`ProjectX error ${data.errorCode}: ${data.errorMessage}`);
    }
    return data as T;
  }

  async authenticate(): Promise<void> {
    logger.info({ username: this.username }, "Authenticating with ProjectX");
    const response = await this.request<{ token: string; errorCode: number; errorMessage: string }>(
      "POST",
      "/api/Auth/loginKey",
      {
        userName: this.username,
        apiKey: this.apiKey,
      },
      false
    );
    this.token = response.token;
    // Token expires in ~24h, refresh after 23h
    this.tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
    logger.info("ProjectX authentication successful");
  }

  private async ensureAuthenticated(): Promise<string> {
    if (!this.token || Date.now() > this.tokenExpiry) {
      await this.authenticate();
    }
    return this.token!;
  }

  async getAccountInfo(): Promise<AccountInfo> {
    // POST /api/Account/search with { onlyActiveAccounts: true }
    const response = await this.request<{ accounts: Array<{ id: number; name: string; balance: number; canTrade: boolean; simulated: boolean }> }>(
      "POST",
      "/api/Account/search",
      { onlyActiveAccounts: false }
    );
    const account = response.accounts?.find((a) => a.id === this.accountId);
    if (!account) {
      throw new Error(`Account ${this.accountId} not found in ${JSON.stringify(response.accounts?.map(a => a.id))}`);
    }
    return {
      id: account.id,
      name: account.name,
      balance: account.balance,
      buyingPower: account.balance, // API doesn't expose separate buying power
    };
  }

  async searchContracts(searchText: string): Promise<ContractInfo[]> {
    const response = await this.request<{ contracts: ContractInfo[] }>(
      "POST",
      "/api/Contract/search",
      { searchText, live: false }
    );
    return response.contracts || [];
  }

  async getContractId(symbol: string): Promise<string | null> {
    try {
      const contracts = await this.searchContracts(symbol);
      const match = contracts.find((c) => c.name === symbol);
      return match ? match.id : null;
    } catch (err) {
      logger.error({ err, symbol }, "Failed to get contract ID");
      return null;
    }
  }

  /**
   * Fetch 1-minute OHLCV bars for a contract
   */
  async getBars(
    contractId: string,
    startTime: Date,
    endTime: Date
  ): Promise<Bar[]> {
    const response = await this.request<{ bars: Bar[] }>(
      "POST",
      "/api/History/retrieveBars",
      {
        contractId,
        live: false,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        unit: 2, // minutes
        unitNumber: 1,
        limit: 500,
        includePartialBar: false,
      }
    );
    return response.bars || [];
  }

  /**
   * Get last trade price for a contract (from recent bar close)
   */
  async getLastPrice(contractId: string): Promise<number | null> {
    try {
      const now = new Date();
      const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
      const bars = await this.getBars(contractId, fiveMinAgo, now);
      if (bars.length === 0) return null;
      return bars[bars.length - 1].c;
    } catch {
      return null;
    }
  }

  /**
   * Place a bracket order: market entry + stop loss + take profit(s).
   *
   * API OrderSide: 0 = Bid (Buy), 1 = Ask (Sell)
   * OrderType:     1 = Limit, 2 = Market, 4 = Stop
   */
  async placeBracketOrder(params: {
    contractId: string;
    isBuy: boolean;
    qty: number;
    stopPrice: number;
    tp1Price: number;
    tp2Price?: number;
  }): Promise<OrderResult> {
    logger.info({ params }, "Placing bracket order");

    // 0 = Bid (buy), 1 = Ask (sell)
    const entrySide = params.isBuy ? 0 : 1;
    // Closing side is opposite
    const closeSide = params.isBuy ? 1 : 0;

    // 1. Market entry order
    const entryResponse = await this.request<{ orderId: number; success: boolean; errorCode: number; errorMessage: string }>(
      "POST",
      "/api/Order/place",
      {
        accountId: this.accountId,
        contractId: params.contractId,
        type: 2, // Market
        side: entrySide,
        size: params.qty,
        limitPrice: null,
        stopPrice: null,
        trailPrice: null,
        customTag: `dtr_entry_${Date.now()}`,
      }
    );

    if (!entryResponse.success) {
      throw new Error(`Entry order failed (${entryResponse.errorCode}): ${entryResponse.errorMessage}`);
    }

    const entryOrderId = String(entryResponse.orderId);
    logger.info({ entryOrderId }, "Entry order placed, attaching SL/TP");

    // 2. Stop loss
    await this.request(
      "POST",
      "/api/Order/place",
      {
        accountId: this.accountId,
        contractId: params.contractId,
        type: 4, // Stop
        side: closeSide,
        size: params.qty,
        limitPrice: null,
        stopPrice: params.stopPrice,
        trailPrice: null,
        customTag: `dtr_sl_${Date.now()}`,
      }
    );

    // 3. TP1 limit order
    const tp1Qty = params.tp2Price && params.qty > 1 ? Math.ceil(params.qty / 2) : params.qty;
    await this.request(
      "POST",
      "/api/Order/place",
      {
        accountId: this.accountId,
        contractId: params.contractId,
        type: 1, // Limit
        side: closeSide,
        size: tp1Qty,
        limitPrice: params.tp1Price,
        stopPrice: null,
        trailPrice: null,
        customTag: `dtr_tp1_${Date.now()}`,
      }
    );

    // 4. TP2 limit order (optional, remaining qty)
    if (params.tp2Price && params.qty > 1) {
      const tp2Qty = Math.floor(params.qty / 2);
      await this.request(
        "POST",
        "/api/Order/place",
        {
          accountId: this.accountId,
          contractId: params.contractId,
          type: 1, // Limit
          side: closeSide,
          size: tp2Qty,
          limitPrice: params.tp2Price,
          stopPrice: null,
          trailPrice: null,
          customTag: `dtr_tp2_${Date.now()}`,
        }
      );
    }

    logger.info({ entryOrderId }, "Bracket order fully placed");
    return { orderId: entryOrderId, status: "placed" };
  }

  /**
   * Get open positions for the account.
   * API returns PositionModel.type: 1=Long, 2=Short with size always positive.
   * We normalise to negative size for short positions internally.
   */
  async getOpenPositions(): Promise<OpenPosition[]> {
    const response = await this.request<{
      positions: Array<{
        id: number;
        accountId: number;
        contractId: string;
        contractDisplayName: string;
        creationTimestamp: string;
        type: number; // 1=Long, 2=Short
        size: number;
        averagePrice: number;
      }>;
    }>(
      "POST",
      "/api/Position/searchOpen",
      { accountId: this.accountId }
    );
    return (response.positions || []).map((p) => ({
      contractId: p.contractId,
      size: p.type === 2 ? -p.size : p.size, // short = negative
      averagePrice: p.averagePrice,
      unrealizedPnl: 0, // not provided by this endpoint
      realizedPnl: 0,
    }));
  }

  /**
   * Close position for a specific contract using the dedicated close endpoint.
   * Falls back to a market order if the close endpoint fails.
   */
  async closePositionForContract(contractId: string): Promise<void> {
    logger.info({ contractId }, "Closing position for contract");
    try {
      await this.request(
        "POST",
        "/api/Position/closeContract",
        {
          accountId: this.accountId,
          contractId,
        }
      );
      logger.info({ contractId }, "Position closed via closeContract");
    } catch (err) {
      logger.warn({ err, contractId }, "closeContract failed — attempting manual market close");
      // Fallback: look up position direction and place a market order
      const positions = await this.getOpenPositions();
      const pos = positions.find((p) => p.contractId === contractId);
      if (!pos || pos.size === 0) {
        logger.info({ contractId }, "No open position to close");
        return;
      }
      const isBuy = pos.size < 0; // short (negative) needs buy to close
      await this.request(
        "POST",
        "/api/Order/place",
        {
          accountId: this.accountId,
          contractId,
          type: 2, // Market
          side: isBuy ? 0 : 1, // 0=Bid/Buy, 1=Ask/Sell
          size: Math.abs(pos.size),
          limitPrice: null,
          stopPrice: null,
          trailPrice: null,
          customTag: `dtr_close_${Date.now()}`,
        }
      );
      logger.info({ contractId, size: pos.size }, "Fallback close order placed");
    }
  }

  /**
   * Cancel all open orders for the account (end-of-day cleanup).
   * The API has no bulk-cancel endpoint, so we search + cancel each individually.
   */
  async cancelAllOrders(): Promise<void> {
    logger.info("Cancelling all open orders");
    let openOrders: Array<{ id: number }> = [];
    try {
      const response = await this.request<{ orders: Array<{ id: number; status: number }> }>(
        "POST",
        "/api/Order/searchOpen",
        { accountId: this.accountId }
      );
      // Status 1 = Open, 6 = Pending
      openOrders = (response.orders || []).filter((o) => o.status === 1 || o.status === 6);
    } catch (err) {
      logger.error({ err }, "Failed to fetch open orders for cancellation");
      return;
    }

    logger.info({ count: openOrders.length }, "Cancelling open orders");
    for (const order of openOrders) {
      try {
        await this.request(
          "POST",
          "/api/Order/cancel",
          { accountId: this.accountId, orderId: order.id }
        );
        logger.debug({ orderId: order.id }, "Order cancelled");
      } catch (err) {
        logger.warn({ err, orderId: order.id }, "Failed to cancel order");
      }
    }
  }
}

// Singleton instance
let clientInstance: ProjectXClient | null = null;

export function getProjectXClient(): ProjectXClient {
  if (!clientInstance) {
    const username = process.env.PROJECTX_USERNAME;
    const apiKey = process.env.PROJECTX_API_KEY;
    const accountId = parseInt(process.env.PROJECTX_ACCOUNT_ID || "0", 10);

    if (!username || !apiKey || !accountId) {
      throw new Error(
        "Missing ProjectX credentials: PROJECTX_USERNAME, PROJECTX_API_KEY, PROJECTX_ACCOUNT_ID"
      );
    }

    clientInstance = new ProjectXClient(username, apiKey, accountId);
  }
  return clientInstance;
}
