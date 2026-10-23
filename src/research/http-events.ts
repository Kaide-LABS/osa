// Bridges the network layer's rate-limit notices (HttpDeps.onEvent) to OSA's event log. A back-off is never silent: each retry and each
// give-up becomes an `http_rate_limited` event naming the host, status, attempt and wait (Suite 5).

import type { EventSink } from "../osa/events.ts";
import type { HttpDeps } from "./net/http.ts";

/** `http` = the deps to hand to the clients; `flush` waits for the pending event writes (call before the stage returns). */
export function loggingHttp(base: HttpDeps | undefined, events: EventSink): { readonly http: HttpDeps; flush(): Promise<void> } {
  const pending: Promise<void>[] = [];
  const http: HttpDeps = {
    ...base,
    onEvent: (e) => {
      base?.onEvent?.(e);
      pending.push(events.emit("http_rate_limited", { host: e.host, status: e.status, attempt: e.attempt, maxAttempts: e.maxAttempts, waitMs: e.waitMs, action: e.action, reason: e.reason }));
    },
  };
  return { http, flush: async () => void (await Promise.all(pending)) };
}
