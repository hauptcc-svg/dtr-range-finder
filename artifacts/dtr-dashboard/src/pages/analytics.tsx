import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useGetAgentStatus,
  useGetDailySummary,
  getGetAgentStatusQueryKey,
  getGetDailySummaryQueryKey,
} from "@workspace/api-client-react";
import { Brain, BarChart2, TrendingUp, TrendingDown, Settings, AlertTriangle, Newspaper, ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PnlProgress } from "@/components/pnl-progress";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  HermesReport,
  WinRateSetup,
  InstrumentPerformance,
  ParamRecommendation,
  EarlyCloseAnalysis,
  NewsCorrelation,
} from "@/components/hermes-report-modal";

// ─── Collapsible section ─────────────────────────────────────────────────────

function Section({
  title,
  icon,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-border/50 rounded-md overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-4 py-3 bg-muted/20 hover:bg-muted/30 transition-colors text-left"
        onClick={() => setOpen(!open)}
      >
        {icon}
        <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-foreground flex-1">
          {title}
        </span>
        {open ? (
          <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
        )}
      </button>
      {open && <div className="px-4 py-4 bg-background/40">{children}</div>}
    </div>
  );
}

function WinRateBadge({ rate }: { rate: number }) {
  const pct = Math.round(rate * 100);
  return (
    <span
      className={cn(
        "font-mono font-bold text-[10px] px-1.5 py-0.5 rounded",
        pct >= 65 ? "bg-success/20 text-success" :
        pct >= 50 ? "bg-yellow-500/20 text-yellow-400" :
                   "bg-destructive/20 text-destructive"
      )}
    >
      {pct}% WR
    </span>
  );
}

// ─── Hermes report body (inline, no modal) ───────────────────────────────────

