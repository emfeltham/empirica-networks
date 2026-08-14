/**
 * Integration-test harness built entirely on the PUBLIC @empirica/core API.
 *
 * The spike's harness reached into non-public internals (`ParticipantModeContext`,
 * `e2e_test_helpers`, `(admin as any).admin`). None of that is necessary:
 * `TajribaConnection`, `AdminContext`, and `TajribaProvider` are all published,
 * and a headless participant is ~15 lines on top of them.
 *
 * The server is the one exception: `withTajriba` IS public but is unusable from
 * the shipped ESM build (it pulls in `tmp`, whose `require("fs")` throws under
 * tsup's ESM shim). See ./server.ts for the full reasoning.
 *
 * That matters beyond tidiness — it is what lets this harness ship to consumers
 * as `npx empirica-networks verify`, so the privacy guarantee is something a user
 * can reproduce rather than take on trust.
 *
 * NOTE: must run under `tsx` (or bundled). `@empirica/core/admin` transitively
 * imports `cross-fetch/polyfill`, a bare directory import that plain Node ESM
 * rejects. See docs/PLATFORM-NOTES.md §3.
 */
import { TajribaConnection } from "@empirica/core/admin";
import { Classic, ClassicLoader, classicKinds } from "@empirica/core/admin/classic";
import type { TajribaProvider } from "@empirica/core/player";
import { initAdminContext, makeProvider, openAdminSession, openParticipantSession } from "./compat.js";
import { waitFor, waitForValue } from "../shared/wait.js";
import { withServer, type Server } from "./server.js";

// Re-exported so callers get everything from one place; the implementations
// live in shared/ so they are unit-testable without bundling.
export { TimeoutError, waitFor, waitForValue } from "../shared/wait.js";

// ---------------------------------------------------------------- participants

export interface Participant<M = unknown> {
  /** Participant namespace / identifier. Reconnect with the same one. */
  ns: string;
  /** Tajriba-assigned participant ID. */
  id: string;
  /** Whatever the mode function returned. */
  mode: M;
  provider: TajribaProvider;
  /**
   * Opens a NEW independent wire subscription and returns it. The leak test
   * asserts here, below the mode.
   *
   * Deliberately a function, not a stored stream: `TajribaParticipant.changes()`
   * calls `this.subscribe(ChangesDocument, ...)` internally, so every call opens
   * another GraphQL subscription. Calling it eagerly for every participant (as
   * this harness first did) doubles each one's wire traffic whether or not
   * anyone observes it.
   *
   * Caveat for anything built on this: the returned stream is a *sibling* of the
   * one the mode consumes, not the same object. It carries what the server sends
   * to this participant — which is exactly what a leak test needs — but it is not
   * evidence of what the mode itself resolved.
   */
  wireStream: () => any;
  stop: () => void;
}

/**
 * Connect a headless participant running an arbitrary mode function.
 * No browser, no ParticipantModeContext, no session storage shim.
 */
export async function connectParticipant<M>(
  server: Pick<Server, "url">,
  ns: string,
  modeFunc: (participantID: string, provider: TajribaProvider) => M
): Promise<Participant<M>> {
  const conn = new TajribaConnection(server.url);
  await waitForValue(conn.connected, true, `participant ${ns} socket connect`);
  await waitForValue(conn.connecting, false, `participant ${ns} connect settle`);

  const part = await openParticipantSession(conn, ns);
  const provider = makeProvider(conn, part);
  const mode = modeFunc(part.id, provider);

  return {
    ns,
    id: part.id,
    mode,
    provider,
    wireStream: () => part.changes(),
    // Two connections, not one. `sessionParticipant()` returns a
    // `TajribaParticipant extends Tajriba` with its OWN socket; stopping only
    // the TajribaConnection leaks the session. Measured: 3 sockets survived a
    // "full" teardown before this was fixed.
    stop: () => {
      try {
        part.stop?.();
      } catch {
        /* already gone */
      }
      conn.stop();
    },
  };
}

// ---------------------------------------------------------------- admin + callbacks

export interface AdminHandle {
  /** Raw TajribaAdmin: addScopes, addLinks, setAttributes, addScope, setAttribute. */
  taj: any;
  conn: TajribaConnection;
  stop: () => void;
}

export async function connectAdmin(server: Server): Promise<AdminHandle> {
  const conn = new TajribaConnection(server.url);
  await waitForValue(conn.connected, true, "admin socket connect");
  const taj = await openAdminSession(conn, server.srtoken);
  // Same two-connection shape as participants — see connectParticipant.
  return {
    taj,
    conn,
    stop: () => {
      try {
        taj.stop?.();
      } catch {
        /* already gone */
      }
      conn.stop();
    },
  };
}

