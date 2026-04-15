/**
 * ProjectX API Client
 * Handles authentication and order management for the ProjectX futures trading platform
 */
import { logger } from "./logger";

const BASE_URL = "https://gateway.main.topstepx.com";

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
  size: number; // positive = long, negative = short
  averagePrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
}

export interface ContractInfo {
  id: number;
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
    const response = await this.request<{ accounts: AccountInfo[] }>(
      "GET",
      "/api/Account/search"
    );
    const account = response.accounts?.find((a) => a.id === this.accountId);
    if (!account) {
      throw new Error(`Account ${this.accountId} not found`);
    }
    return account;
  }

  async searchContracts(searchText: string): Promise<ContractInfo[]> {
    const response = await this.request<{ contracts: ContractInfo[] }>(
      "POST",
      "/api/Contract/search",
      { searchText, live: false }
    );
    return response.contracts || [];
  }

  async getContractId(symbol: string): Promise<number | null> {
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
    contractId: number,
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
  async getLastPrice(contractId: number): Promise<number | null> {
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
   * Place a bracket order (entry + stop + TP)
   */
  async placeBracketOrder(params: {
    contractId: number;
    isBuy: boolean;
    qty: number;
    stopPrice: number;
    tp1Price: number;
    tp2Price?: number;
  }): Promise<OrderResult> {
    logger.info({ params }, "Placing bracket order");

    // Place market entry order
    const entryResponse = await this.request<{ orderId: string }>(
      "POST",
      "/api/Order/place",
      {
        accountId: this.accountId,
        contractId: params.contractId,
        type: 2, // Market
        side: params.isBuy ? 1 : 2, // 1=Buy, 2=Sell
        size: params.qty,
        limitPrice: null,
        stopPrice: null,
        trailPrice: null,
        customTag: `dtr_entry_${Date.now()}`,
        linkedOrderId: null,
      }
    );

    // Place stop loss order
    const slSide = params.isBuy ? 2 : 1; // opposite direction
    await this.request(
      "POST",
      "/api/Order/place",
      {
        accountId: this.accountId,
        contractId: params.contractId,
        type: 3, // Stop
        side: slSide,
        size: params.qty,
        limitPrice: null,
        stopPrice: params.stopPrice,
        trailPrice: null,
        customTag: `dtr_sl_${Date.now()}`,
        linkedOrderId: entryResponse.orderId,
      }
    );

    // Place TP1 limit order
    await this.request(
      "POST",
      "/api/Order/place",
      {
        accountId: this.accountId,
        contractId: params.contractId,
        type: 1, // Limit
        side: slSide,
        size: params.tp2Price ? Math.ceil(params.qty / 2) : params.qty,
        limitPrice: params.tp1Price,
        stopPrice: null,
        trailPrice: null,
        customTag: `dtr_tp1_${Date.now()}`,
        linkedOrderId: entryResponse.orderId,
      }
    );

    // Place TP2 limit order if specified
    if (params.tp2Price && params.qty > 1) {
      await this.request(
        "POST",
        "/api/Order/place",
        {
          accountId: this.accountId,
          contractId: params.contractId,
          type: 1, // Limit
          side: slSide,
          size: Math.floor(params.qty / 2),
          limitPrice: params.tp2Price,
          stopPrice: null,
          trailPrice: null,
          customTag: `dtr_tp2_${Date.now()}`,
          linkedOrderId: entryResponse.orderId,
        }
      );
    }

    logger.info({ orderId: entryResponse.orderId }, "Bracket order placed");
    return { orderId: entryResponse.orderId, status: "placed" };
  }

  /**
   * Get open positions for the account
   */
  async getOpenPositions(): Promise<OpenPosition[]> {
    const response = await this.request<{ positions: OpenPosition[] }>(
      "POST",
      "/api/Position/searchOpen",
      { accountId: this.accountId }
    );
    return response.positions || [];
  }

  /**
   * Close all positions for a specific contract
   */
  async closePositionForContract(contractId: number): Promise<void> {
    logger.info({ contractId }, "Closing position for contract");
    const positions = await this.getOpenPositions();
    const pos = positions.find((p) => {
      // contractId stored as string or number
      return String(p.contractId) === String(contractId);
    });

    if (!pos || pos.size === 0) {
      logger.info({ contractId }, "No open position to close");
      return;
    }

    // Market order to flatten
    const isBuy = pos.size < 0; // short position needs buy to close
    await this.request(
      "POST",
      "/api/Order/place",
      {
        accountId: this.accountId,
        contractId,
        type: 2, // Market
        side: isBuy ? 1 : 2,
        size: Math.abs(pos.size),
        limitPrice: null,
        stopPrice: null,
        trailPrice: null,
        customTag: `dtr_close_${Date.now()}`,
        linkedOrderId: null,
      }
    );

    logger.info({ contractId, size: pos.size }, "Close order placed");
  }

  /**
   * Cancel all open orders for the account (end-of-day cleanup)
   */
  async cancelAllOrders(): Promise<void> {
    logger.info("Cancelling all open orders");
    await this.request(
      "POST",
      "/api/Order/cancelAll",
      { accountId: this.accountId }
    );
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
