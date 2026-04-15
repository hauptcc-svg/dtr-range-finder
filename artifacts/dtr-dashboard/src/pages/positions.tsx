import { useGetPositions } from "@workspace/api-client-react";
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
import { cn } from "@/lib/utils";

export function Positions() {
  const { data: positions, isLoading } = useGetPositions({
    query: { refetchInterval: 3000 }
  });

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-mono font-bold tracking-tight mb-4 border-b border-border/50 pb-2">OPEN POSITIONS</h1>
      
      <Card className="bg-card border-border rounded-md shadow-none">
        <CardContent className="p-0">
          <div className="rounded-md border-0">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider">INSTRUMENT</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider">DIR</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider">SIZE</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider text-right">ENTRY</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider text-right">CURRENT</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider text-right">UNREALIZED PNL</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground font-bold tracking-wider">OPENED</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array(3).fill(0).map((_, i) => (
                    <TableRow key={i} className="border-border">
                      <TableCell colSpan={7}><Skeleton className="h-8 w-full" /></TableCell>
                    </TableRow>
                  ))
                ) : !positions || positions.length === 0 ? (
                  <TableRow className="border-border hover:bg-transparent">
                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground font-mono text-sm">
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
