import { useState, useEffect, Fragment } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useGetAgentStatus,
  useGetInstruments,
  useStartAgent,
  useStopAgent,
  useGetPositions,
  useClosePosition,
  getGetAgentStatusQueryKey,
  getGetInstrumentsQueryKey,
  getGetPositionsQueryKey,
} from "@workspace/api-client-react";
import {
  Play, Square, Activity, AlertCircle, KeyRound, LogOut, Brain,
  CheckCircle, XCircle, BarChart2, ShieldAlert, Lock, Zap, Clock,
  TrendingUp, Wallet, TrendingDown, DollarSign, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { InstrumentCard } from "@/components/instrument-card";
import { AccountSelector } from "@/components/account-selector";
import { EquityCurve } from "@/components/equity-curve";
import { formatSessionPhase, formatCurrency, formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// ConnectModal
// ---------------------------------------------------------------------------
function ConnectModal({ onConnected }: { onConnected: () => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const connect = useMutation({
    mutationFn: async (agentKey: string) => {
      const res = await fetch("/api/agent/session", {
        method: "POST",
        credentials: "include",
        headers: { "x-agent-key": agentKey },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error((body.error as string) ?? "Authentication failed");
      }
      return res.json();
    },
    onSuccess: () => { setKey(""); setError(null); onConnected(); },
    onError: (err: Error) => { setError(err.message); },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 backdrop-blur-sm">
      <Card className="w-full max-w-sm bg-card border-border">
        <CardHeader className="border-b border-border/50">
          <CardTitle className="font-mono flex items-center gap-2 text-base">
            <KeyRound className="w-4 h-4 text-primary" />
            AGENT AUTHENTICATION
          </CardTitle>
        </CardHeader>
        <CardContent className="py-6 space-y-4">
          <p className="text-xs text-muted-foreground font-mono">
            Enter the AGENT_CONTROL_SECRET to authenticate this session.
          </p>
          <Input
            type="password"
            placeholder="Agent control secret"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && connect.mutate(key)}
            className="font-mono"
            autoFocus
          />
          {error && <p className="text-xs text-destructive font-mono">{error}</p>}
          <Button
            className="w-full font-mono font-bold"
            disabled={!key || connect.isPending}
            onClick={() => connect.mutate(key)}
          >
            {connect.isPending ? "Authenticating…" : "Connect"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AccountStatsBar — slim top strip
// ---------------------------------------------------------------------------
interface AccountStatsBarProps {
  balance: number | null;
  drawdown: number;
  realizedPnl: number;
  unrealizedPnl: number;
}

function AccountStatsBar({ balance, drawdown, realizedPnl, unrealizedPnl }: AccountStatsBarProps) {
  const stats = [
    {
      label: "Balance",
      value: balance != null ? formatCurrency(balance) : "---",
      icon: <Wallet className="w-3 h-3" />,
      colorClass: "text-foreground",
    },
    {
      label: "Drawdown",
      value: drawdown < 0 ? formatCurrency(drawdown) : "+$0.00",
      icon: <TrendingDown className="w-3 h-3" />,
      colorClass: drawdown < 0 ? "text-destructive" : "text-muted-foreground",
    },
    {
      label: "Realized P&L",
      value: formatCurrency(realizedPnl),
      icon: <DollarSign className="w-3 h-3" />,
      colorClass: realizedPnl > 0 ? "text-success" : realizedPnl < 0 ? "text-destructive" : "text-muted-foreground",
    },
    {
      label: "Unrealized P&L",
      value: formatCurrency(unrealizedPnl),
      icon: <TrendingUp className="w-3 h-3" />,
      colorClass: unrealizedPnl > 0 ? "text-success" : unrealizedPnl < 0 ? "text-destructive" : "text-muted-foreground",
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {stats.map((s) => (
        <div key={s.label} className="stat-pill flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            {s.icon}
            <span className="text-[9px] font-mono uppercase tracking-widest">{s.label}</span>
          </div>
          <span className={cn("font-mono font-bold text-base leading-none", s.colorClass)}>
            {s.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OpenTradesInline — compact positions table for the dashboard
// ---------------------------------------------------------------------------
function OpenTradesInline({ isAuthenticated }: { isAuthenticated: boolean }) {
  const queryClient = useQueryClient();
  const { data: positions, isLoading } = useGetPositions({
    query: { queryKey: getGetPositionsQueryKey(), refetchInterval: 3000 }
  });
  const [closingSymbol, setClosingSymbol] = useState<string | null>(null);
  const [closeMessage, setCloseMessage] = useState<{ symbol: string; text: string; ok: boolean } | null>(null);

  const { mutate: closePosition } = useClosePosition({
    mutation: {
      onSuccess: (data, variables) => {
        setClosingSymbol(null);
        setCloseMessage({ symbol: variables.symbol, text: data.message, ok: data.success });
        queryClient.invalidateQueries({ queryKey: getGetPositionsQueryKey() });
        setTimeout(() => setCloseMessage(null), 5000);
      },
      onError: (_err, variables) => {
        setClosingSymbol(null);
        setCloseMessage({ symbol: variables.symbol, text: "Close request failed", ok: false });
        setTimeout(() => setCloseMessage(null), 5000);
      },
    },
  });

  const handleClose = (symbol: string) => {
    setClosingSymbol(symbol);
    setCloseMessage(null);
    closePosition({ symbol });
  };

  if (isLoading) {
    return (
      <div className="space-y-2 pt-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  if (!positions || positions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-2 text-muted-foreground">
        <Activity className="w-7 h-7 opacity-30" />
        <span className="text-xs font-mono">No open positions</span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {closeMessage && (
        <div className={cn(
          "rounded px-3 py-1.5 font-mono text-[11px]",
          closeMessage.ok ? "bg-success/10 text-success border border-success/30" : "bg-destructive/10 text-destructive border border-destructive/30"
        )}>
          {closeMessage.symbol}: {closeMessage.text}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] font-mono">
          <thead>
            <tr className="text-muted-foreground border-b border-border/50">
              <th className="text-left pb-1.5 pr-3 font-bold tracking-wider">INSTRUMENT</th>
              <th className="text-left pb-1.5 pr-2 font-bold tracking-wider">DIR</th>
              <th className="text-left pb-1.5 pr-2 font-bold tracking-wider">SIZE</th>
              <th className="text-right pb-1.5 pr-2 font-bold tracking-wider">ENTRY</th>
              <th className="text-right pb-1.5 pr-2 font-bold tracking-wider">CURRENT</th>
              <th className="text-right pb-1.5 pr-2 font-bold tracking-wider">UNREAL PNL</th>
              <th className="text-center pb-1.5 font-bold tracking-wider">CLOSE</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => (
              <tr key={position.instrument} className="border-b border-border/20 last:border-0 even:bg-white/[0.02] hover:bg-muted/30 transition-colors">
                <td className="py-2 pr-3 font-bold text-foreground">{position.instrument}</td>
                <td className={cn("py-2 pr-2 font-bold", position.direction === "long" ? "text-success" : "text-destructive")}>
                  {position.direction.toUpperCase()}
                </td>
                <td className="py-2 pr-2 text-muted-foreground">{position.size}</td>
                <td className="py-2 pr-2 text-right text-muted-foreground">{formatPrice(position.entryPrice)}</td>
                <td className="py-2 pr-2 text-right font-medium">{formatPrice(position.currentPrice)}</td>
                <td className={cn("py-2 pr-2 text-right font-bold",
                  position.unrealizedPnl > 0 ? "text-success" : position.unrealizedPnl < 0 ? "text-destructive" : "text-muted-foreground"
                )}>
                  {formatCurrency(position.unrealizedPnl)}
                </td>
                <td className="py-2 text-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleClose(position.instrument)}
                    disabled={!isAuthenticated || closingSymbol === position.instrument}
                    className="h-7 px-2 font-mono text-[10px] text-destructive hover:text-destructive hover:bg-destructive/10 border border-destructive/30"
                  >
                    {closingSymbol === position.instrument ? "…" : <><X className="h-3 w-3 mr-1" />CLOSE</>}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RiskControlsCard
// ---------------------------------------------------------------------------
interface RiskSettings {
  dailyLossLimit: number;
  dailyProfitTarget: number;
  maxTradesPerDay: number;
  maxLossesPerDirection: number;
  tradingLocked: boolean;
  instruments?: Record<string, { enabled: boolean; qty: number }>;
}

function RiskControlsCard() {
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery<RiskSettings>({
    queryKey: ["agentSettings"],
    queryFn: () => fetch("/api/agent/settings", { credentials: "include" }).then(r => r.json()),
    refetchInterval: 10000,
  });

  const [form, setForm] = useState<{
    dailyLossLimit: string;
    dailyProfitTarget: string;
    maxTradesPerDay: string;
    maxLossesPerDirection: string;
  } | null>(null);

  const [instrQty, setInstrQty] = useState<Record<string, number>>({});
  const [feedback, setFeedback] = useState<{ msg: string; error: boolean } | null>(null);

  useEffect(() => {
    if (settings && !form) {
      setForm({
        dailyLossLimit: String(settings.dailyLossLimit),
        dailyProfitTarget: String(settings.dailyProfitTarget),
        maxTradesPerDay: String(settings.maxTradesPerDay),
        maxLossesPerDirection: String(settings.maxLossesPerDirection),
      });
    }
    if (settings?.instruments && Object.keys(instrQty).length === 0) {
      const initial: Record<string, number> = {};
      for (const [sym, cfg] of Object.entries(settings.instruments)) {
        initial[sym] = cfg.qty ?? 1;
      }
      setInstrQty(initial);
    }
  }, [settings, form, instrQty]);

  const saveSettings = useMutation({
    mutationFn: async () => {
      if (!form) throw new Error("Form not ready");
      const payload: Record<string, number | null | Record<string, number>> = {
        dailyLossLimit: Number(form.dailyLossLimit),
        dailyProfitTarget: Number(form.dailyProfitTarget),
        maxTradesPerDay: form.maxTradesPerDay !== "" ? Number(form.maxTradesPerDay) : null,
        maxLossesPerDirection: form.maxLossesPerDirection !== "" ? Number(form.maxLossesPerDirection) : null,
        instrument_qty: instrQty,
      };
      const res = await fetch("/api/agent/settings", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Request failed");
      return data;
    },
    onSuccess: () => {
      setFeedback({ msg: "✅ Settings saved", error: false });
      queryClient.invalidateQueries({ queryKey: ["agentSettings"] });
      setTimeout(() => setFeedback(null), 4000);
    },
    onError: (err: Error) => { setFeedback({ msg: "❌ " + err.message, error: true }); },
  });

  const liquidateAll = useMutation({
    mutationFn: async () => {
      if (!confirm("⚠️ LIQUIDATE ALL — Close all open positions now?")) throw new Error("Cancelled");
      const res = await fetch("/api/agent/liquidate", { method: "POST", credentials: "include" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message ?? "Request failed");
      return data;
    },
    onSuccess: (data: { message: string }) => {
      setFeedback({ msg: "🔴 " + data.message, error: false });
      setTimeout(() => setFeedback(null), 5000);
    },
    onError: (err: Error) => { if (err.message !== "Cancelled") setFeedback({ msg: "❌ " + err.message, error: true }); },
  });

  const lockTrading = useMutation({
    mutationFn: async () => {
      if (!confirm("🔒 LOCK TRADING — Disable all new entries until restart?")) throw new Error("Cancelled");
      const res = await fetch("/api/agent/lock", { method: "POST", credentials: "include" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message ?? "Request failed");
      return data;
    },
    onSuccess: () => {
      setFeedback({ msg: "🔒 Trading locked", error: false });
      queryClient.invalidateQueries({ queryKey: ["agentSettings"] });
      setTimeout(() => setFeedback(null), 5000);
    },
    onError: (err: Error) => { if (err.message !== "Cancelled") setFeedback({ msg: "❌ " + err.message, error: true }); },
  });

  const isLocked = settings?.tradingLocked ?? false;

  const adjustQty = (sym: string, delta: number) => {
    setInstrQty(prev => ({ ...prev, [sym]: Math.min(20, Math.max(1, (prev[sym] ?? 1) + delta)) }));
  };

  return (
    <Card className="bg-card border border-yellow-500/30 rounded-md">
      <CardHeader className="pb-3 border-b border-border/50 flex flex-row items-center gap-2">
        <ShieldAlert className="w-4 h-4 text-yellow-400" />
        <CardTitle className="text-sm font-mono tracking-tight uppercase text-yellow-400">Risk Controls</CardTitle>
        {isLocked && (
          <span className="ml-auto flex items-center gap-1 text-xs font-mono font-bold bg-destructive/20 text-destructive px-2 py-0.5 rounded">
            <Lock className="w-3 h-3" /> TRADING LOCKED
          </span>
        )}
      </CardHeader>
      <CardContent className="pt-4 space-y-5">
        {isLoading || !form ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[0,1,2,3].map(i => <Skeleton key={i} className="h-16 w-full" />)}
          </div>
        ) : (
          <>
            <p className="text-[11px] text-muted-foreground font-mono">Changes take effect immediately.</p>

            {/* Daily risk limits */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <label className="text-[10px] text-muted-foreground font-mono uppercase block mb-1">Daily Loss Limit ($)</label>
                <Input type="number" min={1} value={form.dailyLossLimit}
                  onChange={e => setForm(f => f ? { ...f, dailyLossLimit: e.target.value } : f)}
                  className="font-mono text-sm h-8" />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground font-mono uppercase block mb-1">Daily Profit Target ($)</label>
                <Input type="number" min={1} value={form.dailyProfitTarget}
                  onChange={e => setForm(f => f ? { ...f, dailyProfitTarget: e.target.value } : f)}
                  className="font-mono text-sm h-8" />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground font-mono uppercase block mb-1">Max Trades/Day</label>
                <Input type="number" min={1} value={form.maxTradesPerDay}
                  onChange={e => setForm(f => f ? { ...f, maxTradesPerDay: e.target.value } : f)}
                  className="font-mono text-sm h-8" />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground font-mono uppercase block mb-1">Max Losses/Direction</label>
                <Input type="number" min={1} value={form.maxLossesPerDirection}
                  onChange={e => setForm(f => f ? { ...f, maxLossesPerDirection: e.target.value } : f)}
                  className="font-mono text-sm h-8" />
              </div>
            </div>

            {/* Contracts per instrument */}
            {Object.keys(instrQty).length > 0 && (
              <div className="border-t border-border/50 pt-4">
                <p className="text-[10px] font-mono uppercase text-muted-foreground tracking-widest mb-3">Contracts Per Instrument</p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {Object.entries(instrQty).map(([sym, qty]) => (
                    <div key={sym} className="flex flex-col gap-1.5">
                      <label className="text-[10px] text-muted-foreground font-mono font-bold uppercase tracking-wider">
                        {sym.replace(/M\d+$/, "")}
                      </label>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => adjustQty(sym, -1)}
                          className="w-7 h-7 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 font-mono text-sm transition-colors flex items-center justify-center"
                        >−</button>
                        <span className="w-8 text-center font-mono font-bold text-sm">{qty}</span>
                        <button
                          onClick={() => adjustQty(sym, 1)}
                          className="w-7 h-7 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 font-mono text-sm transition-colors flex items-center justify-center"
                        >+</button>
                      </div>
                      <span className="text-[9px] font-mono text-muted-foreground">contracts/trade</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2 items-center border-t border-border/50 pt-3">
              <Button size="sm" variant="outline"
                className="font-mono text-xs border-yellow-500/50 text-yellow-400 hover:bg-yellow-500/10"
                onClick={() => saveSettings.mutate()}
                disabled={saveSettings.isPending}>
                💾 Save Settings
              </Button>
              <Button size="sm" variant="outline"
                className="font-mono text-xs border-destructive/50 text-destructive hover:bg-destructive/10"
                onClick={() => liquidateAll.mutate()}
                disabled={liquidateAll.isPending}>
                <Zap className="w-3 h-3 mr-1" /> Liquidate All
              </Button>
              <Button size="sm" variant="outline"
                className="font-mono text-xs border-destructive/70 text-destructive hover:bg-destructive/10"
                onClick={() => lockTrading.mutate()}
                disabled={isLocked || lockTrading.isPending}>
                <Lock className="w-3 h-3 mr-1" /> Lock Trading
              </Button>
              {feedback && (
                <span className={cn("text-xs font-mono ml-2", feedback.error ? "text-destructive" : "text-success")}>
                  {feedback.msg}
                </span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
interface AgentStatusExtended {
  activeStrategy?: string;
  activeAccountId?: string;
  availableAccounts?: Array<{ id: string; name: string; balance?: number }>;
}

interface ClaudeResult {
  success: boolean;
  message: string;
  tradesPlaced: string[];
  advice: {
    summary: string;
    decisions: Array<{ symbol: string; action: string; reasoning: string }>;
  } | null;
}

export function Dashboard() {
  const queryClient = useQueryClient();
  const [claudeResult, setClaudeResult] = useState<ClaudeResult | null>(null);
  const [activeAccountId, setActiveAccountId] = useState<string>("");
  const [activeTimeframe, setActiveTimeframe] = useState<string>("1m");

  const { data: sessionData, isLoading: isLoadingSession, refetch: refetchSession } = useQuery<{ authenticated: boolean }>({
    queryKey: ["agentSession"],
    queryFn: () => fetch("/api/agent/session", { credentials: "include" }).then(r => r.json()),
    refetchInterval: 5 * 60 * 1000,
  });
  const isAuthenticated = sessionData?.authenticated === true;

  const logout = useMutation({
    mutationFn: async () => { await fetch("/api/agent/session", { method: "DELETE", credentials: "include" }); },
    onSuccess: () => { queryClient.setQueryData(["agentSession"], { authenticated: false }); },
  });

  const { data: agentStatus, isLoading: isLoadingStatus } = useGetAgentStatus({
    query: { queryKey: getGetAgentStatusQueryKey(), refetchInterval: 3000 }
  });

  useEffect(() => {
    const extended = agentStatus as (typeof agentStatus & AgentStatusExtended) | undefined;
    if (extended?.activeAccountId) setActiveAccountId(extended.activeAccountId);
  }, [agentStatus]);

  const { data: instruments, isLoading: isLoadingInstruments } = useGetInstruments({
    query: { queryKey: getGetInstrumentsQueryKey(), refetchInterval: 3000 }
  });

  const startAgent = useStartAgent({ request: { credentials: "include" } });
  const stopAgent = useStopAgent({ request: { credentials: "include" } });

  const claudeTrade = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/agent/claude-trade", { method: "POST", credentials: "include" });
      return res.json() as Promise<ClaudeResult>;
    },
    onSuccess: (data) => {
      setClaudeResult(data);
      queryClient.invalidateQueries({ queryKey: getGetInstrumentsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetAgentStatusQueryKey() });
    },
  });

  const switchMode = async (endpoint: string) => {
    const res = await fetch(endpoint, { method: "POST", credentials: "include" });
    const data = await res.json();
    if (data.success) queryClient.invalidateQueries({ queryKey: getGetAgentStatusQueryKey() });
  };

  const handleStart = () => startAgent.mutate(undefined, {
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetAgentStatusQueryKey() }),
  });

  const handleStop = () => stopAgent.mutate(undefined, {
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetAgentStatusQueryKey() }),
  });

  const handleTimeframeSwitch = async (tf: string) => {
    const ext = agentStatus as (typeof agentStatus & AgentStatusExtended);
    const strategy = ext?.activeStrategy ?? "DTR";
    try {
      const res = await fetch(`/api/strategy/${strategy}/timeframe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ timeframe: tf }),
      });
      const data = await res.json();
      if (data.success) setActiveTimeframe(tf);
    } catch (e) { console.error("Timeframe switch error:", e); }
  };

  if (isLoadingStatus || isLoadingInstruments || isLoadingSession) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-64 w-full" />)}
        </div>
      </div>
    );
  }

  if (!agentStatus || !instruments) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>Failed to load dashboard data.</AlertDescription>
      </Alert>
    );
  }

  const ext = agentStatus as (typeof agentStatus & AgentStatusExtended);
  const activeStrategy = ext?.activeStrategy ?? "";
  const activeMode = (agentStatus as unknown as Record<string, unknown>)?.mode as string ?? (agentStatus.claudeAutonomousMode ? "CLAUDE+HERMES" : "DTR");
  const sessionLabel = activeStrategy === "XXX" ? "London+NY (01:00–17:00)" : "2AM + 9AM (NY)";
  const hasOpenTrades = ((agentStatus as unknown as Record<string, unknown>)?.open_trades as number ?? 0) > 0;

  // Derive balance from accounts list
  const accountBalance = ext?.availableAccounts?.find(a => a.id === activeAccountId)?.balance ?? null;
  // Drawdown = daily PnL when negative
  const drawdown = agentStatus.dailyPnl < 0 ? agentStatus.dailyPnl : 0;

  return (
    <>
      {!isAuthenticated && <ConnectModal onConnected={() => refetchSession()} />}

      <div className="space-y-5">

        {/* 1. Account Stats Bar */}
        <AccountStatsBar
          balance={accountBalance}
          drawdown={drawdown}
          realizedPnl={agentStatus.dailyPnl}
          unrealizedPnl={agentStatus.unrealizedPnl}
        />

        {/* 2. System Status + Open Trades */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

          {/* System Status */}
          <Card className={cn("lg:col-span-1 border-border rounded-md", agentStatus.claudeAutonomousMode ? "bg-primary/5 border-primary/40" : "bg-card")}>
            <CardHeader className="pb-4 border-b border-border/50 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-mono tracking-tight flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" />
                SYSTEM STATUS
              </CardTitle>
              <div className="flex items-center gap-1.5">
                <span className="relative flex h-3 w-3">
                  {agentStatus.running && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />}
                  <span className={cn("relative inline-flex rounded-full h-3 w-3", agentStatus.running ? "bg-success" : "bg-muted-foreground")} />
                </span>
                <span className="text-xs font-mono uppercase font-bold text-muted-foreground">
                  {agentStatus.running ? "ACTIVE" : "STOPPED"}
                </span>
              </div>
            </CardHeader>
            <CardContent className="py-5 flex flex-col gap-5">
              {/* START / HALT */}
              <div className="flex gap-3 w-full">
                <Button variant="default" size="lg"
                  disabled={agentStatus.running || startAgent.isPending || !isAuthenticated}
                  onClick={handleStart}
                  className="flex-1 font-mono bg-success hover:bg-success/90 text-success-foreground font-bold h-[52px]">
                  <Play className="w-4 h-4 mr-2" /> START
                </Button>
                <Button variant="destructive" size="lg"
                  disabled={!agentStatus.running || stopAgent.isPending || !isAuthenticated}
                  onClick={handleStop}
                  className="flex-1 font-mono font-bold h-[52px]">
                  <Square className="w-4 h-4 mr-2" /> HALT
                </Button>
              </div>

              {/* Trading Mode */}
              <div className="border-t border-border/50 pt-4 space-y-2">
                <p className="text-[10px] font-mono uppercase text-muted-foreground tracking-widest">Trading Mode</p>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: "DTR", icon: <BarChart2 className="w-3 h-3" />, endpoint: "/api/mode/dtr", active: activeStrategy === "DTR" && activeMode === "DTR" },
                    { label: "XXX", icon: null, endpoint: "/api/mode/xxx", active: activeStrategy === "XXX" },
                    { label: "AI MODE", icon: null, endpoint: "/api/mode/claude", active: activeMode === "CLAUDE+HERMES" },
                    { label: "HALT", icon: null, endpoint: "/api/mode/halt", active: activeMode === "HALT" },
                  ].map(({ label, icon, endpoint, active }) => (
                    <button key={label}
                      disabled={!isAuthenticated}
                      onClick={() => switchMode(endpoint)}
                      className={cn(
                        "h-[52px] font-mono font-bold text-sm rounded transition-all duration-150",
                        active
                          ? label === "HALT" ? "bg-destructive text-white shadow-[0_0_8px_rgba(239,68,68,0.3)]"
                            : label === "AI MODE" ? "bg-primary text-primary-foreground shadow-[0_0_8px_rgba(99,102,241,0.3)] animate-pulse"
                            : "bg-indigo-600 text-white shadow-[0_0_8px_rgba(99,102,241,0.25)]"
                          : "bg-card border border-border text-muted-foreground hover:border-foreground/30",
                        !isAuthenticated && "opacity-50 cursor-not-allowed"
                      )}>
                      <div className="flex items-center justify-center gap-1">
                        {icon}{label}
                      </div>
                    </button>
                  ))}
                </div>
                <p className="text-[10px] font-mono text-muted-foreground">
                  Active: <span className="text-foreground">{activeStrategy || "—"}</span>
                  {" — "}<span className="text-foreground">{sessionLabel}</span>
                </p>
                {agentStatus.claudeAutonomousMode && agentStatus.lastClaudeAutonomousTick && (
                  <div className="text-[10px] font-mono text-primary/80 bg-primary/10 rounded px-2 py-1">
                    Last tick: {new Date(agentStatus.lastClaudeAutonomousTick).toLocaleTimeString()}
                  </div>
                )}
              </div>

              {/* Claude Trade Now */}
              <div className="border-t border-border/50 pt-4">
                <Button variant="outline" size="lg" className="w-full font-mono font-bold border-primary/50 text-primary hover:bg-primary/10"
                  disabled={!isAuthenticated || claudeTrade.isPending}
                  onClick={() => { setClaudeResult(null); claudeTrade.mutate(); }}>
                  <Brain className="w-4 h-4 mr-2" />
                  {claudeTrade.isPending ? "CLAUDE ANALYSING…" : "CLAUDE TRADE NOW"}
                </Button>
              </div>

              {/* Session Phase */}
              <div className="flex justify-between items-center border-t border-border/50 pt-4">
                <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Session Phase</span>
                <span className="font-mono font-bold px-3 py-1 rounded text-primary bg-primary/10">
                  {agentStatus.claudeAutonomousMode ? "CLAUDE AI" : formatSessionPhase(agentStatus.sessionPhase)}
                </span>
              </div>

              {/* Bar Timeframe */}
              <div className="border-t border-border/50 pt-4 space-y-2">
                <p className="text-[10px] font-mono uppercase text-muted-foreground tracking-widest flex items-center gap-1">
                  <Clock className="w-3 h-3" /> Bar Timeframe
                </p>
                <div className="flex gap-1">
                  {["1m", "5m", "15m"].map((tf) => (
                    <button key={tf}
                      onClick={() => !hasOpenTrades && isAuthenticated && handleTimeframeSwitch(tf)}
                      disabled={!isAuthenticated || hasOpenTrades}
                      title={hasOpenTrades ? "Close open trades first" : `Switch to ${tf} bars`}
                      className={cn(
                        "h-8 min-w-[44px] font-mono text-[10px] font-bold rounded border transition-colors",
                        activeTimeframe === tf ? "bg-indigo-600/30 border-indigo-500 text-indigo-300" : "bg-card border-border text-muted-foreground",
                        (!isAuthenticated || hasOpenTrades) ? "opacity-40 cursor-not-allowed" : "hover:border-indigo-500/50 cursor-pointer"
                      )}>
                      {tf.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              {/* Disconnect */}
              {isAuthenticated && (
                <div className="border-t border-border/50 pt-3">
                  <Button variant="ghost" size="sm" className="w-full text-muted-foreground font-mono text-xs"
                    onClick={() => logout.mutate()}>
                    <LogOut className="w-3 h-3 mr-1" /> Disconnect session
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Open Trades */}
          <Card className="lg:col-span-2 bg-card border-border rounded-md">
            <CardHeader className="pb-3 border-b border-border/50 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-mono tracking-tight text-muted-foreground uppercase flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" />
                Open Positions
              </CardTitle>
            </CardHeader>
            <CardContent className="py-4">
              <OpenTradesInline isAuthenticated={isAuthenticated} />
            </CardContent>
          </Card>
        </div>

        {/* Account Selector */}
        {(() => {
          if (!ext?.availableAccounts || ext.availableAccounts.length <= 1) return null;
          return (
            <AccountSelector
              accounts={ext.availableAccounts}
              activeAccountId={activeAccountId}
              isAuthenticated={isAuthenticated}
              onAccountChange={setActiveAccountId}
            />
          );
        })()}

        {/* 3. Risk Controls */}
        {isAuthenticated && <RiskControlsCard />}

        {/* System error */}
        {agentStatus.errorMessage && (
          <Alert variant="destructive" className="bg-destructive/10 border-destructive/50 text-destructive font-mono text-sm rounded-md">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>System Error</AlertTitle>
            <AlertDescription>{agentStatus.errorMessage}</AlertDescription>
          </Alert>
        )}

        {/* Claude Trade Result */}
        {claudeResult && (
          <Card className={cn("bg-card border rounded-md", claudeResult.success ? "border-primary/40" : "border-destructive/40")}>
            <CardHeader className="pb-3 border-b border-border/50 flex flex-row items-center gap-2">
              {claudeResult.success ? <CheckCircle className="w-4 h-4 text-success" /> : <XCircle className="w-4 h-4 text-destructive" />}
              <CardTitle className="text-sm font-mono tracking-tight uppercase">Claude Analysis Result</CardTitle>
              <button className="ml-auto text-muted-foreground hover:text-foreground text-xs font-mono" onClick={() => setClaudeResult(null)}>✕ dismiss</button>
            </CardHeader>
            <CardContent className="pt-4 space-y-3">
              <p className="text-sm font-mono text-foreground">{claudeResult.message}</p>
              {claudeResult.advice && (
                <>
                  <p className="text-xs text-muted-foreground font-mono italic">{claudeResult.advice.summary}</p>
                  <div className="grid gap-2">
                    {claudeResult.advice.decisions.map((d) => (
                      <div key={d.symbol} className="flex items-start gap-3 text-xs font-mono bg-muted/20 rounded px-3 py-2">
                        <span className={cn("font-bold w-16 shrink-0", d.action === "skip" ? "text-muted-foreground" : d.action === "long" ? "text-success" : "text-destructive")}>{d.symbol}</span>
                        <span className={cn("w-10 shrink-0 uppercase font-bold", d.action === "skip" ? "text-muted-foreground" : d.action === "long" ? "text-success" : "text-destructive")}>{d.action}</span>
                        <span className="text-muted-foreground">{d.reasoning}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* 4. Active Instruments */}
        <div>
          <h2 className="section-header">Active Instruments</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            {instruments.map(instrument => (
              <InstrumentCard
                key={instrument.symbol}
                instrument={instrument}
                isAuthenticated={isAuthenticated}
              />
            ))}
          </div>
        </div>

        {/* 5. Equity Curve */}
        <EquityCurve />

      </div>
    </>
  );
}