/**
 * Start the callbacks process (Classic + our listeners) against a kind set.
 *
 * `kinds` is explicit rather than defaulted to classicKinds: registering the
 * custom kind here is exactly the edit a consumer must make in their own
 * server/src/index.js, so the harness should exercise the same path.
 */
export async function startCallbacks(
  server: Server,
  kinds: Record<string, any>,
  listeners: any
): Promise<{ ctx: any; stop: () => Promise<void> }> {
  const ctx = await initAdminContext(server.url, server.srtoken, kinds);

  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });

  ctx.register(ClassicLoader);
  ctx.register(Classic());
  if (listeners) ctx.register(listeners);
  ctx.register(function (_: any) {
    _.on("ready", () => resolveReady());
  });

  await ready;
  return {
    ctx,
    stop: async () => {
      await ctx.stop();
      // AdminContext holds its own TajribaConnection (readonly .tajriba) and an
      // AdminConnection. ctx.stop() does not demonstrably release them, so close
      // them explicitly — same two-connection shape as participants.
      try {
        (ctx as any).tajriba?.stop?.();
      } catch {
        /* already gone */
      }
      try {
        (ctx as any).adminConn?.stop?.();
      } catch {
        /* already gone */
      }
    },
  };
}

// ---------------------------------------------------------------- batch/game config

/**
 * Reimplemented from the non-public `completeBatchConfig` in e2e_test_helpers.
 * Trivial, and depending on a non-exported helper is not worth it.
 */
export function batchConfig(
  playerCount: number,
  games = 1,
  treatments: Record<string, unknown>[] = [{}]
) {
  return {
    kind: "complete",
    config: {
      treatments: treatments.map((t) => ({
        count: games,
        treatment: { factors: { playerCount, ...t } },
      })),
    },
  };
}

/** Reimplemented from the non-public `gameInitCallbacks`. */
export function gameInit(rounds = 1, stages = 1, durationMs = 3_600_000) {
  return function (_: any) {
    _.unique.on("game", "start", (_ctx: any, { game }: any) => {
      if (!game.get("start")) return;
      for (let r = 0; r < rounds; r++) {
        const round = game.addRound({});
        for (let s = 0; s < stages; s++) round.addStage({ duration: durationMs });
      }
    });
  };
}

export async function createBatch(admin: AdminHandle, config: unknown) {
  const batch = await admin.taj.addScope({
    kind: "batch",
    attributes: [{ key: "config", val: JSON.stringify(config), immutable: true }],
  });
  if (!batch) throw new Error("failed to create batch");
  return {
    id: batch.id,
    running: () =>
      admin.taj.setAttribute({
        key: "status",
        val: JSON.stringify("running"),
        nodeID: batch.id,
      }),
  };
}

// ---------------------------------------------------------------- top level

export interface Scenario<M> {
  server: Server;
  admin: AdminHandle;
  callbacks: { ctx: any; stop: () => Promise<void> };
  participants: Participant<M>[];
}

/**
 * Boot a server, start callbacks, connect n participants, run `fn`, tear down.
 *
 * Server logs default to `error`: at n*d attributes per tick, trace-level
 * logging dominates CPU and the measurement becomes a benchmark of Tajriba's
 * logger.
 */
export async function withScenario<M>(
  opts: {
    n: number;
    kinds: Record<string, any>;
    listeners: any;
    modeFunc: (participantID: string, provider: TajribaProvider) => M;
    logLevel?: string;
    waveSize?: number;
  },
  fn: (s: Scenario<M>) => Promise<void>
): Promise<void> {
  await withServer(
    async (server: Server) => {
      const admin = await connectAdmin(server);
      const callbacks = await startCallbacks(server, opts.kinds, opts.listeners);

      const participants: Participant<M>[] = [];
      const wave = opts.waveSize ?? 25;
      for (let i = 0; i < opts.n; i += wave) {
        const batch = [];
        for (let j = i; j < Math.min(i + wave, opts.n); j++) {
          batch.push(connectParticipant(server, uniqueNS(), opts.modeFunc));
        }
        participants.push(...(await Promise.all(batch)));
      }

      try {
        await fn({ server, admin, callbacks, participants });
      } finally {
        // Stop participants BEFORE the server, or their reconnect logic throws
        // unhandled ECONNREFUSED after the run completes.
        for (const p of participants) {
          try {
            p.stop();
          } catch {
            /* best effort */
          }
        }
        try {
          await callbacks.stop();
        } catch {
          /* best effort */
        }
        admin.stop();
      }
    },
    { logLevel: opts.logLevel ?? "error" }
  );
}

let nsCounter = 0;
export function uniqueNS(): string {
  return `en-${process.pid}-${nsCounter++}`;
}

export { classicKinds };
