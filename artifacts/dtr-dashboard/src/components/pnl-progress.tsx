import React from "react";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

interface PnlProgressProps {
  currentPnl: number;
  floor: number;
  target: number;
}

export function PnlProgress({ currentPnl, floor, target }: PnlProgressProps) {
  // Normalize the range
  // floor is e.g. -200, target is +1400
  // total range = 1600
  const range = target - floor;
  
  // Calculate percentage positions
  const zeroPos = ((0 - floor) / range) * 100;
  
  // Clamp current value for display bar
  const clampedPnl = Math.min(Math.max(currentPnl, floor), target);
  const currentPos = ((clampedPnl - floor) / range) * 100;

  const isPositive = currentPnl >= 0;

  return (
    <div className="w-full">
      <div className="flex justify-between text-xs font-mono text-muted-foreground mb-2">
        <span className="text-destructive">{formatCurrency(floor)}</span>
        <span>$0.00</span>
        <span className="text-success">{formatCurrency(target)}</span>
      </div>
      
      <div className="relative h-4 bg-muted/50 rounded-sm overflow-hidden">
        {/* Zero Line */}
        <div 
          className="absolute top-0 bottom-0 w-0.5 bg-border z-10"
          style={{ left: `${zeroPos}%` }}
        />
        
        {/* Progress Fill */}
        {isPositive ? (
          <div 
            className="absolute top-0 bottom-0 bg-success/80 transition-all duration-500 ease-out"
            style={{ 
              left: `${zeroPos}%`, 
              width: `${currentPos - zeroPos}%` 
            }}
          />
        ) : (
          <div 
            className="absolute top-0 bottom-0 bg-destructive/80 transition-all duration-500 ease-out"
            style={{ 
              left: `${currentPos}%`, 
              width: `${zeroPos - currentPos}%` 
            }}
          />
        )}
      </div>
      
      <div className="mt-2 text-center">
        <span className={cn(
          "font-mono text-lg font-bold",
          currentPnl > 0 ? "text-success" : currentPnl < 0 ? "text-destructive" : "text-muted-foreground"
        )}>
          {formatCurrency(currentPnl)}
        </span>
        <span className="text-xs text-muted-foreground ml-2 font-mono uppercase tracking-wider">DAILY PNL</span>
      </div>
    </div>
  );
}
