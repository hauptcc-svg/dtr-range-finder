import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { InstrumentStatus } from "@workspace/api-client-react";
import { formatCurrency, formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getGetInstrumentsQueryKey } from "@workspace/api-client-react";

interface InstrumentCardProps {
  instrument: InstrumentStatus;
  isAuthenticated: boolean;
}

function Toggle({
  enabled,
  onToggle,
  disabled,
}: {
  enabled: boolean;
  onToggle: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={disabled}
      onClick={() => onToggle(!enabled)}
      className={cn(
        "relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent",
        "transition-colors duration-200 ease-in-out focus:outline-none",
        enabled ? "bg-success" : "bg-muted",
        disabled && "opacity-40 cursor-not-allowed"
      )}
    >
      <span
        className={cn(
          "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-background shadow",
          "transition duration-200 ease-in-out",
          enabled ? "translate-x-4" : "translate-x-0"
        )}
      />
    </button>
  );
}

export function InstrumentCard({ instrument, isAuthenticated }: InstrumentCardProps) {
  const queryClient = useQueryClient();
  const [optimisticEnabled, setOptimisticEnabled] = useState<boolean | null>(null);
  const effectiveEnabled = optimisticEnabled ?? instrument.enabled;

  const isLong = instrument.position === "long";
  const isShort = instrument.position === "short";
  const isFlat = !instrument.position;

  const toggleMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await fetch(`/api/agent/instruments/${instrument.symbol}/toggle`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error((body.error as string) ?? "Toggle failed");
      }
      return res.json();
    },
    onMutate: (enabled) => {
      setOptimisticEnabled(enabled);
    },
    onError: () => {
      setOptimisticEnabled(null);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getGetInstrumentsQueryKey() });
    },
  });

  return (
    <Card className={cn(
      "bg-card border-border rounded-md shadow-none flex flex-col h-full transition-opacity duration-200",
      !effectiveEnabled && "opacity-50"
    )}>
      <CardHeader className="pb-2 border-b border-border/50 px-4 py-3 flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base font-bold font-mono tracking-tight">{instrument.symbol}</CardTitle>
          <div className="text-xs text-muted-foreground uppercase">{instrument.name}</div>
        </div>
        <div className="flex items-center gap-3">
          <div className={cn(
            "px-2 py-1 rounded text-xs font-bold tracking-wider font-mono",
            isLong ? "bg-success/20 text-success" :
            isShort ? "bg-destructive/20 text-destructive" :
            "bg-muted text-muted-foreground"
          )}>
            {isLong ? "LONG" : isShort ? "SHORT" : "FLAT"}
            {!isFlat && <span className="ml-1 opacity-80">{instrument.positionSize}</span>}
          </div>
          <Toggle
            enabled={effectiveEnabled}
            onToggle={(next) => toggleMutation.mutate(next)}
            disabled={!isAuthenticated || toggleMutation.isPending}
          />
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

        {/* Stats */}
        <div className="grid grid-cols-3 gap-2 pt-1 border-t border-border/30 text-[10px] font-mono text-muted-foreground uppercase">
          <div>
            <div>Trades</div>
            <div className="text-foreground text-xs">{instrument.todayTrades}</div>
          </div>
          <div>
            <div>Long L</div>
            <div className="text-foreground text-xs">{instrument.longLosses}</div>
          </div>
          <div>
            <div>Short L</div>
            <div className="text-foreground text-xs">{instrument.shortLosses}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
