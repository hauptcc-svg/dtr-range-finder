import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEffect } from "react";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";

// Pages
import { Dashboard } from "@/pages/dashboard";
import { Trades } from "@/pages/trades";
import { Positions } from "@/pages/positions";
import { Analytics } from "@/pages/analytics";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function BaseRedirect() {
  const [location, setLocation] = useLocation();
  useEffect(() => {
    if (location === "" || location === undefined) {
      setLocation("/");
    }
  }, [location, setLocation]);
  return null;
}

function Router() {
  return (
    <Layout>
      <BaseRedirect />
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/analytics" component={Analytics} />
        <Route path="/trades" component={Trades} />
        <Route path="/positions" component={Positions} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
