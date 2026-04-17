import { Link, useLocation } from "wouter";
import { Activity, LayoutDashboard, List, History } from "lucide-react";
import { cn } from "@/lib/utils";

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/positions", label: "Positions", icon: List },
    { href: "/trades", label: "Trade History", icon: History },
  ];

  return (
    <div className="flex min-h-screen w-full bg-background text-foreground selection:bg-primary/30">
      {/* Sidebar */}
      <aside className="w-64 border-r border-border bg-sidebar flex flex-col hidden md:flex shrink-0">
        <div className="h-14 flex items-center px-4 border-b border-border">
          <Activity className="w-5 h-5 text-primary mr-2" />
          <span className="font-bold tracking-tight text-sm">DECLANCAPITAL FX</span>
        </div>
        
        <nav className="flex-1 py-4 flex flex-col gap-1 px-2">
          {navItems.map((item) => {
            const isActive = location === item.href;
            return (
              <Link key={item.href} href={item.href}>
                <div
                  className={cn(
                    "flex items-center px-3 py-2 text-sm font-medium rounded-md cursor-pointer transition-colors",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground"
                  )}
                >
                  <item.icon className="w-4 h-4 mr-3 opacity-70" />
                  {item.label}
                </div>
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden">
        <header className="h-14 border-b border-border flex items-center px-6 md:hidden">
          <Activity className="w-5 h-5 text-primary mr-2" />
          <span className="font-bold tracking-tight text-sm">DECLANCAPITAL FX</span>
        </header>
        <div className="flex-1 overflow-auto p-6">
          <div className="max-w-6xl mx-auto">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
