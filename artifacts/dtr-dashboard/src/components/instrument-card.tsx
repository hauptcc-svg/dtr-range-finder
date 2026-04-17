import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { InstrumentStatus, RbsStageSnapshot } from "@workspace/api-client-react";
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

const STAGE_LABELS: Record<number, string> = {
  0: "Waiting for sweep",
  1: "Swept",
  2: "Bias candle fired",
  3: "Retest pending",
};

function stageInfo(stage: number, pending: boolean, signalFired: boolean): { label: string; colorClass: string } {
  if (signalFired || pending) return { label: `${stage} — Signal active`, colorClass: "text-yellow-400" };
  switch (stage) {
    case 0: return { label: `0 — ${STAGE_LABELS[0]}`, colorClass: "text-muted-foreground" };
    case 1: return { label: `1 — ${STAGE_LABELS[1]}`, colorClass: "text-blue-400" };
    case 2: return { label: `2 — ${STAGE_LABELS[2]}`, colorClass: "text-orange-400" };
    case 3: return { label: `3 — ${STAGE_LABELS[3]}`, colorClass: "text-purple-400" };
    default: return { label: `${stage}`, colorClass: "text-muted-foreground" };
  }
}

const STEP_CONFIG = [
  { label: "Swpt", activeColor: "#60a5fa" },
  { label: "Bias", activeColor: "#fb923c" },
  { label: "Rtst", activeColor: "#c084fc" },
  { label: "Sig",  activeColor: "#facc15" },
] as const;

function getActiveStep(stage: number, pending: boolean, signalFired: boolean): number {
  if (signalFired || pending) return 4;
  return stage;
}

function StageTracker({
  stage,
  pending,
  signalFired,
}: {
  stage: number;
  pending: boolean;
  signalFired: boolean;
}) {
  const activeStep = getActiveStep(stage, pending, signalFired);

  return (
    <div className="flex items-center gap-0 w-full">
      {STEP_CONFIG.map((step, i) => {
        const stepNumber = i + 1;
        const isActive = activeStep === stepNumber;
        const isCompleted = activeStep > stepNumber;
        const isReached = isActive || isCompleted;
        const isLast = i === STEP_CONFIG.length - 1;

        return (
          <div key={step.label} className="flex items-center" style={{ flex: isLast ? "0 0 auto" : "1 1 0%" }}>
            <div
              title={step.label}
              className="relative flex items-center justify-center flex-shrink-0"
              style={{ width: 14, height: 14 }}
            >
              <div
                className="rounded-full transition-all duration-300"
                style={{
                  width: isActive ? 12 : 8,
                  height: isActive ? 12 : 8,
                  backgroundColor: isReached ? step.activeColor : "#374151",
                  opacity: isCompleted ? 0.55 : 1,
                  boxShadow: isActive ? `0 0 6px 2px ${step.activeColor}66` : "none",
                }}
              />
            </div>
            {!isLast && (
              <div
                className="h-px flex-1 transition-all duration-300"
                style={{
                  backgroundColor: isCompleted ? STEP_CONFIG[i].activeColor : "#374151",
                  opacity: isCompleted ? 0.4 : 1,
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function RbsSessionRow({ label, snapshot }: { label: string; snapshot: RbsStageSnapshot | null }) {
  if (!snapshot) {
    return (
      <div className="grid grid-cols-[32px_1fr_1fr] gap-x-2 items-start">
        <span className="text-[10px] text-muted-foreground uppercase font-mono font-bold pt-0.5">{label}</span>
        <span className="text-[10px] text-muted-foreground col-span-2 italic">Not started</span>
      </div>
    );
  }

  const short = stageInfo(snapshot.shortStage, snapshot.shortPending, snapshot.shortSignalFired);
  const long = stageInfo(snapshot.longStage, snapshot.longPending, snapshot.longSignalFired);

  return (
    <div className="grid grid-cols-[32px_1fr_1fr] gap-x-2 items-start">
      <span className="text-[10px] text-muted-foreground uppercase font-mono font-bold pt-0.5">{label}</span>
      <div>
        <div className="text-[9px] text-muted-foreground uppercase font-mono mb-1">Short</div>
        <StageTracker
          stage={snapshot.shortStage}
          pending={snapshot.shortPending}
          signalFired={snapshot.shortSignalFired}
        />
        <div className={cn("text-[9px] font-mono leading-tight mt-1", short.colorClass)}>{short.label}</div>
      </div>
      <div>
        <div className="text-[9px] text-muted-foreground uppercase font-mono mb-1">Long</div>
        <StageTracker
          stage={snapshot.longStage}
          pending={snapshot.longPending}
          signalFired={snapshot.longSignalFired}
        />
        <div className={cn("text-[9px] font-mono leading-tight mt-1", long.colorClass)}>{long.label}</div>
      </div>
    </div>
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

        {/* RBS Strategy Stage Section */}
        <div className="border-t border-border/30 pt-3 grid gap-2">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-mono mb-1">RBS Stage</div>
          <RbsSessionRow label="LON" snapshot={instrument.rbsLondon ?? null} />
          <RbsSessionRow label="NY" snapshot={instrument.rbsNy ?? null} />
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
