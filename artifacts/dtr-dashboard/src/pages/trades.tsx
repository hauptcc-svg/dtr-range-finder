import { useGetTrades, getGetTradesQueryKey } from "@workspace/api-client-react";
import { formatCurrency, formatPrice, formatDate, formatSessionPhase } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { ChevronLeft, ChevronRight } from "lucide-react";

export function Trades() {
  const [page, setPage] = useState(1);
  const pageSize = 15;

  const { data, isLoading } = useGetTrades(
    { page, pageSize },
    { query: { queryKey: getGetTradesQueryKey({ page, pageSize }), refetchInterval: 5000 } }
  );

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-mono font-bold tracking-tight mb-4 border-b border-border/50 pb-2">TRADE HISTORY</h1>
      
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array(5).fill(0).map((_, i) => (
                    <TableRow key={i} className="border-border">
                      <TableCell colSpan={9}><Skeleton className="h-8 w-full" /></TableCell>
                    </TableRow>
                  ))
                ) : data?.trades.length === 0 ? (
                  <TableRow className="border-border hover:bg-transparent">
                    <TableCell colSpan={9} className="h-24 text-center text-muted-foreground font-mono text-sm">
                      No trades recorded yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  data?.trades.map((trade) => (
                    <TableRow key={trade.id} className="border-border hover:bg-muted/50 transition-colors">
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
                    </TableRow>
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
    </div>
  );
}
