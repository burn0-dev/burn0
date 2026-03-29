import { getApiKey, detectMode, isTTY } from "./config/env";
import {
  canPatch,
  markPatched,
  resetGuard,
  checkImportOrder,
} from "./interceptor/guard";
import { patchFetch, unpatchFetch } from "./interceptor/fetch";
import { patchHttp, unpatchHttp } from "./interceptor/http";
import { createTracker } from "./track";
import { createRestorer } from "./restore";
import { createDispatcher } from "./transport/dispatcher";
import { BatchBuffer } from "./transport/batch";
import { LocalLedger } from "./transport/local";
import { shipEvents } from "./transport/api";
import { createTicker } from "./transport/logger";
import {
  fetchPricing,
  loadCachedPricing,
  estimateLocalCost,
} from "./transport/local-pricing";
import type { Burn0Event } from "./types";

const BURN0_API_URL = process.env.BURN0_API_URL ?? "https://burn0-server-production.up.railway.app";

let apiKey = getApiKey();
let mode = detectMode({ isTTY: isTTY(), apiKey });

const { track, startSpan, enrichEvent } = createTracker();

// Store original fetch before patching (for API shipper and pricing fetch)
const originalFetch = globalThis.fetch;

// Load cached pricing synchronously so ledger seed can estimate costs
loadCachedPricing();

// Then fetch fresh pricing in background (non-blocking, uses original fetch)
if (mode !== "test-disabled" && mode !== "prod-local") {
  fetchPricing(BURN0_API_URL, originalFetch).catch(() => {});
}

// Always create ledger — used to seed today's cost for the ticker
const ledger = new LocalLedger(process.cwd());

// Seed ticker with today's prior costs from ledger
function getTodayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let todayCost = 0;
let todayCalls = 0;
const perServiceCosts: Record<string, number> = {};

try {
  const todayStr = getTodayDateStr();
  const allEvents = ledger.read();
  for (const event of allEvents) {
    const eventDate = new Date(event.timestamp);
    const eventDateStr = `${eventDate.getFullYear()}-${String(eventDate.getMonth() + 1).padStart(2, "0")}-${String(eventDate.getDate()).padStart(2, "0")}`;
    if (eventDateStr === todayStr) {
      todayCalls++;
      const estimate = estimateLocalCost(event);
      if (estimate.type === "priced" && estimate.cost > 0) {
        todayCost += estimate.cost;
        perServiceCosts[event.service] =
          (perServiceCosts[event.service] ?? 0) + estimate.cost;
      }
    }
  }
} catch {}

const ticker = createTicker({ todayCost, todayCalls, perServiceCosts });

let batch: BatchBuffer | null = null;
let lateInitDone = false;

let failedEvents: Burn0Event[] = [];

function createBatch(key: string): BatchBuffer {
  return new BatchBuffer({
    sizeThreshold: 50,
    timeThresholdMs: 10000,
    maxSize: 500,
    onFlush: (events) => {
      // Include any previously failed events
      const toShip = failedEvents.length > 0 ? [...failedEvents, ...events] : events;
      failedEvents = [];

      shipEvents(toShip, key, BURN0_API_URL, originalFetch).then((ok) => {
        if (!ok) {
          // Keep failed events for next flush (cap at 500 to prevent memory leak)
          failedEvents = toShip.slice(-500);
        }
      }).catch(() => {
        failedEvents = toShip.slice(-500);
      });
    },
  });
}

if ((mode === "dev-cloud" || mode === "prod-cloud") && apiKey) {
  batch = createBatch(apiKey);
}

// Re-check for API key if it was missing at init
// This handles dotenv loading after burn0 import
const pendingEvents: Burn0Event[] = [];

function lateInit(event?: Burn0Event): void {
  if (batch) {
    // Already initialized — nothing to do
    return;
  }

  const lateKey = getApiKey();
  if (!lateKey) {
    // Key still not available — buffer the event for later
    if (event) pendingEvents.push(event);
    if (!lateInitDone) {
      lateInitDone = true;
      // Schedule one more check after the event loop settles (dotenv will have loaded by then)
      setTimeout(() => {
        lateInitDone = false; // allow re-check
        if (pendingEvents.length > 0) {
          const e = pendingEvents.shift()!;
          lateInit(e);
        } else {
          lateInit();
        }
      }, 0);
    }
    return;
  }

  lateInitDone = true;
  apiKey = lateKey;
  mode = detectMode({ isTTY: isTTY(), apiKey });
  batch = createBatch(lateKey);
  fetchPricing(BURN0_API_URL, originalFetch).catch(() => {});

  // Flush any events that were buffered while waiting for key
  for (const e of pendingEvents) {
    batch.add(e);
  }
  pendingEvents.length = 0;

  // Backfill: sync any ledger events that weren't shipped yet
  syncLedger(lateKey);
}

function syncLedger(key: string): void {
  try {
    const unsynced = ledger.readUnsynced();
    if (unsynced.length === 0) {
      ledger.markSynced();
      return;
    }

    // Ship unsynced ledger events in batches of 500
    const promises: Promise<boolean>[] = [];
    for (let i = 0; i < unsynced.length; i += 500) {
      const chunk = unsynced.slice(i, i + 500);
      promises.push(shipEvents(chunk, key, BURN0_API_URL, originalFetch));
    }

    Promise.all(promises).then((results) => {
      if (results.every(Boolean)) {
        ledger.markSynced();
      }
    }).catch(() => {});
  } catch {}
}

// Always write to ledger — powers the ticker, report, and local cost tracking
const shouldWriteLedger = mode !== "test-disabled" && mode !== "prod-local";

const dispatch = createDispatcher(mode, {
  logEvent: (e) => ticker.tick(e),
  writeLedger: shouldWriteLedger ? (e) => ledger.write(e) : undefined,
  addToBatch: (e) => {
    lateInit();
    batch?.add(e);
  },
});

const preloaded = checkImportOrder();
if (preloaded.length > 0) {
  console.warn(
    `[burn0] Warning: These SDKs were imported before burn0 and may not be tracked: ${preloaded.join(", ")}. Move \`import '@burn0/burn0'\` to the top of your entry file.`,
  );
}

if (canPatch() && mode !== "test-disabled") {
  const onEvent = (event: Burn0Event) => {
    const enriched = enrichEvent(event);
    dispatch(enriched);
  };
  patchFetch(onEvent);
  patchHttp(onEvent);
  markPatched();
}

// Cleanup on exit — flush batch and print summary
// Only use 'exit' event — fires when process is already terminating
// Never register SIGINT/SIGTERM handlers — that interferes with the app's lifecycle
let exitHandled = false;
process.on("exit", () => {
  if (exitHandled) return;
  exitHandled = true;
  if (batch) {
    batch.flush();
    batch.destroy();
  }
  ticker.printExitSummary();
});

const restore = createRestorer({ unpatchFetch, unpatchHttp, resetGuard });

export { track, startSpan, restore };
