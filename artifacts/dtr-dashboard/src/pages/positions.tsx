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
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { X } from "lucide-react";

export function Positions() {
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
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider text-right text-destructive/70">STOP</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider text-right text-success/70">TP1</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider text-right text-success/50">TP2</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider text-right">UNREALIZED PNL</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider">OPENED</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider text-center">ACTION</TableHead>
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
                  positions.map((position) => (
                    <TableRow key={`${position.instrument}-${position.openedAt}`} className="border-border hover:bg-muted/50 transition-colors">
                      <TableCell className="font-mono font-bold text-sm">{position.instrument}</TableCell>
                      <TableCell className={cn(
                        "font-mono text-xs font-bold",
                        position.direction === "long" ? "text-success" : "text-destructive"
                      )}>
                        {position.direction.toUpperCase()}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{position.size}</TableCell>
                      <TableCell className="font-mono text-xs text-right text-muted-foreground">{formatPrice(position.entryPrice)}</TableCell>
                      <TableCell className="font-mono text-xs text-right font-medium">{formatPrice(position.currentPrice)}</TableCell>
                      <TableCell className="font-mono text-xs text-right text-destructive/80">
                        {position.stopPrice != null ? formatPrice(position.stopPrice) : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-right text-success/80">
                        {position.tp1Price != null ? formatPrice(position.tp1Price) : <span className="text-muted-foreground">—</span>}
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
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
