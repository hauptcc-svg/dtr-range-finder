import { useState } from "react";
import { Brain, ChevronDown, ChevronRight, TrendingUp, TrendingDown, Settings, AlertTriangle, Newspaper, BarChart2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Types matching the Hermes generate_feedback_report() JSON output
// ─────────────────────────────────────────────────────────────────────────────

export interface WinRateSetup {
  symbol: string;
  session: string;
  direction: string;
  day_of_week: string;
  trades: number;
  wins: number;
  win_rate: number;
  avg_pnl: number;
}

export interface InstrumentPerformance {
  symbol: string;
  win_rate: number;
  trades: number;
  avg_pnl: number;
  note?: string;
}

export interface ParamRecommendation {
  param: string;
  current: number;
  suggested: number;
  symbol?: string;
  reasoning: string;
  auto_apply: boolean;
}

export interface EarlyCloseAnalysis {
  total_early_closes: number;
  correct_closes: number;
  premature_closes: number;
  notes: string;
}

export interface NewsCorrelation {
  events_detected: string[];
  pattern: string;
  affected_symbols: string[];
  recommendation: string;
}

export interface HermesReport {
  // Hermes structured output
  win_rate_by_setup?: WinRateSetup[];
  best_instruments?: InstrumentPerformance[];
  worst_instruments?: InstrumentPerformance[];
  param_recommendations?: ParamRecommendation[];
  early_close_analysis?: EarlyCloseAnalysis;
  news_correlation?: NewsCorrelation;
  overall_summary?: string;
  // Meta fields added by Python
  period?: string;
  trade_count?: number;
  generated_at?: string;
  // Error / fallback
  error?: string;
  raw_response?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

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
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-muted/20 hover:bg-muted/30 transition-colors text-left"
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
      {open && <div className="px-3 py-3 bg-background/40">{children}</div>}
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

// ─────────────────────────────────────────────────────────────────────────────
// Main modal
// ─────────────────────────────────────────────────────────────────────────────

interface HermesReportModalProps {
  open: boolean;
  onClose: () => void;
  report: HermesReport | null;
  isLoading: boolean;
}

export function HermesReportModal({ open, onClose, report, isLoading }: HermesReportModalProps) {
  const [approvedParams, setApprovedParams] = useState<Record<string, "approved" | "rejected">>({});

  if (!open) return null;

  const handleParamAction = async (rec: ParamRecommendation, action: "APPROVE" | "REJECT") => {
    const key = `${rec.symbol ?? "ALL"}_${rec.param}`;
    setApprovedParams((p) => ({ ...p, [key]: action === "APPROVE" ? "approved" : "rejected" }));
    try {
      await fetch("/api/telegram/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: `${action}_${rec.symbol ?? "ALL"}_${rec.param}_${rec.suggested}`,
        }),
      });
    } catch {
      // Non-critical — button state already updated
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <Card className="w-full max-w-2xl max-h-[88vh] overflow-hidden flex flex-col bg-card border-primary/30 shadow-[0_0_40px_rgba(99,102,241,0.12)]">
        {/* Header */}
        <CardHeader className="pb-3 border-b border-border/50 flex flex-row items-center gap-2 shrink-0">
          <Brain className="w-4 h-4 text-primary" />
          <CardTitle className="text-sm font-mono tracking-tight uppercase text-primary">
            Hermes Performance Report
          </CardTitle>
          {report?.period && (
            <span className="text-[10px] font-mono text-muted-foreground ml-1">
              — {report.period}
            </span>
          )}
          {report?.trade_count != null && (
            <span className="text-[10px] font-mono text-muted-foreground">
              · {report.trade_count} trades
            </span>
          )}
          <button
            className="ml-auto text-muted-foreground hover:text-foreground text-xs font-mono"
            onClick={onClose}
          >
            ✕
          </button>
        </CardHeader>

        {/* Body */}
        <CardContent className="py-4 overflow-y-auto flex-1 space-y-3">

          {/* Loading state */}
          {isLoading && (
            <div className="flex flex-col items-center justify-center gap-4 py-16 text-muted-foreground">
              <Brain className="w-10 h-10 text-primary animate-pulse" />
              <p className="font-mono text-xs uppercase tracking-widest text-center">
                Hermes is analysing your trades
              </p>
              <p className="font-mono text-[10px] text-muted-foreground/60">
                This usually takes 10–20 seconds
              </p>
            </div>
          )}

          {/* Error state */}
          {!isLoading && report?.error && (
            <div className="font-mono text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded px-4 py-3">
              {report.error}
            </div>
          )}

          {/* Fallback: raw text when JSON parse failed */}
          {!isLoading && report?.raw_response && !report.error && (
            <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed bg-muted/10 rounded px-4 py-3 overflow-x-auto">
              {report.raw_response}
            </pre>
          )}

          {/* Structured report */}
          {!isLoading && report && !report.error && !report.raw_response && (
            <>
              {/* Overall Summary */}
              {report.overall_summary && (
                <div className="bg-primary/5 border border-primary/20 rounded px-4 py-3">
                  <p className="text-xs font-mono text-primary/90 leading-relaxed">
                    {report.overall_summary}
                  </p>
                </div>
              )}

              {/* Win Rate by Setup */}
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
                        {report.win_rate_by_setup.map((s, i) => (
                          <tr key={i} className="border-b border-border/20 last:border-0">
                            <td className="py-1.5 pr-3 text-foreground font-semibold">{s.symbol.replace(/M\d+$/, "")}</td>
                            <td className="py-1.5 pr-3 text-muted-foreground">{s.session}</td>
                            <td className={cn("py-1.5 pr-3 font-bold", s.direction === "LONG" ? "text-success" : "text-destructive")}>
                              {s.direction}
                            </td>
                            <td className="py-1.5 pr-3 text-muted-foreground">{s.day_of_week?.slice(0, 3)}</td>
                            <td className="py-1.5 pr-3 text-right">
                              <WinRateBadge rate={s.win_rate} />
                            </td>
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

              {/* Best + Worst Instruments */}
              {((report.best_instruments && report.best_instruments.length > 0) ||
                (report.worst_instruments && report.worst_instruments.length > 0)) && (
                <Section
                  title="Instrument Performance"
                  icon={<TrendingUp className="w-3 h-3 text-success" />}
                  defaultOpen
                >
                  <div className="grid grid-cols-2 gap-3">
                    {report.best_instruments && report.best_instruments.length > 0 && (
                      <div>
                        <p className="text-[9px] font-mono uppercase text-success/70 tracking-widest mb-1.5">🏆 Best</p>
                        {report.best_instruments.map((inst, i) => (
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
                        {report.worst_instruments.map((inst, i) => (
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

              {/* Param Recommendations */}
              {report.param_recommendations && report.param_recommendations.length > 0 && (
                <Section
                  title={`Parameter Recommendations (${report.param_recommendations.length})`}
                  icon={<Settings className="w-3 h-3 text-yellow-400" />}
                >
                  <div className="space-y-2">
                    {report.param_recommendations.map((rec, i) => {
                      const key = `${rec.symbol ?? "ALL"}_${rec.param}`;
                      const state = approvedParams[key];
                      return (
                        <div key={i} className="bg-muted/20 border border-border/50 rounded px-3 py-2">
                          <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-bold text-[10px] text-yellow-400">{rec.param}</span>
                              {rec.symbol && (
                                <span className="font-mono text-[9px] text-muted-foreground">{rec.symbol.replace(/M\d+$/, "")}</span>
                              )}
                              <span className="font-mono text-[10px] text-muted-foreground">
                                {rec.current} → <span className="text-primary">{rec.suggested}</span>
                              </span>
                              {rec.auto_apply && (
                                <span className="text-[8px] font-mono bg-success/20 text-success px-1 py-0.5 rounded">AUTO</span>
                              )}
                            </div>
                            {!state ? (
                              <div className="flex gap-1">
                                <button
                                  onClick={() => handleParamAction(rec, "APPROVE")}
                                  className="h-6 px-2 font-mono text-[9px] font-bold rounded bg-success/20 text-success hover:bg-success/30 border border-success/30"
                                >
                                  APPROVE
                                </button>
                                <button
                                  onClick={() => handleParamAction(rec, "REJECT")}
                                  className="h-6 px-2 font-mono text-[9px] font-bold rounded bg-destructive/20 text-destructive hover:bg-destructive/30 border border-destructive/30"
                                >
                                  REJECT
                                </button>
                              </div>
                            ) : (
                              <span className={cn(
                                "text-[9px] font-mono font-bold px-2 py-0.5 rounded",
                                state === "approved" ? "bg-success/20 text-success" : "bg-destructive/20 text-destructive"
                              )}>
                                {state.toUpperCase()}
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-muted-foreground font-mono leading-relaxed">{rec.reasoning}</p>
                        </div>
                      );
                    })}
                  </div>
                </Section>
              )}

              {/* Early Close Analysis */}
              {report.early_close_analysis && (
                <Section
                  title="Early Close Analysis"
                  icon={<TrendingDown className="w-3 h-3 text-orange-400" />}
                >
                  <div className="grid grid-cols-3 gap-2 mb-3">
                    <div className="bg-muted/20 rounded px-2 py-1.5 text-center">
                      <div className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest">Total</div>
                      <div className="font-mono font-bold text-sm">{report.early_close_analysis.total_early_closes}</div>
                    </div>
                    <div className="bg-success/10 border border-success/20 rounded px-2 py-1.5 text-center">
                      <div className="text-[9px] font-mono text-success/70 uppercase tracking-widest">Correct</div>
                      <div className="font-mono font-bold text-sm text-success">{report.early_close_analysis.correct_closes}</div>
                    </div>
                    <div className="bg-orange-500/10 border border-orange-500/20 rounded px-2 py-1.5 text-center">
                      <div className="text-[9px] font-mono text-orange-400/70 uppercase tracking-widest">Premature</div>
                      <div className="font-mono font-bold text-sm text-orange-400">{report.early_close_analysis.premature_closes}</div>
                    </div>
                  </div>
                  {report.early_close_analysis.notes && (
                    <p className="text-[10px] font-mono text-muted-foreground leading-relaxed">
                      {report.early_close_analysis.notes}
                    </p>
                  )}
                </Section>
              )}

              {/* News Correlation */}
              {report.news_correlation && (
                <Section
                  title="News Correlation"
                  icon={<Newspaper className="w-3 h-3 text-blue-400" />}
                >
                  {report.news_correlation.events_detected?.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {report.news_correlation.events_detected.map((ev, i) => (
                        <span key={i} className="font-mono text-[9px] bg-blue-500/10 text-blue-400 border border-blue-500/20 px-1.5 py-0.5 rounded">
                          {ev}
                        </span>
                      ))}
                    </div>
                  )}
                  {report.news_correlation.pattern && (
                    <p className="text-[10px] font-mono text-muted-foreground leading-relaxed mb-2">
                      {report.news_correlation.pattern}
                    </p>
                  )}
                  {report.news_correlation.affected_symbols?.length > 0 && (
                    <div className="flex items-center gap-1 mb-2">
                      <span className="text-[9px] font-mono text-muted-foreground">Affected:</span>
                      {report.news_correlation.affected_symbols.map((sym, i) => (
                        <span key={i} className="font-mono text-[9px] bg-muted/30 text-foreground px-1 py-0.5 rounded">
                          {sym.replace(/M\d+$/, "")}
                        </span>
                      ))}
                    </div>
                  )}
                  {report.news_correlation.recommendation && (
                    <div className="flex items-start gap-2 bg-blue-500/5 border border-blue-500/20 rounded px-2 py-2 mt-2">
                      <AlertTriangle className="w-3 h-3 text-blue-400 shrink-0 mt-0.5" />
                      <p className="text-[10px] font-mono text-blue-300/90 leading-relaxed">
                        {report.news_correlation.recommendation}
                      </p>
                    </div>
                  )}
                </Section>
              )}
            </>
          )}
        </CardContent>

        {/* Footer */}
        {report?.generated_at && (
          <div className="shrink-0 border-t border-border/50 px-4 py-2 flex items-center justify-between">
            <span className="text-[9px] font-mono text-muted-foreground">
              Generated {new Date(report.generated_at).toLocaleTimeString()}
            </span>
            <Button variant="outline" size="sm" className="font-mono text-xs h-7" onClick={onClose}>
              Close
            </Button>
          </div>
        )}
        {!report?.generated_at && (
          <div className="shrink-0 border-t border-border/50 px-4 py-3 flex justify-end">
            <Button variant="outline" size="sm" className="font-mono text-xs" onClick={onClose}>
              Close
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
