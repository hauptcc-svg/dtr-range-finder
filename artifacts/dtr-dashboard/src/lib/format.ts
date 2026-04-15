export function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return "---";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    signDisplay: "always",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined) return "---";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "---";
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return "---";
  return new Date(dateString).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatSessionPhase(phase: string): string {
  if (!phase) return "Unknown";
  return phase
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
