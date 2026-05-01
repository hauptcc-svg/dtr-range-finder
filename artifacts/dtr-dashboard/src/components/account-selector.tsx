// AccountSelector — shows available TopStep accounts, lets Craig switch active account
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Building2, Check } from "lucide-react";

interface Account {
  id: string;
  name: string;
  balance?: number;
}

interface AccountSelectorProps {
  accounts: Account[];
  activeAccountId: string;
  isAuthenticated: boolean;
  onAccountChange: (accountId: string) => void;
}

export function AccountSelector({ accounts, activeAccountId, isAuthenticated, onAccountChange }: AccountSelectorProps) {
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSelect = async (accountId: string) => {
    if (!isAuthenticated || accountId === activeAccountId) return;
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
        onAccountChange(accountId);
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

  return (
    <Card className="bg-card border-border rounded-md">
      <CardHeader className="pb-3 border-b border-border/50 flex flex-row items-center gap-2">
        <Building2 className="w-4 h-4 text-primary" />
        <CardTitle className="text-sm font-mono tracking-tight uppercase text-muted-foreground">
          Trading Account
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-3 space-y-2">
        {accounts.map((acc) => (
          <button
            key={acc.id}
            disabled={!isAuthenticated || switching !== null}
            onClick={() => handleSelect(acc.id)}
            className={`w-full flex items-center justify-between px-3 py-2 rounded text-xs font-mono transition-colors
              ${acc.id === activeAccountId
                ? "bg-indigo-600/20 border border-indigo-500/50 text-indigo-300"
                : "bg-muted/20 border border-border text-muted-foreground hover:bg-muted/40"
              } ${!isAuthenticated ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
          >
            <span className="font-bold truncate">{acc.name || acc.id}</span>
            <div className="flex items-center gap-2 shrink-0">
              {acc.balance != null && (
                <span className="text-muted-foreground">
                  ${acc.balance.toLocaleString()}
                </span>
              )}
              {acc.id === activeAccountId && (
                <Check className="w-3 h-3 text-indigo-400" />
              )}
              {switching === acc.id && (
                <span className="text-[10px] text-muted-foreground">switching…</span>
              )}
            </div>
          </button>
        ))}
        {error && <p className="text-xs text-destructive font-mono">{error}</p>}
        <p className="text-[10px] text-muted-foreground font-mono pt-1">
          Open trades continue running when switching accounts.
        </p>
      </CardContent>
    </Card>
  );
}
