/**
 * Basic Ghost Labs - Project Eclipse
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */


import { DiscordApiRequest } from "@platform/module-sdk";

interface QueueItem {
  moduleName: string;
  request: DiscordApiRequest;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

/**
 * Important: discord.js's REST manager already implements Discord's
 * documented per-route bucket limits, the global limit, and retry/backoff.
 * We do NOT reimplement that math here — duplicating it risks the two
 * layers disagreeing about how many requests are allowed.
 *
 * What this class DOES own: fairness between modules, request priority,
 * and preventing one badly-behaved module from starving the others by
 * flooding the shared discord.js REST client.
 */
export class DiscordApiManager {
  private queue: QueueItem[] = [];
  private processing = false;

  // Simple per-module concurrent-request cap. A misbehaving module can only
  // ever occupy this many "in flight" slots, regardless of queue priority.
  private readonly perModuleConcurrency = 3;
  private inFlight = new Map<string, number>();

  constructor(
    private readonly sendToDiscord: (req: DiscordApiRequest) => Promise<unknown>,
    private readonly logger: { warn: Function; error: Function }
  ) {}

  async request(moduleName: string, req: DiscordApiRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const item: QueueItem = { moduleName, request: req, resolve, reject };
      const priorityRank = { high: 0, normal: 1, low: 2 }[req.priority ?? "normal"];

      const insertAt = this.queue.findIndex(
        (q) => priorityRank < ({ high: 0, normal: 1, low: 2 }[q.request.priority ?? "normal"])
      );
      if (insertAt === -1) this.queue.push(item);
      else this.queue.splice(insertAt, 0, item);

      void this.drain();
    });
  }

  private async drain() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const nextIndex = this.queue.findIndex(
        (q) => (this.inFlight.get(q.moduleName) ?? 0) < this.perModuleConcurrency
      );
      if (nextIndex === -1) break; // everyone is at their concurrency cap; wait for a slot to free

      const [item] = this.queue.splice(nextIndex, 1);
      this.inFlight.set(item.moduleName, (this.inFlight.get(item.moduleName) ?? 0) + 1);

      this.sendToDiscord(item.request)
        .then(item.resolve)
        .catch((err) => {
          this.logger.error(`Discord request failed for module "${item.moduleName}"`, {
            route: item.request.route,
            error: (err as Error).message,
          });
          item.reject(err);
        })
        .finally(() => {
          this.inFlight.set(item.moduleName, (this.inFlight.get(item.moduleName) ?? 1) - 1);
          void this.drain();
        });
    }

    this.processing = false;
  }
}
