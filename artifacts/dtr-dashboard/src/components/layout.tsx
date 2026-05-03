import { Link, useLocation } from "wouter";
import { Activity, LayoutDashboard, BarChart2, History } from "lucide-react";
import { cn } from "@/lib/utils";

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/analytics", label: "Analytics", icon: BarChart2 },
    { href: "/trades", label: "Trade History", icon: History },
  ];

  return (
    <div className="flex min-h-screen w-full bg-background text-foreground selection:bg-primary/30">
      {/* Sidebar */}
      <aside className="w-60 border-r border-border bg-sidebar flex flex-col hidden md:flex shrink-0">
        <div className="h-14 flex items-center px-4 border-b border-border gap-2.5">
          <Activity className="w-4 h-4 text-primary shrink-0" />
          <span className="font-semibold text-xs tracking-tight">DTR TRADING PLATFORM</span>
        </div>

        <nav className="flex-1 py-3 flex flex-col gap-0.5 px-2">
          {navItems.map((item) => {
            const isActive = location === item.href;
            return (
              <Link key={item.href} href={item.href}>
                <div
                  className={cn(
                    "flex items-center px-3 py-2.5 text-sm font-medium rounded-md cursor-pointer transition-all duration-150 relative",
                    isActive
                      ? "bg-sidebar-accent text-foreground border-l-2 border-l-primary pl-[10px]"
                      : "text-muted-foreground hover:bg-sidebar-accent/40 hover:text-foreground border-l-2 border-l-transparent pl-[10px]"
                  )}
                >
                  <item.icon className={cn("w-4 h-4 mr-3 shrink-0", isActive ? "text-primary" : "opacity-60")} />
                  <span className="text-sm font-medium">{item.label}</span>
                </div>
              </Link>
            );
          })}
        </nav>

        <div className="px-4 py-3 border-t border-border flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
          </span>
          <span className="text-[10px] font-medium text-green-500/70 uppercase tracking-wide">Live</span>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden">
        {/* Mobile header */}
        <header className="h-14 border-b border-border flex items-center px-4 md:hidden gap-2.5">
          <Activity className="w-4 h-4 text-primary" />
          <span className="font-semibold text-xs tracking-tight">DTR TRADING PLATFORM</span>
          <span className="ml-auto flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-60" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
            </span>
            <span className="text-[10px] font-medium text-green-500/70 uppercase tracking-wide">Live</span>
          </span>
        </header>

        <div className="flex-1 overflow-x-hidden overflow-y-auto p-4 sm:p-5">
          <div className="max-w-6xl mx-auto min-w-0">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