function HermesReportBody({ report, isLoading }: { report: HermesReport | null; isLoading: boolean }) {
  const [approvedParams, setApprovedParams] = useState<Record<string, "approved" | "rejected">>({});

  const handleParamAction = async (rec: ParamRecommendation, action: "APPROVE" | "REJECT") => {
    const key = `${rec.symbol ?? "ALL"}_${rec.param}`;
    setApprovedParams((p) => ({ ...p, [key]: action === "APPROVE" ? "approved" : "rejected" }));
    try {
      await fetch("/api/telegram/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: `${action}_${rec.symbol ?? "ALL"}_${rec.param}_${rec.suggested}` }),
      });
    } catch {
      // non-critical
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-16 text-muted-foreground">
        <Brain className="w-10 h-10 text-primary animate-pulse" />
        <p className="font-mono text-xs uppercase tracking-widest text-center">Hermes is analysing your trades</p>
        <p className="font-mono text-[10px] text-muted-foreground/60">This usually takes 10–20 seconds</p>
      </div>
    );
  }

  if (!report) return null;

  if (report.error) {
    return (
      <div className="font-mono text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded px-4 py-3">
        {report.error}
      </div>
    );
  }

  if (report.raw_response) {
    return (
      <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed bg-muted/10 rounded px-4 py-3 overflow-x-auto">
        {report.raw_response}
      </pre>
    );
  }

  return (
    <div className="space-y-3">
      {report.overall_summary && (
        <div className="bg-primary/5 border border-primary/20 rounded px-4 py-3">
          <p className="text-xs font-mono text-primary/90 leading-relaxed">{report.overall_summary}</p>
        </div>
      )}

      {report.win_rate_by_setup && report.win_rate_by_setup.length > 0 && (
        <Section
          title={`Win Rate by Setup (${report.win_rate_by_setup.length})`}
          icon={<BarChart2 className="w-3 h-3 text-primary" />}
          defaultOpen
        >
          <div className="overflow-x-auto">
            <table className="w-full text-[10px] font-mono">
              <thead>
                <tr className="text-muted-foreground border-b border-border/50">
                  <th className="text-left pb-1.5 pr-3">Symbol</th>
                  <th className="text-left pb-1.5 pr-3">Session</th>
                  <th className="text-left pb-1.5 pr-3">Dir</th>
                  <th className="text-left pb-1.5 pr-3">Day</th>
                  <th className="text-right pb-1.5 pr-3">WR</th>
                  <th className="text-right pb-1.5 pr-3">Trades</th>
                  <th className="text-right pb-1.5">Avg PnL</th>
                </tr>
              </thead>
              <tbody>
                {(report.win_rate_by_setup as WinRateSetup[]).map((s, i) => (
                  <tr key={i} className="border-b border-border/20 last:border-0">
                    <td className="py-1.5 pr-3 text-foreground font-semibold">{s.symbol.replace(/M\d+$/, "")}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground">{s.session}</td>
                    <td className={cn("py-1.5 pr-3 font-bold", s.direction === "LONG" ? "text-success" : "text-destructive")}>{s.direction}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground">{s.day_of_week?.slice(0, 3)}</td>
                    <td className="py-1.5 pr-3 text-right"><WinRateBadge rate={s.win_rate} /></td>
                    <td className="py-1.5 pr-3 text-right text-muted-foreground">{s.trades}</td>
                    <td className={cn("py-1.5 text-right font-bold", s.avg_pnl >= 0 ? "text-success" : "text-destructive")}>
                      {s.avg_pnl >= 0 ? "+" : ""}${s.avg_pnl.toFixed(0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {((report.best_instruments?.length ?? 0) > 0 || (report.worst_instruments?.length ?? 0) > 0) && (
        <Section title="Instrument Performance" icon={<TrendingUp className="w-3 h-3 text-success" />} defaultOpen>
          <div className="grid grid-cols-2 gap-3">
            {report.best_instruments && report.best_instruments.length > 0 && (
              <div>
                <p className="text-[9px] font-mono uppercase text-success/70 tracking-widest mb-1.5">🏆 Best</p>
                {(report.best_instruments as InstrumentPerformance[]).map((inst, i) => (
                  <div key={i} className="flex items-start justify-between gap-2 mb-1.5 bg-success/5 border border-success/15 rounded px-2 py-1.5">
                    <div>
                      <div className="font-mono font-bold text-[10px]">{inst.symbol.replace(/M\d+$/, "")}</div>
                      {inst.note && <div className="text-[9px] text-muted-foreground leading-tight mt-0.5">{inst.note}</div>}
                    </div>
                    <div className="text-right shrink-0">
                      <WinRateBadge rate={inst.win_rate} />
                      <div className="text-[9px] text-muted-foreground mt-0.5">{inst.trades} trades</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {report.worst_instruments && report.worst_instruments.length > 0 && (
              <div>
                <p className="text-[9px] font-mono uppercase text-destructive/70 tracking-widest mb-1.5">⚠️ Worst</p>
                {(report.worst_instruments as InstrumentPerformance[]).map((inst, i) => (
                  <div key={i} className="flex items-start justify-between gap-2 mb-1.5 bg-destructive/5 border border-destructive/15 rounded px-2 py-1.5">
                    <div>
                      <div className="font-mono font-bold text-[10px]">{inst.symbol.replace(/M\d+$/, "")}</div>
                      {inst.note && <div className="text-[9px] text-muted-foreground leading-tight mt-0.5">{inst.note}</div>}
                    </div>
                    <div className="text-right shrink-0">
                      <WinRateBadge rate={inst.win_rate} />
                      <div className="text-[9px] text-muted-foreground mt-0.5">{inst.trades} trades</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Section>
      )}

      {report.param_recommendations && report.param_recommendations.length > 0 && (
        <Section
          title={`Parameter Recommendations (${report.param_recommendations.length})`}
          icon={<Settings className="w-3 h-3 text-yellow-400" />}
        >
          <div className="space-y-2">
            {(report.param_recommendations as ParamRecommendation[]).map((rec, i) => {
              const key = `${rec.symbol ?? "ALL"}_${rec.param}`;
              const state = approvedParams[key];
              return (
                <div key={i} className="bg-muted/20 border border-border/50 rounded px-3 py-2">
                  <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-[10px] text-yellow-400">{rec.param}</span>
                      {rec.symbol && <span className="font-mono text-[9px] text-muted-foreground">{rec.symbol.replace(/M\d+$/, "")}</span>}
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {rec.current} → <span className="text-primary">{rec.suggested}</span>
                      </span>
                      {rec.auto_apply && <span className="text-[8px] font-mono bg-success/20 text-success px-1 py-0.5 rounded">AUTO</span>}
                    </div>
                    {!state ? (
                      <div className="flex gap-1">
                        <button
                          onClick={() => handleParamAction(rec, "APPROVE")}
                          className="h-6 px-2 font-mono text-[9px] font-bold rounded bg-success/20 text-success hover:bg-success/30 border border-success/30"
                        >APPROVE</button>
                        <button
                          onClick={() => handleParamAction(rec, "REJECT")}
                          className="h-6 px-2 font-mono text-[9px] font-bold rounded bg-destructive/20 text-destructive hover:bg-destructive/30 border border-destructive/30"
                        >REJECT</button>
                      </div>
                    ) : (
                      <span className={cn("text-[9px] font-mono font-bold px-2 py-0.5 rounded",
                        state === "approved" ? "bg-success/20 text-success" : "bg-destructive/20 text-destructive"
                      )}>{state.toUpperCase()}</span>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground font-mono leading-relaxed">{rec.reasoning}</p>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {report.early_close_analysis && (
        <Section title="Early Close Analysis" icon={<TrendingDown className="w-3 h-3 text-orange-400" />}>
          <div className="grid grid-cols-3 gap-2 mb-3">
            <div className="bg-muted/20 rounded px-2 py-2 text-center">
              <div className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest">Total</div>
              <div className="font-mono font-bold text-base">{(report.early_close_analysis as EarlyCloseAnalysis).total_early_closes}</div>
            </div>
            <div className="bg-success/10 border border-success/20 rounded px-2 py-2 text-center">
              <div className="text-[9px] font-mono text-success/70 uppercase tracking-widest">Correct</div>
              <div className="font-mono font-bold text-base text-success">{(report.early_close_analysis as EarlyCloseAnalysis).correct_closes}</div>
            </div>
            <div className="bg-orange-500/10 border border-orange-500/20 rounded px-2 py-2 text-center">
              <div className="text-[9px] font-mono text-orange-400/70 uppercase tracking-widest">Premature</div>
              <div className="font-mono font-bold text-base text-orange-400">{(report.early_close_analysis as EarlyCloseAnalysis).premature_closes}</div>
            </div>
          </div>
          {(report.early_close_analysis as EarlyCloseAnalysis).notes && (
            <p className="text-[10px] font-mono text-muted-foreground leading-relaxed">
              {(report.early_close_analysis as EarlyCloseAnalysis).notes}
            </p>
          )}
        </Section>
      )}

      {report.news_correlation && (
        <Section title="News Correlation" icon={<Newspaper className="w-3 h-3 text-blue-400" />}>
          {(report.news_correlation as NewsCorrelation).events_detected?.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {(report.news_correlation as NewsCorrelation).events_detected.map((ev, i) => (
                <span key={i} className="font-mono text-[9px] bg-blue-500/10 text-blue-400 border border-blue-500/20 px-1.5 py-0.5 rounded">{ev}</span>
              ))}
            </div>
          )}
          {(report.news_correlation as NewsCorrelation).pattern && (
            <p className="text-[10px] font-mono text-muted-foreground leading-relaxed mb-2">
              {(report.news_correlation as NewsCorrelation).pattern}
            </p>
          )}
          {(report.news_correlation as NewsCorrelation).recommendation && (
            <div className="flex items-start gap-2 bg-blue-500/5 border border-blue-500/20 rounded px-3 py-2 mt-2">
              <AlertTriangle className="w-3 h-3 text-blue-400 shrink-0 mt-0.5" />
              <p className="text-[10px] font-mono text-blue-300/90 leading-relaxed">
                {(report.news_correlation as NewsCorrelation).recommendation}
              </p>
            </div>
          )}
        </Section>
      )}

      {report.generated_at && (
        <p className="text-[9px] font-mono text-muted-foreground text-right pt-1">
          Generated {new Date(report.generated_at).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}

// ─── Analytics page ───────────────────────────────────────────────────────────

export function Analytics() {
  const [reportPeriod, setReportPeriod] = useState<"7d" | "30d" | "all">("7d");
  const [reportData, setReportData] = useState<HermesReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);

  const { data: agentStatus, isLoading: isLoadingStatus } = useGetAgentStatus({
    query: { queryKey: getGetAgentStatusQueryKey(), refetchInterval: 5000 }
  });

  const { data: dailySummary, isLoading: isLoadingSummary } = useGetDailySummary({
    query: { queryKey: getGetDailySummaryQueryKey(), refetchInterval: 5000 }
  });

  const { data: sessionData } = useQuery<{ authenticated: boolean }>({
    queryKey: ["agentSession"],
    queryFn: () => fetch("/api/agent/session", { credentials: "include" }).then(r => r.json()),
  });
  const isAuthenticated = sessionData?.authenticated === true;

  const handleGenerateReport = async () => {
    setReportData(null);
    setReportLoading(true);
    try {
      const res = await fetch("/api/hermes/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ period: reportPeriod }),
      });
      const data = await res.json() as { success: boolean; report: HermesReport };
      setReportData(data.success ? data.report : { error: "Report generation failed" });
    } catch {
      setReportData({ error: "Network error generating report" });
    } finally {
      setReportLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="section-header">Analytics</h1>

      {/* Daily Target Progress */}
      <Card className="bg-card border-border rounded-md">
        <CardHeader className="pb-4 border-b border-border/50">
          <CardTitle className="text-sm font-mono tracking-tight text-muted-foreground uppercase flex items-center gap-2">
            <BarChart2 className="w-4 h-4 text-primary" />
            Daily Target Progress
          </CardTitle>
        </CardHeader>
        <CardContent className="py-6 flex flex-col gap-6">
          {isLoadingStatus || !agentStatus ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <PnlProgress
              currentPnl={agentStatus.dailyPnl}
              floor={-agentStatus.dailyLossLimit}
              target={agentStatus.dailyProfitTarget}
            />
          )}

          {isLoadingSummary || !dailySummary ? (
            <Skeleton className="h-12 w-full" />
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t border-border mt-2">
              <div>
                <div className="text-[10px] text-muted-foreground uppercase font-mono mb-1">Trades</div>
                <div className="font-mono text-base font-semibold">{dailySummary.tradeCount}</div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground uppercase font-mono mb-1">Win / Loss</div>
                <div className="font-mono text-base font-semibold">
                  <span className="text-success">{dailySummary.winCount}</span>
                  <span className="text-muted-foreground mx-1">/</span>
                  <span className="text-destructive">{dailySummary.lossCount}</span>
                </div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground uppercase font-mono mb-1">London PNL</div>
                <div className={cn("font-mono text-base font-semibold", dailySummary.londonPnl > 0 ? "text-success" : dailySummary.londonPnl < 0 ? "text-destructive" : "")}>
                  {formatCurrency(dailySummary.londonPnl)}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground uppercase font-mono mb-1">NY PNL</div>
                <div className={cn("font-mono text-base font-semibold", dailySummary.nyPnl > 0 ? "text-success" : dailySummary.nyPnl < 0 ? "text-destructive" : "")}>
                  {formatCurrency(dailySummary.nyPnl)}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Hermes Report */}
      <Card className="bg-card border-border rounded-md">
        <CardHeader className="pb-4 border-b border-border/50">
          <CardTitle className="text-sm font-mono tracking-tight text-muted-foreground uppercase flex items-center gap-2">
            <Brain className="w-4 h-4 text-primary" />
            Hermes Performance Report
          </CardTitle>
        </CardHeader>
        <CardContent className="py-5 space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex gap-1">
              {(["7d", "30d", "all"] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setReportPeriod(p)}
                  className={cn(
                    "h-7 min-w-[40px] px-2 font-mono text-[10px] font-bold rounded border transition-colors",
                    reportPeriod === p
                      ? "bg-primary/20 border-primary text-primary"
                      : "bg-card border-border text-muted-foreground hover:border-primary/50"
                  )}
                >
                  {p.toUpperCase()}
                </button>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="font-mono text-[11px] font-bold border-primary/30 text-primary hover:bg-primary/10 h-7"
              disabled={!isAuthenticated || reportLoading}
              onClick={handleGenerateReport}
            >
              <Brain className="w-3 h-3 mr-1.5" />
              {reportLoading ? "GENERATING…" : "GENERATE REPORT"}
            </Button>
            {!isAuthenticated && (
              <span className="text-[10px] font-mono text-muted-foreground">Authenticate to generate</span>
            )}
          </div>

          <HermesReportBody report={reportData} isLoading={reportLoading} />
        </CardContent>
      </Card>
    </div>
  );
}
