import { useGetPositions, getGetPositionsQueryKey, useClosePosition } from "@workspace/api-client-react";
import { formatCurrency, formatPrice, formatDate } from "@/lib/format";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useState, Fragment } from "react";
import { X, AlertTriangle, Check, Pencil } from "lucide-react";

interface BrokerOrder {
  id: number;
  contractId: string;
  type: number;
  side: number;
  size: number;
  limitPrice: number | null;
  stopPrice: number | null;
  status: number;
  customTag: string | null;
}

function fetchBrokerOrders(): Promise<Record<string, BrokerOrder[]>> {
  return fetch("/api/agent/orders").then((r) => r.json());
}

function getBracketFromOrders(
  orders: BrokerOrder[] | undefined,
  isLong: boolean
): { stopPrice: number | null; tp1Price: number | null; hasSL: boolean; hasTP: boolean } {
  if (!orders || orders.length === 0) {
    return { stopPrice: null, tp1Price: null, hasSL: false, hasTP: false };
  }
  const closeSide = isLong ? 1 : 0;
  const slOrder = orders.find((o) => o.type === 4 && o.side === closeSide);
  const tpOrder = orders.find((o) => o.type === 1 && o.side === closeSide);
  return {
    stopPrice: slOrder?.stopPrice ?? null,
    tp1Price: tpOrder?.limitPrice ?? null,
    hasSL: !!slOrder,
    hasTP: !!tpOrder,
  };
}

interface EditState {
  stopPrice: string;
  tp1Price: string;
  tp2Price: string;
}

