import chalk from "chalk";
import { LocalLedger } from "../transport/local";
import { estimateLocalCost, fetchPricing } from "../transport/local-pricing";
import { getApiKey } from "../config/env";
import type { Burn0Event } from "../types";

const BURN0_API_URL = "https://burn0-server-production.up.railway.app";

interface ReportData {
  total: { cost: number; calls: number };
  byService: { name: string; cost: number; calls: number }[];
  byDay: {
    date: string;
    cost: number;
    calls: number;
    topServices: { name: string; cost: number }[];
  }[];
  allServiceCalls: { name: string; calls: number }[];
  unpricedCount: number;
  pricingAvailable: boolean;
}

function getLocalDateStr(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(6)}`;
}

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")}`;
}

function makeBar(value: number, max: number, width: number): string {
  if (max === 0) return "░".repeat(width);
  const filled = Math.round((value / max) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function aggregateLocal(events: Burn0Event[], days: number): ReportData {
  const now = new Date();
  const cutoffDate = new Date(now);
  cutoffDate.setDate(cutoffDate.getDate() - (days - 1));
  const cutoffStr = getLocalDateStr(cutoffDate);

  const serviceCosts: Record<string, { cost: number; calls: number }> = {};
  const serviceCallCounts: Record<string, number> = {};
  const dayCosts: Record<
    string,
    { cost: number; calls: number; services: Record<string, number> }
  > = {};
  let totalCost = 0;
  let totalCalls = 0;
  let unpricedCount = 0;
  let loadingCount = 0;

  for (const event of events) {
    const eventDate = new Date(event.timestamp);
    const eventDateStr = getLocalDateStr(eventDate);
    if (eventDateStr < cutoffStr) continue;

    totalCalls++;
    serviceCallCounts[event.service] =
      (serviceCallCounts[event.service] ?? 0) + 1;
    const estimate = estimateLocalCost(event);

    if (estimate.type === "priced" && estimate.cost > 0) {
      totalCost += estimate.cost;
      if (!serviceCosts[event.service])
        serviceCosts[event.service] = { cost: 0, calls: 0 };
      serviceCosts[event.service].cost += estimate.cost;
      serviceCosts[event.service].calls++;
      if (!dayCosts[eventDateStr])
        dayCosts[eventDateStr] = { cost: 0, calls: 0, services: {} };
      dayCosts[eventDateStr].cost += estimate.cost;
      dayCosts[eventDateStr].calls++;
      dayCosts[eventDateStr].services[event.service] =
        (dayCosts[eventDateStr].services[event.service] ?? 0) + estimate.cost;
    } else if (estimate.type === "free") {
      // Count call but exclude from cost
    } else if (estimate.type === "loading") {
      loadingCount++;
    } else {
      unpricedCount++;
    }
  }

  const byService = Object.entries(serviceCosts)
    .map(([name, data]) => ({ name, cost: data.cost, calls: data.calls }))
    .sort((a, b) => b.cost - a.cost);

  const allServiceCalls = Object.entries(serviceCallCounts)
    .map(([name, calls]) => ({ name, calls }))
    .sort((a, b) => b.calls - a.calls);

  const byDay = Object.entries(dayCosts)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, data]) => {
      const topServices = Object.entries(data.services)
        .sort((a, b) => b[1] - a[1])
        .map(([name, cost]) => ({ name, cost }));
      return { date, cost: data.cost, calls: data.calls, topServices };
    });

  return {
    total: { cost: totalCost, calls: totalCalls },
    byService,
    byDay,
    allServiceCalls,
    unpricedCount,
    pricingAvailable: loadingCount < totalCalls || totalCalls === 0,
  };
}

function renderCallCountOnly(data: ReportData): void {
  const maxCalls =
    data.allServiceCalls.length > 0 ? data.allServiceCalls[0].calls : 0;
  const maxNameLen = Math.max(
    ...data.allServiceCalls.map((s) => s.name.length),
    8,
  );
  for (const svc of data.allServiceCalls) {
    const bar = makeBar(svc.calls, maxCalls, 20);
    console.log(
      `  ${svc.name.padEnd(maxNameLen)}  ${chalk.gray(`${String(svc.calls).padStart(5)} calls`)}  ${chalk.cyan(bar)}`,
    );
  }
  console.log();
}

