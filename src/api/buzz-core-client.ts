import type { App } from "./app.ts";
import type { Delivery, TurnRequest, TurnResult } from "../types.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { RunStore } from "../runs/run-store.ts";
import { isTerminal } from "../runs/run-store.ts";
import type { TurnStream } from "../runs/turn-stream.ts";

export type BuzzTurnBody = Omit<TurnRequest, "surface">;

export interface BuzzCoreClient {
  submitTurn(body: BuzzTurnBody): Promise<TurnResult>;
  waitRun(runId: string): Promise<TurnResult | null>;
  ackRunDelivery(runId: string): Promise<void>;
  claimDeliveries(type: string, claimMs: number): Promise<Delivery[]>;
  ackDelivery(id: string): Promise<void>;
  onDeliveryEnqueued(listener: () => void): () => void;
}

const RUN_POLL_MS = 1_000;
/** Stall only when status/lease make no progress (matches Slack client). */
const RUN_STALL_MS = 300_000;

export function createBuzzCoreClient(deps: {
  app: App;
  deliveries: DeliveryStore;
  runs: RunStore;
  turnStream: TurnStream;
}): BuzzCoreClient {
  const terminalWaiters = new Map<string, Set<() => void>>();
  deps.runs.onTerminal((run) => {
    for (const wake of terminalWaiters.get(run.id) ?? []) wake();
  });

  return {
    submitTurn(body) {
      return deps.app.turn({ ...body, surface: "buzz" });
    },

    async waitRun(runId) {
      const waiters = terminalWaiters.get(runId) ?? new Set();
      terminalWaiters.set(runId, waiters);
      let lastProgressAt = Date.now();
      let lastMark = "";
      const wake = (): void => {
        lastProgressAt = Date.now();
      };
      waiters.add(wake);
      const unsub = deps.turnStream.subscribe(runId, {
        onFirstBlock: wake,
        onSurfacePosted: wake,
      });
      try {
        for (;;) {
          let run;
          try {
            run = await deps.runs.get(runId);
          } catch {
            run = undefined;
          }
          if (run) {
            if (isTerminal(run.status) && run.result) {
              return run.result as TurnResult;
            }
            if (isTerminal(run.status) && !run.result) {
              // Terminal without result yet — keep waiting briefly for result fill
              const mark = `terminal:${run.status}`;
              if (mark !== lastMark) {
                lastMark = mark;
                lastProgressAt = Date.now();
              }
            } else {
              const mark = `${run.status}:${run.attempts}:${run.leaseExpiresAt ?? ""}`;
              if (mark !== lastMark) {
                lastMark = mark;
                lastProgressAt = Date.now();
              }
            }
            if (deps.turnStream.surfacePosted(runId)) wake();
            const fb = deps.turnStream.firstBlock(runId);
            if (fb?.closed) wake();
          }
          if (Date.now() - lastProgressAt >= RUN_STALL_MS) {
            // Last chance: return terminal result if present
            try {
              const late = await deps.runs.get(runId);
              if (late && isTerminal(late.status) && late.result) {
                return late.result as TurnResult;
              }
            } catch {
              /* ignore */
            }
            throw Object.assign(new Error("run stalled"), { code: "run_stalled", runId });
          }
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, RUN_POLL_MS);
            const once = (): void => {
              clearTimeout(t);
              waiters.delete(once);
              resolve();
            };
            waiters.add(once);
          });
        }
      } finally {
        waiters.delete(wake);
        unsub();
        if (waiters.size === 0) terminalWaiters.delete(runId);
      }
    },

    async ackRunDelivery(runId) {
      await deps.app.ackDeliveryByKey(`run:${runId}`);
    },

    claimDeliveries(type, claimMs) {
      return deps.app.pendingDeliveries(type, claimMs);
    },

    async ackDelivery(id) {
      await deps.app.ackDelivery(id);
    },

    onDeliveryEnqueued(listener) {
      return deps.deliveries.onEnqueue(listener);
    },
  };
}
