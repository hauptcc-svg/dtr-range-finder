import React from "react";
import { useGetTrades, getGetTradesQueryKey, useUpdateTradeNotes } from "@workspace/api-client-react";
import type { Trade } from "@workspace/api-client-react";
import { formatCurrency, formatPrice, formatDate, formatSessionPhase } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, BookOpen, StickyNote } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

function computeStats(trades: Trade[]) {
  const closed = trades.filter((t) => t.status === "closed" && t.pnl != null);
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0);
  const losses = closed.filter((t) => (t.pnl ?? 0) < 0);
  const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : null;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length : null;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length) : null;
  const grossProfit = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;
  return { total: closed.length, winRate, avgWin, avgLoss, profitFactor };
}

interface JournalPanelProps {
  trade: Trade;
  onClose: () => void;
}

function JournalPanel({ trade, onClose }: JournalPanelProps) {
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState(trade.notes ?? "");
  const [saved, setSaved] = useState(false);

  const { mutate: saveNotes, isPending } = useUpdateTradeNotes({
    mutation: {
      onSuccess: () => {
        setSaved(true);
        queryClient.invalidateQueries({ queryKey: getGetTradesQueryKey() });
        setTimeout(() => setSaved(false), 2500);
      },
    },
  });

  const handleSave = () => {
    saveNotes({ id: trade.id, data: { notes: notes.trim() || null } });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-lg shadow-2xl w-full max-w-lg mx-4 p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-mono font-bold text-base">TRADE JOURNAL</h2>
            <p className="font-mono text-xs text-muted-foreground mt-0.5">
              #{trade.id} · {trade.instrument} · {trade.direction.toUpperCase()} · {formatDate(trade.entryTime)}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} className="font-mono text-xs">✕</Button>
        </div>

        <div className="grid grid-cols-3 gap-3 py-3 border-y border-border">
          <div>
            <div className="font-mono text-[10px] text-muted-foreground">ENTRY</div>
            <div className="font-mono text-xs font-medium">{formatPrice(trade.entryPrice)}</div>
          </div>
          <div>
            <div className="font-mono text-[10px] text-muted-foreground">EXIT</div>
            <div className="font-mono text-xs font-medium">{formatPrice(trade.exitPrice)}</div>
          </div>
          <div>
            <div className="font-mono text-[10px] text-muted-foreground">P&L</div>
            <div className={cn(
              "font-mono text-xs font-bold",
              (trade.pnl ?? 0) > 0 ? "text-success" : (trade.pnl ?? 0) < 0 ? "text-destructive" : "text-muted-foreground"
            )}>
              {formatCurrency(trade.pnl)}
            </div>
          </div>
          {trade.stopPrice != null && (
            <div>
              <div className="font-mono text-[10px] text-muted-foreground">STOP</div>
              <div className="font-mono text-xs text-destructive/80">{formatPrice(trade.stopPrice)}</div>
            </div>
          )}
          {trade.tp1Price != null && (
            <div>
              <div className="font-mono text-[10px] text-muted-foreground">TP1</div>
              <div className="font-mono text-xs text-success/80">{formatPrice(trade.tp1Price)}</div>
            </div>
          )}
          {trade.tp2Price != null && (
            <div>
              <div className="font-mono text-[10px] text-muted-foreground">TP2</div>
              <div className="font-mono text-xs text-success/60">{formatPrice(trade.tp2Price)}</div>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <label className="font-mono text-xs text-muted-foreground">NOTES</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Why did you take this trade? What happened? Lessons learned..."
            rows={5}
            className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs resize-none focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
        </div>

        <div className="flex items-center justify-end gap-2">
          {saved && <span className="font-mono text-xs text-success">Saved!</span>}
          <Button variant="outline" size="sm" onClick={onClose} className="font-mono text-xs">Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={isPending} className="font-mono text-xs">
            {isPending ? "Saving..." : "Save Notes"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Trades() {
  const [page, setPage] = useState(1);
  const pageSize = 15;
  const [journalTrade, setJournalTrade] = useState<Trade | null>(null);

  const { data, isLoading } = useGetTrades(
    { page, pageSize },
    { query: { queryKey: getGetTradesQueryKey({ page, pageSize }), refetchInterval: 5000 } }
  );

  const stats = data ? computeStats(data.trades) : null;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-mono font-bold tracking-tight mb-4 border-b border-border/50 pb-2">TRADE HISTORY</h1>

      {stats && stats.total > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { label: "CLOSED TRADES", value: stats.total.toString(), pos: false, neg: false },
            { label: "WIN RATE", value: stats.winRate != null ? `${stats.winRate.toFixed(1)}%` : "—", pos: false, neg: false },
            { label: "AVG WIN", value: stats.avgWin != null ? formatCurrency(stats.avgWin) : "—", pos: true, neg: false },
            { label: "AVG LOSS", value: stats.avgLoss != null ? formatCurrency(-stats.avgLoss) : "—", pos: false, neg: true },
            { label: "PROFIT FACTOR", value: stats.profitFactor != null ? stats.profitFactor.toFixed(2) : "—", pos: false, neg: false },
          ].map(({ label, value, pos, neg }) => (
            <Card key={label} className="bg-card border-border shadow-none rounded-md">
              <CardContent className="p-3">
                <div className="font-mono text-[10px] text-muted-foreground tracking-wider">{label}</div>
                <div className={cn(
                  "font-mono text-base font-bold mt-0.5",
                  pos ? "text-success" : neg ? "text-destructive" : "text-foreground"
                )}>
                  {value}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card className="bg-card border-border rounded-md shadow-none">
        <CardContent className="p-0">
          <div className="rounded-md border-0">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider">TIME</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider">INSTRUMENT</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider">DIR</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider">QTY</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider text-right">ENTRY</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider text-right">EXIT</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider text-right">PNL</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider">SESSION</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider">STATUS</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider text-center">JOURNAL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array(5).fill(0).map((_, i) => (
                    <TableRow key={i} className="border-border">
                      <TableCell colSpan={10}><Skeleton className="h-8 w-full" /></TableCell>
                    </TableRow>
                  ))
                ) : data?.trades.length === 0 ? (
                  <TableRow className="border-border hover:bg-transparent">
                    <TableCell colSpan={10} className="h-24 text-center text-muted-foreground font-mono text-sm">
                      No trades recorded yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  data?.trades.map((trade) => (
                    <React.Fragment key={trade.id}>
                      <TableRow className="border-border hover:bg-muted/50 transition-colors">
                        <TableCell className="font-mono text-xs whitespace-nowrap text-muted-foreground">
                          {formatDate(trade.entryTime)}
                        </TableCell>
                        <TableCell className="font-mono font-medium">{trade.instrument}</TableCell>
                        <TableCell className={cn(
                          "font-mono text-xs font-bold",
                          trade.direction === "long" ? "text-success" : "text-destructive"
                        )}>
                          {trade.direction.toUpperCase()}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{trade.qty}</TableCell>
                        <TableCell className="font-mono text-xs text-right">{formatPrice(trade.entryPrice)}</TableCell>
                        <TableCell className="font-mono text-xs text-right text-muted-foreground">{formatPrice(trade.exitPrice)}</TableCell>
                        <TableCell className={cn(
                          "font-mono text-xs font-bold text-right",
                          (trade.pnl || 0) > 0 ? "text-success" :
                          (trade.pnl || 0) < 0 ? "text-destructive" : "text-muted-foreground"
                        )}>
                          {formatCurrency(trade.pnl)}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{formatSessionPhase(trade.session)}</TableCell>
                        <TableCell className="font-mono text-xs">
                          <span className={cn(
                            "px-2 py-0.5 rounded text-[10px] uppercase font-bold",
                            trade.status === "open" ? "bg-primary/20 text-primary" :
                            trade.status === "closed" ? "bg-muted text-muted-foreground" :
                            "bg-destructive/20 text-destructive"
                          )}>
                            {trade.status}
                          </span>
                        </TableCell>
                        <TableCell className="text-center">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setJournalTrade(trade)}
                            className={cn(
                              "h-7 w-7 p-0",
                              trade.notes ? "text-primary" : "text-muted-foreground hover:text-foreground"
                            )}
                            title={trade.notes ? "View/edit notes" : "Add journal note"}
                          >
                            {trade.notes ? (
                              <StickyNote className="h-3.5 w-3.5" />
                            ) : (
                              <BookOpen className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </TableCell>
                      </TableRow>
                      {trade.notes && (
                        <TableRow className="border-border bg-muted/20 hover:bg-muted/30">
                          <TableCell colSpan={10} className="py-1.5 pl-4 pr-4">
                            <div className="flex items-start gap-2">
                              <StickyNote className="h-3 w-3 text-primary/60 mt-0.5 flex-shrink-0" />
                              <span className="font-mono text-[11px] text-muted-foreground italic line-clamp-2">
                                {trade.notes}
                              </span>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {data && data.total > pageSize && (
            <div className="flex items-center justify-end space-x-2 p-4 border-t border-border">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="font-mono text-xs"
              >
                <ChevronLeft className="h-4 w-4 mr-1" /> PREV
              </Button>
              <span className="font-mono text-xs text-muted-foreground">
                PAGE {page} OF {Math.ceil(data.total / pageSize)}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => p + 1)}
                disabled={page >= Math.ceil(data.total / pageSize)}
                className="font-mono text-xs"
              >
                NEXT <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {journalTrade && (
        <JournalPanel trade={journalTrade} onClose={() => setJournalTrade(null)} />
      )}
    </div>
  );
}