function renderCostReport(
  data: ReportData,
  label: string,
  showDaily: boolean,
  isToday: boolean,
): void {
  console.log(
    `\n  ${chalk.hex("#FA5D19").bold("burn0 report")} ${chalk.gray(`── ${label}`)}\n`,
  );

  if (data.total.calls === 0) {
    const msg = isToday
      ? "No calls today."
      : `No cost data yet. Run your app with \`import '@burn0/burn0'\` to start tracking.`;
    console.log(chalk.dim(`  ${msg}\n`));
    return;
  }

  if (!data.pricingAvailable) {
    console.log(
      chalk.dim(
        `  ${data.total.calls} calls tracked (pricing data not available)\n`,
      ),
    );
    renderCallCountOnly(data);
    return;
  }

  if (data.total.cost === 0 && data.total.calls > 0) {
    console.log(
      chalk.dim(
        `  ${data.total.calls} calls tracked (no pricing data available)\n`,
      ),
    );
    renderCallCountOnly(data);
    return;
  }

  console.log(
    `  ${chalk.bold("Total:")} ${chalk.green(formatCost(data.total.cost))} ${chalk.gray(`(${data.total.calls} calls)`)}\n`,
  );

  const maxCost = data.byService.length > 0 ? data.byService[0].cost : 0;
  const maxNameLen = Math.max(...data.byService.map((s) => s.name.length), 8);

  for (const svc of data.byService) {
    const pct =
      data.total.cost > 0 ? Math.round((svc.cost / data.total.cost) * 100) : 0;
    const bar = makeBar(svc.cost, maxCost, 20);
    console.log(
      `  ${svc.name.padEnd(maxNameLen)}  ${chalk.green(formatCost(svc.cost).padStart(10))}   ${chalk.cyan(bar)}  ${chalk.gray(`${String(pct).padStart(3)}%`)}`,
    );
  }

  if (data.unpricedCount > 0) {
    console.log(chalk.dim(`\n  + ${data.unpricedCount} calls not priced`));
  }

  if (showDaily && data.byDay.length > 0) {
    console.log(
      `\n  ${chalk.gray("── daily ──────────────────────────────────────")}\n`,
    );
    const maxDayCost = Math.max(...data.byDay.map((d) => d.cost));
    for (const day of data.byDay) {
      const dateLabel = formatDateLabel(day.date);
      const bar = makeBar(day.cost, maxDayCost, 12);
      const top2 = day.topServices
        .slice(0, 2)
        .map((s) => `${s.name} ${formatCost(s.cost)}`)
        .join(" · ");
      const more =
        day.topServices.length > 2
          ? ` +${day.topServices.length - 2} more`
          : "";
      console.log(
        `  ${chalk.gray(dateLabel)}   ${chalk.green(formatCost(day.cost).padStart(10))}  ${chalk.cyan(bar)}  ${chalk.dim(top2 + more)}`,
      );
    }
  }

  // Projection
  if (data.total.cost > 0) {
    const daysInPeriod = showDaily ? 7 : 1;
    const dailyRate = data.total.cost / daysInPeriod;
    const monthly = dailyRate * 30;
    console.log(
      `\n  ${chalk.gray("── projection ─────────────────────────────")}`,
    );
    console.log(
      `  ${chalk.gray("~")}${chalk.green(formatCost(monthly))}${chalk.gray("/mo estimated")} ${chalk.dim(`(based on ${isToday ? "today" : "last 7 days"})`)}`,
    );
  }

  console.log();
}

async function fetchBackendReport(
  apiKey: string,
  days: number,
): Promise<ReportData | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await globalThis.fetch(
      `${BURN0_API_URL}/v1/report?days=${days}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      },
    );
    clearTimeout(timeout);
    if (!response.ok) return null;
    const data = (await response.json()) as any;
    return {
      total: data.total ?? { cost: 0, calls: 0 },
      byService: data.byService ?? [],
      byDay: data.byDay ?? [],
      allServiceCalls: (data.byService ?? []).map((s: any) => ({
        name: s.name,
        calls: s.calls,
      })),
      unpricedCount: 0,
      pricingAvailable: true,
    };
  } catch {
    return null;
  }
}

export async function runReport(
  options: { today?: boolean } = {},
): Promise<void> {
  const cwd = process.cwd();
  const days = options.today ? 1 : 7;
  const label = options.today ? "today" : "last 7 days";

  const apiKey = getApiKey();
  if (apiKey) {
    const backendData = await fetchBackendReport(apiKey, days);
    if (backendData) {
      renderCostReport(backendData, label, !options.today, !!options.today);
      return;
    }
  }

  await fetchPricing(BURN0_API_URL, globalThis.fetch);
  const ledger = new LocalLedger(cwd);
  const events = ledger.read();
  const data = aggregateLocal(events, days);
  renderCostReport(data, label, !options.today, !!options.today);
}
