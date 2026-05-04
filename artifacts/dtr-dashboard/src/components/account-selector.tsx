// AccountSelector — shows available TopStep accounts, lets Craig switch active account
import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Building2, Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

interface Account {
  id: string;
  name: string;
  balance?: number;
}

interface AccountSelectorProps {
  accounts: Account[];
  activeAccountId: string;
  isAuthenticated: boolean;
  onAccountChange: (accountId: string, balance?: number) => void;
}

const LS_KEY = "dtr_account_selector_expanded";

export function AccountSelector({ accounts, activeAccountId, isAuthenticated, onAccountChange }: AccountSelectorProps) {
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Default collapsed; persist in localStorage
  const [expanded, setExpanded] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_KEY) === "true"; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem(LS_KEY, String(expanded)); } catch { /* ignore */ }
  }, [expanded]);

  const handleSelect = async (accountId: string) => {
    if (!isAuthenticated || accountId === activeAccountId || switching !== null) return;
    setSwitching(accountId);
    setError(null);
    try {
      const res = await fetch("/api/accounts/select", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: accountId }),
      });
      const data = await res.json();
      if (data.success) {
        // Pass balance back so dashboard can update instantly (no 60s tick wait)
        const selectedAcc = accounts.find(a => a.id === accountId);
        onAccountChange(accountId, data.balance ?? selectedAcc?.balance);
        // Stay expanded so Craig can see the new active account highlighted
      } else {
        setError(data.error ?? "Failed to switch account");
      }
    } catch {
      setError("Network error");
    } finally {
      setSwitching(null);
    }
  };

  if (!accounts || accounts.length === 0) return null;

  const activeAccount = accounts.find(a => a.id === activeAccountId) ?? accounts[0];

  return (
    <Card className="bg-card border-border rounded-md">
      {/* ── Header — always visible, click anywhere to toggle ── */}
      <CardHeader
        className="pb-3 border-b border-border/50 flex flex-row items-center gap-2 cursor-pointer select-none"
        onClick={() => setExpanded(prev => !prev)}
      >
        <Building2 className="w-4 h-4 text-primary shrink-0" />
        <CardTitle className="text-sm font-mono tracking-tight uppercase text-muted-foreground flex-1">
          Trading Account
        </CardTitle>

        {/* Active account preview when collapsed */}
        {!expanded && activeAccount && (
          <span className="text-xs font-mono text-indigo-300 truncate max-w-[180px]">
            {activeAccount.name || activeAccount.id}
            {activeAccount.balance != null && (
              <span className="text-muted-foreground ml-2">${activeAccount.balance.toLocaleString()}</span>
            )}
          </span>
        )}

        {/* Expand / collapse chevron */}
        <button
          className="text-muted-foreground hover:text-foreground transition-colors ml-1 shrink-0"
          onClick={e => { e.stopPropagation(); setExpanded(prev => !prev); }}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </CardHeader>

      {/* ── Account list — visible only when expanded ── */}
      {expanded && (
        <CardContent className="pt-3 space-y-2">
          {accounts.map((acc) => {
            const isActive = acc.id === activeAccountId;
            const isSwitching = switching === acc.id;
            return (
              <button
                key={acc.id}
                disabled={!isAuthenticated || switching !== null}
                onClick={() => handleSelect(acc.id)}
                className={cn(
                  "w-full flex items-center justify-between px-3 py-2 rounded text-xs font-mono transition-colors border",
                  isActive
                    ? "bg-indigo-600/20 border-indigo-500/50 text-indigo-300"
                    : "bg-muted/20 border-border text-muted-foreground",
                  !isAuthenticated || switching !== null
                    ? "opacity-50 cursor-not-allowed"
                    : !isActive && "hover:bg-muted/40 hover:border-border/80 cursor-pointer"
                )}
              >
                <span className="font-bold truncate">{acc.name || acc.id}</span>
                <div className="flex items-center gap-2 shrink-0">
                  {acc.balance != null && (
                    <span className="text-muted-foreground">
                      ${acc.balance.toLocaleString()}
                    </span>
                  )}
                  {isActive && <Check className="w-3 h-3 text-indigo-400" />}
                  {isSwitching && (
                    <span className="text-[10px] text-muted-foreground animate-pulse">switching…</span>
                  )}
                </div>
              </button>
            );
          })}

          {error && <p className="text-xs text-destructive font-mono">{error}</p>}

          <p className="text-[10px] text-muted-foreground font-mono pt-1">
            All accounts share the same API key. Tradeable status depends on account type in TopstepX.
          </p>
        </CardContent>
      )}
    </Card>
  );
}
