import { InstrumentStatus } from "@workspace/api-client-react";
import { formatCurrency, formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface InstrumentCardProps {
  instrument: InstrumentStatus;
}

export function InstrumentCard({ instrument }: InstrumentCardProps) {
  const isLong = instrument.position === "long";
  const isShort = instrument.position === "short";
  const isFlat = !instrument.position;

  return (
    <Card className="bg-card border-border rounded-md shadow-none flex flex-col h-full">
      <CardHeader className="pb-2 border-b border-border/50 px-4 py-3 flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base font-bold font-mono tracking-tight">{instrument.symbol}</CardTitle>
          <div className="text-xs text-muted-foreground uppercase">{instrument.name}</div>
        </div>
        <div className={cn(
          "px-2 py-1 rounded text-xs font-bold tracking-wider font-mono",
          isLong ? "bg-success/20 text-success" : 
          isShort ? "bg-destructive/20 text-destructive" : 
          "bg-muted text-muted-foreground"
        )}>
          {isLong ? "LONG" : isShort ? "SHORT" : "FLAT"}
          {!isFlat && <span className="ml-1 opacity-80">{instrument.positionSize}</span>}
        </div>
      </CardHeader>
      
      <CardContent className="px-4 py-4 grid gap-4">
        {/* PnL Section */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-mono mb-1">Unrealized PNL</div>
            <div className={cn(
              "font-mono text-sm font-semibold",
              (instrument.unrealizedPnl || 0) > 0 ? "text-success" : 
              (instrument.unrealizedPnl || 0) < 0 ? "text-destructive" : "text-foreground"
            )}>
              {formatCurrency(instrument.unrealizedPnl || 0)}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-mono mb-1">Today PNL</div>
            <div className={cn(
              "font-mono text-sm font-semibold",
              instrument.todayPnl > 0 ? "text-success" : 
              instrument.todayPnl < 0 ? "text-destructive" : "text-foreground"
            )}>
              {formatCurrency(instrument.todayPnl)}
            </div>
          </div>
        </div>

        {/* Price Section */}
        <div className="bg-muted/30 rounded p-3 grid grid-cols-2 gap-2 border border-border/50">
          <div>
            <div className="text-[10px] text-muted-foreground uppercase font-mono">Last Price</div>
            <div className="font-mono text-sm">{formatPrice(instrument.lastPrice)}</div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase font-mono">Entry Price</div>
            <div className="font-mono text-sm">{formatPrice(instrument.entryPrice)}</div>
          </div>
        </div>

        {/* Range Section */}
        <div className="flex justify-between items-center text-xs font-mono">
          <div>
            <span className="text-[10px] text-muted-foreground uppercase block">Range Low</span>
            <span>{formatPrice(instrument.rangeLow)}</span>
          </div>
          <div className="text-center w-full px-4 relative">
             <div className="h-1 bg-border rounded-full w-full"></div>
          </div>
          <div className="text-right">
            <span className="text-[10px] text-muted-foreground uppercase block">Range High</span>
            <span>{formatPrice(instrument.rangeHigh)}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
