import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { 
  useGetAgentStatus, 
  useGetInstruments, 
  useStartAgent, 
  useStopAgent,
  useGetDailySummary,
  getGetAgentStatusQueryKey,
  getGetInstrumentsQueryKey,
  getGetDailySummaryQueryKey,
} from "@workspace/api-client-react";
import { Play, Square, Activity, AlertCircle, KeyRound, LogOut, Brain, CheckCircle, XCircle, Cpu, BarChart2, ShieldAlert, Lock, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { InstrumentCard } from "@/components/instrument-card";
import { PnlProgress } from "@/components/pnl-progress";
import { formatSessionPhase, formatCurrency } from "@/lib/format";

// ---------------------------------------------------------------------------
// ConnectModal — shown when the user is not authenticated.
// User enters their AGENT_CONTROL_SECRET once; the server validates it and
// issues an HttpOnly session cookie. No key is stored in browser memory after
// the cookie is set.
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
    onSuccess: () => {
      setKey("");
      setError(null);
      onConnected();
    },
    onError: (err: Error) => {
      setError(err.message);
    },
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
            Your key is validated server-side and never stored in the browser.
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
          {error && (
            <p className="text-xs text-destructive font-mono">{error}</p>
          )}
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
// Dashboard — main view, shown after authentication
// ---------------------------------------------------------------------------
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

  // Check whether the current browser session is authenticated
  const {
    data: sessionData,
    isLoading: isLoadingSession,
    refetch: refetchSession,
  } = useQuery<{ authenticated: boolean }>({
    queryKey: ["agentSession"],
    queryFn: () =>
      fetch("/api/agent/session", { credentials: "include" }).then((r) => r.json()),
    refetchInterval: 5 * 60 * 1000, // re-verify every 5 min
  });

  const isAuthenticated = sessionData?.authenticated === true;

  const logout = useMutation({
    mutationFn: async () => {
      await fetch("/api/agent/session", { method: "DELETE", credentials: "include" });
    },
    onSuccess: () => {
      queryClient.setQueryData(["agentSession"], { authenticated: false });
    },
  });

  // Agent status and instrument data (unauthenticated reads — always fetched)
  const { data: agentStatus, isLoading: isLoadingStatus } = useGetAgentStatus({
    query: { queryKey: getGetAgentStatusQueryKey(), refetchInterval: 3000 }
  });

  const { data: instruments, isLoading: isLoadingInstruments } = useGetInstruments({
    query: { queryKey: getGetInstrumentsQueryKey(), refetchInterval: 3000 }
  });

  const { data: dailySummary, isLoading: isLoadingSummary } = useGetDailySummary({
    query: { queryKey: getGetDailySummaryQueryKey(), refetchInterval: 5000 }
  });

  // Mutating hooks — credentials: "include" sends the HttpOnly session cookie
  const startAgent = useStartAgent({ request: { credentials: "include" } });
  const stopAgent = useStopAgent({ request: { credentials: "include" } });

  const claudeTrade = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/agent/claude-trade", {
        method: "POST",
        credentials: "include",
      });
      const body = await res.json() as ClaudeResult;
      return body;
    },
    onSuccess: (data) => {
      setClaudeResult(data);
      queryClient.invalidateQueries({ queryKey: getGetInstrumentsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetAgentStatusQueryKey() });
    },
  });

  const setMode = useMutation({
    mutationFn: async (claudeAutonomous: boolean) => {
      const res = await fetch("/api/agent/mode", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeAutonomous }),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getGetAgentStatusQueryKey() });
    },
  });

  const handleStart = () => {
    startAgent.mutate(undefined, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetAgentStatusQueryKey() }),
    });
  };

  const handleStop = () => {
    stopAgent.mutate(undefined, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetAgentStatusQueryKey() }),
    });
  };

  if (isLoadingStatus || isLoadingInstruments || isLoadingSummary || isLoadingSession) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-48 w-full" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
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

  return (
    <>
      {/* Show connect modal when not authenticated */}
      {!isAuthenticated && (
        <ConnectModal onConnected={() => refetchSession()} />
      )}

      <div className="space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Control Card */}
          <Card className={`lg:col-span-1 border-border rounded-md ${agentStatus.claudeAutonomousMode ? "bg-primary/5 border-primary/40" : "bg-card"}`}>
            <CardHeader className="pb-4 border-b border-border/50 flex flex-row items-center justify-between">
              <CardTitle className="text-lg font-mono tracking-tight flex items-center">
                <Activity className="w-5 h-5 mr-2 text-primary" />
                SYSTEM STATUS
              </CardTitle>
              <div className="flex items-center gap-2">
                <div className="flex items-center">
                  <span className="relative flex h-3 w-3 mr-2">
                    {agentStatus.running && (
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                    )}
                    <span className={`relative inline-flex rounded-full h-3 w-3 ${agentStatus.running ? 'bg-success' : 'bg-muted-foreground'}`}></span>
                  </span>
                  <span className="text-xs font-mono uppercase font-bold text-muted-foreground">
                    {agentStatus.running ? "ACTIVE" : "STOPPED"}
                  </span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="py-6 flex flex-col items-center justify-between gap-6">
              <div className="flex gap-4 w-full">
                <Button 
                  variant="default" 
                  size="lg"
                  disabled={agentStatus.running || startAgent.isPending || !isAuthenticated}
                  onClick={handleStart}
                  className="flex-1 font-mono bg-success hover:bg-success/90 text-success-foreground font-bold"
                >
                  <Play className="w-4 h-4 mr-2" />
                  START
                </Button>
                <Button 
                  variant="destructive" 
                  size="lg"
                  disabled={!agentStatus.running || stopAgent.isPending || !isAuthenticated}
                  onClick={handleStop}
                  className="flex-1 font-mono font-bold"
                >
                  <Square className="w-4 h-4 mr-2" />
                  HALT
                </Button>
              </div>

              {/* Trading Mode Selector */}
              <div className="w-full border-t border-border pt-4 space-y-2">
                <p className="text-[10px] font-mono uppercase text-muted-foreground tracking-widest mb-2">Trading Mode</p>
                <div className="flex gap-2 w-full">
                  <Button
                    variant={!agentStatus.claudeAutonomousMode ? "default" : "outline"}
                    size="sm"
                    className={`flex-1 font-mono text-xs font-bold ${!agentStatus.claudeAutonomousMode ? "bg-primary text-primary-foreground" : "border-border text-muted-foreground"}`}
                    disabled={!isAuthenticated || setMode.isPending || !agentStatus.claudeAutonomousMode}
                    onClick={() => setMode.mutate(false)}
                  >
                    <BarChart2 className="w-3 h-3 mr-1" />
                    DTR RULES
                  </Button>
                  <Button
                    variant={agentStatus.claudeAutonomousMode ? "default" : "outline"}
                    size="sm"
                    className={`flex-1 font-mono text-xs font-bold ${agentStatus.claudeAutonomousMode ? "bg-primary text-primary-foreground animate-pulse" : "border-primary/50 text-primary"}`}
                    disabled={!isAuthenticated || setMode.isPending || agentStatus.claudeAutonomousMode}
                    onClick={() => setMode.mutate(true)}
                  >
                    <Cpu className="w-3 h-3 mr-1" />
                    CLAUDE AI
                  </Button>
                </div>
                {agentStatus.claudeAutonomousMode && (
                  <div className="text-[10px] font-mono text-primary/80 bg-primary/10 rounded px-2 py-1">
                    ⚡ Claude trading autonomously — DTR rules bypassed
                    {agentStatus.lastClaudeAutonomousTick && (
                      <span className="block text-muted-foreground mt-0.5">
                        Last tick: {new Date(agentStatus.lastClaudeAutonomousTick).toLocaleTimeString()}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Claude Trade Now */}
              <div className="w-full border-t border-border pt-4">
                <Button
                  variant="outline"
                  size="lg"
                  className="w-full font-mono font-bold border-primary/50 text-primary hover:bg-primary/10 hover:text-primary"
                  disabled={!isAuthenticated || claudeTrade.isPending}
                  onClick={() => { setClaudeResult(null); claudeTrade.mutate(); }}
                >
                  <Brain className="w-4 h-4 mr-2" />
                  {claudeTrade.isPending ? "CLAUDE ANALYSING…" : "CLAUDE TRADE NOW"}
                </Button>
              </div>
              
              <div className="w-full flex justify-between items-center border-t border-border pt-4">
                <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider block">Session Phase</span>
                <span className={`font-mono font-bold px-3 py-1 rounded inline-block ${agentStatus.claudeAutonomousMode ? "text-primary bg-primary/10" : "text-primary bg-primary/10"}`}>
                  {agentStatus.claudeAutonomousMode ? "CLAUDE AI" : formatSessionPhase(agentStatus.sessionPhase)}
                </span>
              </div>

              {isAuthenticated && (
                <div className="w-full border-t border-border pt-4">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full text-muted-foreground font-mono text-xs"
                    onClick={() => logout.mutate()}
                  >
                    <LogOut className="w-3 h-3 mr-1" />
                    Disconnect session
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* PnL Progress Card */}
          <Card className="lg:col-span-2 bg-card border-border rounded-md">
            <CardHeader className="pb-4 border-b border-border/50">
              <CardTitle className="text-sm font-mono tracking-tight text-muted-foreground uppercase">
                Daily Target Progress
              </CardTitle>
            </CardHeader>
            <CardContent className="py-6 flex flex-col gap-6">
              <PnlProgress 
                currentPnl={agentStatus.dailyPnl}
                floor={-agentStatus.dailyLossLimit}
                target={agentStatus.dailyProfitTarget}
              />
              {dailySummary && (
                <div className="grid grid-cols-4 gap-4 pt-4 border-t border-border mt-2">
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase font-mono mb-1">Trades</div>
                    <div className="font-mono text-sm">{dailySummary.tradeCount}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase font-mono mb-1">Win/Loss</div>
                    <div className="font-mono text-sm">
                      <span className="text-success">{dailySummary.winCount}</span> / <span className="text-destructive">{dailySummary.lossCount}</span>
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase font-mono mb-1">London PNL</div>
                    <div className={`font-mono text-sm ${dailySummary.londonPnl > 0 ? 'text-success' : dailySummary.londonPnl < 0 ? 'text-destructive' : ''}`}>
                      {formatCurrency(dailySummary.londonPnl)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase font-mono mb-1">NY PNL</div>
                    <div className={`font-mono text-sm ${dailySummary.nyPnl > 0 ? 'text-success' : dailySummary.nyPnl < 0 ? 'text-destructive' : ''}`}>
                      {formatCurrency(dailySummary.nyPnl)}
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

        </div>

        {agentStatus.errorMessage && (
          <Alert variant="destructive" className="bg-destructive/10 border-destructive/50 text-destructive font-mono text-sm rounded-md">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>System Error</AlertTitle>
            <AlertDescription>{agentStatus.errorMessage}</AlertDescription>
          </Alert>
        )}

        {/* Claude Trade Result */}
        {claudeResult && (
          <Card className={`bg-card border rounded-md ${claudeResult.success ? "border-primary/40" : "border-destructive/40"}`}>
            <CardHeader className="pb-3 border-b border-border/50 flex flex-row items-center gap-2">
              {claudeResult.success
                ? <CheckCircle className="w-4 h-4 text-success" />
                : <XCircle className="w-4 h-4 text-destructive" />}
              <CardTitle className="text-sm font-mono tracking-tight uppercase">
                Claude Analysis Result
              </CardTitle>
              <button
                className="ml-auto text-muted-foreground hover:text-foreground text-xs font-mono"
                onClick={() => setClaudeResult(null)}
              >
                ✕ dismiss
              </button>
            </CardHeader>
            <CardContent className="pt-4 space-y-3">
              <p className="text-sm font-mono text-foreground">{claudeResult.message}</p>
              {claudeResult.advice && (
                <>
                  <p className="text-xs text-muted-foreground font-mono italic">{claudeResult.advice.summary}</p>
                  <div className="grid gap-2">
                    {claudeResult.advice.decisions.map((d) => (
                      <div key={d.symbol} className="flex items-start gap-3 text-xs font-mono bg-muted/20 rounded px-3 py-2">
                        <span className={`font-bold w-16 shrink-0 ${d.action === "skip" ? "text-muted-foreground" : d.action === "long" ? "text-success" : "text-destructive"}`}>
                          {d.symbol}
                        </span>
                        <span className={`w-10 shrink-0 uppercase font-bold ${d.action === "skip" ? "text-muted-foreground" : d.action === "long" ? "text-success" : "text-destructive"}`}>
                          {d.action}
                        </span>
                        <span className="text-muted-foreground">{d.reasoning}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Risk Controls (authenticated only) */}
        {isAuthenticated && <RiskControlsCard />}

        {/* Instruments Grid */}
        <div>
          <h2 className="text-sm font-mono font-bold tracking-widest text-muted-foreground uppercase mb-4 border-b border-border/50 pb-2">
            Active Instruments
          </h2>
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
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// RiskControlsCard — editable daily risk limits, liquidate all, lock trading
// ---------------------------------------------------------------------------
function RiskControlsCard() {
  const queryClient = useQueryClient();

  interface RiskSettings {
    dailyLossLimit: number;
    dailyProfitTarget: number;
    maxTradesPerDay: number;
    maxLossesPerDirection: number;
    tradingLocked: boolean;
  }

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

  const [feedback, setFeedback] = useState<{ msg: string; error: boolean } | null>(null);

  // Populate form once when settings first load (not on re-fetches, to avoid clobbering user edits)
  useEffect(() => {
    if (settings && !form) {
      setForm({
        dailyLossLimit: String(settings.dailyLossLimit),
        dailyProfitTarget: String(settings.dailyProfitTarget),
        maxTradesPerDay: String(settings.maxTradesPerDay),
        maxLossesPerDirection: String(settings.maxLossesPerDirection),
      });
    }
  }, [settings, form]);

  const saveSettings = useMutation({
    mutationFn: async () => {
      if (!form) throw new Error("Form not ready");
      const payload: Record<string, number | null> = {
        dailyLossLimit: Number(form.dailyLossLimit),
        dailyProfitTarget: Number(form.dailyProfitTarget),
        maxTradesPerDay: form.maxTradesPerDay !== "" ? Number(form.maxTradesPerDay) : null,
        maxLossesPerDirection: form.maxLossesPerDirection !== "" ? Number(form.maxLossesPerDirection) : null,
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
    onError: (err: Error) => {
      setFeedback({ msg: "❌ " + err.message, error: true });
    },
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
    onError: (err: Error) => {
      if (err.message !== "Cancelled") setFeedback({ msg: "❌ " + err.message, error: true });
    },
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
    onError: (err: Error) => {
      if (err.message !== "Cancelled") setFeedback({ msg: "❌ " + err.message, error: true });
    },
  });

  const isLocked = settings?.tradingLocked ?? false;

  return (
    <Card className="bg-card border border-yellow-500/30 rounded-md">
      <CardHeader className="pb-3 border-b border-border/50 flex flex-row items-center gap-2">
        <ShieldAlert className="w-4 h-4 text-yellow-400" />
        <CardTitle className="text-sm font-mono tracking-tight uppercase text-yellow-400">
          Risk Controls
        </CardTitle>
        {isLocked && (
          <span className="ml-auto flex items-center gap-1 text-xs font-mono font-bold bg-destructive/20 text-destructive px-2 py-0.5 rounded">
            <Lock className="w-3 h-3" /> TRADING LOCKED
          </span>
        )}
      </CardHeader>
      <CardContent className="pt-4">
        {isLoading || !form ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[0,1,2,3].map(i => <Skeleton key={i} className="h-16 w-full" />)}
          </div>
        ) : (
          <>
            <p className="text-[11px] text-muted-foreground font-mono mb-4">
              Changes take effect immediately — no restart required.
            </p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              <div>
                <label className="text-[10px] text-muted-foreground font-mono uppercase block mb-1">Daily Loss Limit ($)</label>
                <Input
                  type="number"
                  min={1}
                  value={form.dailyLossLimit}
                  onChange={e => setForm(f => f ? { ...f, dailyLossLimit: e.target.value } : f)}
                  className="font-mono text-sm h-8"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground font-mono uppercase block mb-1">Daily Profit Target ($)</label>
                <Input
                  type="number"
                  min={1}
                  value={form.dailyProfitTarget}
                  onChange={e => setForm(f => f ? { ...f, dailyProfitTarget: e.target.value } : f)}
                  className="font-mono text-sm h-8"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground font-mono uppercase block mb-1">Max Trades/Day</label>
                <Input
                  type="number"
                  min={1}
                  value={form.maxTradesPerDay}
                  onChange={e => setForm(f => f ? { ...f, maxTradesPerDay: e.target.value } : f)}
                  className="font-mono text-sm h-8"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground font-mono uppercase block mb-1">Max Losses/Direction</label>
                <Input
                  type="number"
                  min={1}
                  value={form.maxLossesPerDirection}
                  onChange={e => setForm(f => f ? { ...f, maxLossesPerDirection: e.target.value } : f)}
                  className="font-mono text-sm h-8"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <Button
                size="sm"
                variant="outline"
                className="font-mono text-xs border-yellow-500/50 text-yellow-400 hover:bg-yellow-500/10"
                onClick={() => saveSettings.mutate()}
                disabled={saveSettings.isPending}
              >
                💾 Save Settings
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="font-mono text-xs border-destructive/50 text-destructive hover:bg-destructive/10"
                onClick={() => liquidateAll.mutate()}
                disabled={liquidateAll.isPending}
              >
                <Zap className="w-3 h-3 mr-1" /> Liquidate All
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="font-mono text-xs border-destructive/70 text-destructive hover:bg-destructive/10"
                onClick={() => lockTrading.mutate()}
                disabled={isLocked || lockTrading.isPending}
              >
                <Lock className="w-3 h-3 mr-1" /> Lock Trading
              </Button>
              {feedback && (
                <span className={`text-xs font-mono ml-2 ${feedback.error ? "text-destructive" : "text-green-400"}`}>
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