export function Positions() {
  const queryClient = useQueryClient();
  const { data: positions, isLoading } = useGetPositions({
    query: { queryKey: getGetPositionsQueryKey(), refetchInterval: 3000 }
  });

  const { data: brokerOrders, isLoading: ordersLoading, isError: ordersError } = useQuery({
    queryKey: ["broker-orders"],
    queryFn: fetchBrokerOrders,
    refetchInterval: 5000,
    retry: false,
  });
  // Orders data is unavailable (loading OR fetch failed) — never show "MISSING" in degraded state
  const ordersUnavailable = ordersLoading || ordersError;

  const [closingSymbol, setClosingSymbol] = useState<string | null>(null);
  const [closeMessage, setCloseMessage] = useState<{ symbol: string; text: string; ok: boolean } | null>(null);

  const [editingSymbol, setEditingSymbol] = useState<string | null>(null);
  const [editState, setEditState] = useState<EditState>({ stopPrice: "", tp1Price: "", tp2Price: "" });
  const [submitting, setSubmitting] = useState(false);
  const [bracketMessage, setBracketMessage] = useState<{ symbol: string; text: string; ok: boolean } | null>(null);

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

  const handleEditBracket = (
    symbol: string,
    dbStopPrice: number | null,
    dbTp1Price: number | null,
    dbTp2Price: number | null,
    brokerStop: number | null,
    brokerTp: number | null
  ) => {
    setEditingSymbol(symbol);
    setBracketMessage(null);
    setEditState({
      stopPrice: String(brokerStop ?? dbStopPrice ?? ""),
      tp1Price: String(brokerTp ?? dbTp1Price ?? ""),
      tp2Price: String(dbTp2Price ?? ""),
    });
  };

  const handleSubmitBracket = async (symbol: string) => {
    setSubmitting(true);
    setBracketMessage(null);
    try {
      const res = await fetch(`/api/positions/${symbol}/bracket`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stopPrice: Number(editState.stopPrice),
          tp1Price: Number(editState.tp1Price),
          tp2Price: editState.tp2Price ? Number(editState.tp2Price) : null,
        }),
      });
      const data = await res.json() as { success: boolean; message: string };
      setBracketMessage({ symbol, text: data.message, ok: data.success });
      if (data.success) {
        setEditingSymbol(null);
        queryClient.invalidateQueries({ queryKey: ["broker-orders"] });
        queryClient.invalidateQueries({ queryKey: getGetPositionsQueryKey() });
      }
    } catch {
      setBracketMessage({ symbol, text: "Request failed", ok: false });
    } finally {
      setSubmitting(false);
      setTimeout(() => setBracketMessage(null), 6000);
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-mono font-bold tracking-tight mb-4 border-b border-border/50 pb-2">OPEN POSITIONS</h1>

      {closeMessage && (
        <div className={cn(
          "rounded-md px-4 py-2 font-mono text-xs",
          closeMessage.ok
            ? "bg-success/10 text-success border border-success/30"
            : "bg-destructive/10 text-destructive border border-destructive/30"
        )}>
          {closeMessage.symbol}: {closeMessage.text}
        </div>
      )}

      {bracketMessage && (
        <div className={cn(
          "rounded-md px-4 py-2 font-mono text-xs",
          bracketMessage.ok
            ? "bg-success/10 text-success border border-success/30"
            : "bg-destructive/10 text-destructive border border-destructive/30"
        )}>
          {bracketMessage.symbol}: {bracketMessage.text}
        </div>
      )}

      <Card className="bg-card border-border rounded-md shadow-none">
        <CardContent className="p-0">
          <div className="rounded-md border-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider">INSTRUMENT</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider">DIR</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider">SIZE</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider text-right">ENTRY</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider text-right">CURRENT</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider text-right text-destructive/70">STOP (LIVE)</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider text-right text-success/70">TP1 (LIVE)</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider text-right text-success/50">TP2</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider text-right">UNREALIZED PNL</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider">OPENED</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider text-center">ACTIONS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array(3).fill(0).map((_, i) => (
                    <TableRow key={i} className="border-border">
                      <TableCell colSpan={11}><Skeleton className="h-8 w-full" /></TableCell>
                    </TableRow>
                  ))
                ) : !positions || positions.length === 0 ? (
                  <TableRow className="border-border hover:bg-transparent">
                    <TableCell colSpan={11} className="h-24 text-center text-muted-foreground font-mono text-sm">
                      No open positions at this time.
                    </TableCell>
                  </TableRow>
                ) : (
                  positions.map((position) => {
                    const symbolOrders = brokerOrders?.[position.instrument];
                    const isLong = position.direction === "long";
                    const { stopPrice: brokerStop, tp1Price: brokerTp, hasSL, hasTP } = getBracketFromOrders(symbolOrders, isLong);
                    // Only flag as missing when we have confirmed order data (not loading/error/degraded)
                    const bracketMissing = !ordersUnavailable && (!hasSL || !hasTP);
                    const isEditing = editingSymbol === position.instrument;

                    return (
                      <Fragment key={position.instrument}>
                        <TableRow
                          className={cn(
                            "border-border transition-colors",
                            bracketMissing
                              ? "bg-amber-950/20 hover:bg-amber-950/30 border-l-2 border-l-amber-500/70"
                              : "hover:bg-muted/50"
                          )}
                        >
                          <TableCell className="font-mono font-bold text-sm">
                            <div className="flex items-center gap-1.5">
                              {bracketMissing && (
                                <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                              )}
                              {position.instrument}
                            </div>
                          </TableCell>
                          <TableCell className={cn(
                            "font-mono text-xs font-bold",
                            position.direction === "long" ? "text-success" : "text-destructive"
                          )}>
                            {position.direction.toUpperCase()}
                          </TableCell>
                          <TableCell className="font-mono text-xs">{position.size}</TableCell>
                          <TableCell className="font-mono text-xs text-right text-muted-foreground">{formatPrice(position.entryPrice)}</TableCell>
                          <TableCell className="font-mono text-xs text-right font-medium">{formatPrice(position.currentPrice)}</TableCell>

                          <TableCell className="font-mono text-xs text-right">
                            {brokerStop != null ? (
                              <span className="text-destructive/80">{formatPrice(brokerStop)}</span>
                            ) : hasSL ? (
                              <span className="text-destructive/60">{position.stopPrice != null ? formatPrice(position.stopPrice) : "—"}</span>
                            ) : ordersUnavailable ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <span className="text-amber-500 font-bold">MISSING</span>
                            )}
                          </TableCell>

                          <TableCell className="font-mono text-xs text-right">
                            {brokerTp != null ? (
                              <span className="text-success/80">{formatPrice(brokerTp)}</span>
                            ) : hasTP ? (
                              <span className="text-success/60">{position.tp1Price != null ? formatPrice(position.tp1Price) : "—"}</span>
                            ) : ordersUnavailable ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <span className="text-amber-500 font-bold">MISSING</span>
                            )}
                          </TableCell>

                          <TableCell className="font-mono text-xs text-right text-success/60">
                            {position.tp2Price != null ? formatPrice(position.tp2Price) : <span className="text-muted-foreground">—</span>}
                          </TableCell>

                          <TableCell className={cn(
                            "font-mono text-sm font-bold text-right",
                            position.unrealizedPnl > 0 ? "text-success" :
                            position.unrealizedPnl < 0 ? "text-destructive" : "text-muted-foreground"
                          )}>
                            {formatCurrency(position.unrealizedPnl)}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {formatDate(position.openedAt)}
                          </TableCell>
                          <TableCell className="text-center">
                            <div className="flex items-center gap-1 justify-center">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleEditBracket(
                                  position.instrument,
                                  position.stopPrice,
                                  position.tp1Price,
                                  position.tp2Price,
                                  brokerStop,
                                  brokerTp
                                )}
                                className={cn(
                                  "h-7 px-2 font-mono text-[10px] border",
                                  bracketMissing
                                    ? "text-amber-400 hover:text-amber-300 hover:bg-amber-950/40 border-amber-500/50"
                                    : "text-muted-foreground hover:text-foreground hover:bg-muted border-border/50"
                                )}
                              >
                                <Pencil className="h-3 w-3 mr-1" />
                                {bracketMissing ? "FIX" : "SET"}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleClose(position.instrument)}
                                disabled={closingSymbol === position.instrument}
                                className="h-7 px-2 font-mono text-[10px] text-destructive hover:text-destructive hover:bg-destructive/10 border border-destructive/30"
                              >
                                {closingSymbol === position.instrument ? (
                                  "..."
                                ) : (
                                  <><X className="h-3 w-3 mr-1" />CLOSE</>
                                )}
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>

                        {isEditing && (
                          <TableRow key={`${position.instrument}-edit`} className="border-border bg-muted/20">
                            <TableCell colSpan={11} className="py-3 px-4">
                              <div className="flex items-end gap-3 flex-wrap">
                                <div className="flex flex-col gap-1">
                                  <label className="font-mono text-[10px] text-destructive/70 uppercase tracking-wider">Stop Loss</label>
                                  <Input
                                    type="number"
                                    value={editState.stopPrice}
                                    onChange={(e) => setEditState((s) => ({ ...s, stopPrice: e.target.value }))}
                                    className="h-7 w-28 font-mono text-xs text-destructive border-destructive/30 bg-background"
                                    step="any"
                                    placeholder="SL price"
                                  />
                                </div>
                                <div className="flex flex-col gap-1">
                                  <label className="font-mono text-[10px] text-success/70 uppercase tracking-wider">TP1</label>
                                  <Input
                                    type="number"
                                    value={editState.tp1Price}
                                    onChange={(e) => setEditState((s) => ({ ...s, tp1Price: e.target.value }))}
                                    className="h-7 w-28 font-mono text-xs text-success border-success/30 bg-background"
                                    step="any"
                                    placeholder="TP1 price"
                                  />
                                </div>
                                <div className="flex flex-col gap-1">
                                  <label className="font-mono text-[10px] text-success/50 uppercase tracking-wider">TP2 (opt.)</label>
                                  <Input
                                    type="number"
                                    value={editState.tp2Price}
                                    onChange={(e) => setEditState((s) => ({ ...s, tp2Price: e.target.value }))}
                                    className="h-7 w-28 font-mono text-xs text-success/70 border-success/20 bg-background"
                                    step="any"
                                    placeholder="TP2 price"
                                  />
                                </div>
                                <div className="flex gap-2 pb-0.5">
                                  <Button
                                    size="sm"
                                    disabled={submitting}
                                    onClick={() => handleSubmitBracket(position.instrument)}
                                    className="h-7 px-3 font-mono text-[10px] bg-primary text-primary-foreground hover:bg-primary/90"
                                  >
                                    {submitting ? "…" : <><Check className="h-3 w-3 mr-1" />SUBMIT</>}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => { setEditingSymbol(null); setBracketMessage(null); }}
                                    className="h-7 px-2 font-mono text-[10px] text-muted-foreground hover:text-foreground border border-border/50"
                                  >
                                    CANCEL
                                  </Button>
                                </div>
                                <p className="font-mono text-[10px] text-muted-foreground self-end pb-1">
                                  Cancels existing bracket orders and places new ones at these prices.
                                </p>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {positions && positions.length > 0 && !ordersLoading && (
        <p className="font-mono text-[10px] text-muted-foreground px-1">
          Live SL/TP pulled from broker order list. Positions highlighted in amber are missing bracket protection.
        </p>
      )}
    </div>
  );
}
