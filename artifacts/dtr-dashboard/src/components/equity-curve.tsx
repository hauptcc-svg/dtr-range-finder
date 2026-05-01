import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ComposedChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

type RangeOption = "7d" | "30d" | "all";

interface EquityPoint {
  date: string;
  balance: number | null;
  daily_pnl: number;
  drawdown_pct: number;
  trade_count: number;
  win_rate: number;
}

interface EquityResponse {
  success: boolean;
  equity: EquityPoint[];
  range: string;
}

function formatBalance(val: number) {
  return `$${val.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const data = payload[0]?.payload as EquityPoint;
  return (
    <div className="bg-card border border-border rounded-md px-3 py-2 text-xs font-mono shadow-lg">
      <div className="text-muted-foreground mb-1">{label}</div>
      {data.balance != null && (
        <div className="text-foreground">Balance: {formatBalance(data.balance)}</div>
      )}
      <div className={cn("font-bold", data.daily_pnl >= 0 ? "text-success" : "text-destructive")}>
        Daily P&L: {data.daily_pnl >= 0 ? "+" : ""}${data.daily_pnl.toFixed(2)}
      </div>
      <div className="text-destructive/80">Drawdown: -{data.drawdown_pct.toFixed(1)}%</div>
      <div className="text-muted-foreground">{data.trade_count} trades · {(data.win_rate * 100).toFixed(0)}% WR</div>
    </div>
  );
}

export function EquityCurve() {
  const [range, setRange] = useState<RangeOption>("7d");

  const { data, isLoading } = useQuery<EquityResponse>({
    queryKey: ["equity-curve", range],
    queryFn: () =>
      fetch(`/api/performance/equity?range=${range}`).then((r) => r.json()),
    refetchInterval: 60_000,
    retry: false,
  });

  const points = data?.equity ?? [];
  const hasData = points.length > 0;

  // Compute summary stats
  const lastBalance = hasData ? points[points.length - 1].balance : null;
  const firstBalance = hasData ? points[0].balance : null;
  const totalGainPct = firstBalance && lastBalance
    ? ((lastBalance - firstBalance) / firstBalance * 100).toFixed(1)
    : null;
  const maxDrawdown = hasData
    ? Math.max(...points.map((p) => p.drawdown_pct)).toFixed(1)
    : null;

  const RANGES: { label: string; value: RangeOption }[] = [
    { label: "7D", value: "7d" },
    { label: "30D", value: "30d" },
    { label: "ALL", value: "all" },
  ];

  return (
    <Card className="bg-card border-border rounded-md">
      <CardHeader className="pb-3 border-b border-border/50">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-sm font-mono tracking-tight text-muted-foreground uppercase flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-success" />
            Equity Curve
          </CardTitle>
          <div className="flex gap-1">
            {RANGES.map((r) => (
              <button
                key={r.value}
                onClick={() => setRange(r.value)}
                className={cn(
                  "h-7 min-w-[44px] px-2 font-mono text-[10px] font-bold rounded border transition-colors",
                  range === r.value
                    ? "bg-primary/20 border-primary text-primary"
                    : "bg-card border-border text-muted-foreground hover:border-primary/50"
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* Summary stats */}
        {hasData && (
          <div className="flex gap-6 pt-2">
            {lastBalance != null && (
              <div>
                <div className="text-[10px] text-muted-foreground uppercase font-mono">Balance</div>
                <div className="font-mono font-bold text-sm">{formatBalance(lastBalance)}</div>
              </div>
            )}
            {totalGainPct != null && (
              <div>
                <div className="text-[10px] text-muted-foreground uppercase font-mono">Return</div>
                <div className={cn("font-mono font-bold text-sm", parseFloat(totalGainPct) >= 0 ? "text-success" : "text-destructive")}>
                  {parseFloat(totalGainPct) >= 0 ? "+" : ""}{totalGainPct}%
                </div>
              </div>
            )}
            {maxDrawdown != null && (
              <div>
                <div className="text-[10px] text-muted-foreground uppercase font-mono">Max DD</div>
                <div className="font-mono font-bold text-sm text-destructive/80">-{maxDrawdown}%</div>
              </div>
            )}
          </div>
        )}
      </CardHeader>

      <CardContent className="p-4">
        {isLoading && (
          <div className="h-[180px] flex items-center justify-center text-muted-foreground font-mono text-xs">
            Loading equity data…
          </div>
        )}
        {!isLoading && !hasData && (
          <div className="h-[180px] flex items-center justify-center text-muted-foreground font-mono text-xs">
            No equity data yet. Snapshots are saved at end of each trading session.
          </div>
        )}
        {!isLoading && hasData && (
          <ResponsiveContainer width="100%" height={180}>
            <ComposedChart data={points} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 10% 15%)" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fill: "hsl(220 10% 50%)", fontSize: 9, fontFamily: "monospace" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => v.slice(5)}  // show MM-DD
              />
              <YAxis
                yAxisId="balance"
                tick={{ fill: "hsl(220 10% 50%)", fontSize: 9, fontFamily: "monospace" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                width={40}
              />
              <Tooltip content={<CustomTooltip />} />
              {/* Balance line */}
              <Area
                yAxisId="balance"
                type="monotone"
                dataKey="balance"
                stroke="hsl(142 70% 45%)"
                strokeWidth={2}
                fill="hsla(142, 70%, 45%, 0.08)"
                dot={false}
                activeDot={{ r: 3, fill: "hsl(142 70% 45%)" }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
