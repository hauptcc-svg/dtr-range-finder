import { useQueryClient } from "@tanstack/react-query";
import { 
  useGetAgentStatus, 
  useGetInstruments, 
  useStartAgent, 
  useStopAgent,
  useGetDailySummary,
  getGetAgentStatusQueryKey,
  getGetInstrumentsQueryKey,
  getGetDailySummaryQueryKey,
} from "@workspace/api-client-react";
import { Play, Square, Activity, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { InstrumentCard } from "@/components/instrument-card";
import { PnlProgress } from "@/components/pnl-progress";
import { formatSessionPhase, formatCurrency } from "@/lib/format";

export function Dashboard() {
  const queryClient = useQueryClient();
  
  const { data: agentStatus, isLoading: isLoadingStatus } = useGetAgentStatus({
    query: { queryKey: getGetAgentStatusQueryKey(), refetchInterval: 3000 }
  });

  const { data: instruments, isLoading: isLoadingInstruments } = useGetInstruments({
    query: { queryKey: getGetInstrumentsQueryKey(), refetchInterval: 3000 }
  });

  const { data: dailySummary, isLoading: isLoadingSummary } = useGetDailySummary({
    query: { queryKey: getGetDailySummaryQueryKey(), refetchInterval: 5000 }
  });

  const startAgent = useStartAgent();
  const stopAgent = useStopAgent();

  const handleStart = () => {
    startAgent.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetAgentStatusQueryKey() });
      }
    });
  };

  const handleStop = () => {
    stopAgent.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetAgentStatusQueryKey() });
      }
    });
  };

  if (isLoadingStatus || isLoadingInstruments || isLoadingSummary) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-48 w-full" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (!agentStatus || !instruments) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>Failed to load dashboard data.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Control Card */}
        <Card className="lg:col-span-1 bg-card border-border rounded-md">
          <CardHeader className="pb-4 border-b border-border/50 flex flex-row items-center justify-between">
            <CardTitle className="text-lg font-mono tracking-tight flex items-center">
              <Activity className="w-5 h-5 mr-2 text-primary" />
              SYSTEM STATUS
            </CardTitle>
            <div className="flex items-center gap-2">
              <div className="flex items-center">
                <span className="relative flex h-3 w-3 mr-2">
                  {agentStatus.running && (
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                  )}
                  <span className={`relative inline-flex rounded-full h-3 w-3 ${agentStatus.running ? 'bg-success' : 'bg-muted-foreground'}`}></span>
                </span>
                <span className="text-xs font-mono uppercase font-bold text-muted-foreground">
                  {agentStatus.running ? "ACTIVE" : "STOPPED"}
                </span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="py-6 flex flex-col items-center justify-between gap-6">
            <div className="flex gap-4 w-full">
              <Button 
                variant="default" 
                size="lg"
                disabled={agentStatus.running || startAgent.isPending}
                onClick={handleStart}
                className="flex-1 font-mono bg-success hover:bg-success/90 text-success-foreground font-bold"
              >
                <Play className="w-4 h-4 mr-2" />
                START
              </Button>
              <Button 
                variant="destructive" 
                size="lg"
                disabled={!agentStatus.running || stopAgent.isPending}
                onClick={handleStop}
                className="flex-1 font-mono font-bold"
              >
                <Square className="w-4 h-4 mr-2" />
                HALT
              </Button>
            </div>
            
            <div className="w-full flex justify-between items-center border-t border-border pt-4">
              <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider block">Session Phase</span>
              <span className="font-mono font-bold text-primary bg-primary/10 px-3 py-1 rounded inline-block">
                {formatSessionPhase(agentStatus.sessionPhase)}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* PnL Progress Card */}
        <Card className="lg:col-span-2 bg-card border-border rounded-md">
          <CardHeader className="pb-4 border-b border-border/50">
            <CardTitle className="text-sm font-mono tracking-tight text-muted-foreground uppercase">
              Daily Target Progress
            </CardTitle>
          </CardHeader>
          <CardContent className="py-6 flex flex-col gap-6">
            <PnlProgress 
              currentPnl={agentStatus.dailyPnl}
              floor={-agentStatus.dailyLossLimit}
              target={agentStatus.dailyProfitTarget}
            />
            {dailySummary && (
              <div className="grid grid-cols-4 gap-4 pt-4 border-t border-border mt-2">
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase font-mono mb-1">Trades</div>
                  <div className="font-mono text-sm">{dailySummary.tradeCount}</div>
                </div>
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase font-mono mb-1">Win/Loss</div>
                  <div className="font-mono text-sm">
                    <span className="text-success">{dailySummary.winCount}</span> / <span className="text-destructive">{dailySummary.lossCount}</span>
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase font-mono mb-1">London PNL</div>
                  <div className={`font-mono text-sm ${dailySummary.londonPnl > 0 ? 'text-success' : dailySummary.londonPnl < 0 ? 'text-destructive' : ''}`}>
                    {formatCurrency(dailySummary.londonPnl)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase font-mono mb-1">NY PNL</div>
                  <div className={`font-mono text-sm ${dailySummary.nyPnl > 0 ? 'text-success' : dailySummary.nyPnl < 0 ? 'text-destructive' : ''}`}>
                    {formatCurrency(dailySummary.nyPnl)}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

      </div>

      {agentStatus.errorMessage && (
        <Alert variant="destructive" className="bg-destructive/10 border-destructive/50 text-destructive font-mono text-sm rounded-md">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>System Error</AlertTitle>
          <AlertDescription>{agentStatus.errorMessage}</AlertDescription>
        </Alert>
      )}

      {/* Instruments Grid */}
      <div>
        <h2 className="text-sm font-mono font-bold tracking-widest text-muted-foreground uppercase mb-4 border-b border-border/50 pb-2">
          Active Instruments
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {instruments.map(instrument => (
            <InstrumentCard key={instrument.symbol} instrument={instrument} />
          ))}
        </div>
      </div>
    </div>
  );
}
