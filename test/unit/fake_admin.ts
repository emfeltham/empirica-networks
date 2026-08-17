/**
 * A server-free stand-in for the admin side, so the LIFECYCLE is testable.
 *
 * `withNetwork` takes two things it does not construct: a listeners collector
 * and an `EventContext`. Both are small interfaces, so supplying them here makes
 * game start, provisioning, channels materialising, the chat relay, participant
 * connect and game end drivable in about a millisecond — with no Tajriba, no
 * bundling and no orphan servers.
 *
 * **Why this tier and not e2e.** Some claims need several sequential games or a
 * specific arrival order, and the e2e tier is the worst place to buy either:
 * `ISSUES.md` O8 measured its headroom at one participant wide, and its cost is
 * paid by whichever *other* file happens to be waiting on an assignment. Two
 * defects were found with this file that would not have been affordable there
 * (`ISSUES.md` O5, O4).
 *
 * **What it cannot tell you, which is most of what matters elsewhere.** It
 * asserts OUR side of each contract; it assumes Tajriba dispatches, replays and
 * reuses scopes the way the comments say. Those claims rest on
 * `test/e2e/restart.test.ts` and `docs/PLATFORM-NOTES.md` §12. A fake that has
 * drifted from the platform passes happily, so anything the platform decides
 * belongs in e2e. See `docs/TESTING.md` §1.
 *
 * Not a `*.test.ts` file, so the runner does not execute it — same arrangement
 * as `test/mode/synthetic.ts`.
 */
import { TajribaEvent } from "@empirica/core/admin";
import { NBHD_KEYS, NBHD_KIND, OUTBOX_KEY, stateKey, type ChatMessage } from "../../src/shared/keys.js";

/** An attribute bag with the two methods the package calls on a scope. */
export class FakeScope {
  readonly attrs = new Map<string, unknown>();
  constructor(readonly id: string, initial: Record<string, unknown> = {}) {
    for (const [k, v] of Object.entries(initial)) this.attrs.set(k, v);
  }
  get(key: string): unknown {
    return this.attrs.get(key);
  }
  set(key: string, val: unknown): void {
    this.attrs.set(key, val);
  }
}

/**
 * A collector that DISPATCHES, unlike the recording-only one in
 * `state_of.test.ts`.
 *
 * Registrations are keyed `kind/key` exactly as Empirica dispatches them, and
 * `emit` awaits each handler in turn — `withNetwork`'s game-start listener is
 * async, and not awaiting it would test a provisioning call that had not
 * finished.
 */
export class FakeCollector {
  private readonly handlers = new Map<string, Array<(ctx: any, props: any) => unknown>>();
  on(...args: any[]): void {
    const cb = args.pop() as (ctx: any, props: any) => unknown;
    const key = args.map(String).join("/");
    const list = this.handlers.get(key) ?? [];
    list.push(cb);
    this.handlers.set(key, list);
  }
  async emit(key: string, props: any, ctx: any): Promise<void> {
    for (const cb of this.handlers.get(key) ?? []) await cb(ctx, props);
  }
}

/**
 * An EventContext that creates channel scopes the way Tajriba does.
 *
 * `addScopes` has to echo the attributes back inside the payload, because
 * `provisionChannels` maps results to owners by reading them rather than by
 * trusting input order — and it throws if the owner attribute is missing, which
 * is the discriminator the O14 registration check rests on. So a fake that got
 * this wrong would fail loudly rather than quietly diverge.
 */
export function makeCtx() {
  let n = 0;
  const created: FakeScope[] = [];
  return {
    created,
    scopeSub(): void {},
    async addScopes(inputs: any[]): Promise<any[]> {
      return inputs.map((input) => {
        const attrs: Record<string, unknown> = {};
        for (const a of input.attributes) attrs[a.key] = JSON.parse(a.val);
        const scope = new FakeScope(`nbhd-${++n}`, attrs);
        created.push(scope);
        return {
          id: scope.id,
          attributes: {
            edges: input.attributes.map((a: any) => ({ node: { key: a.key, val: a.val } })),
          },
        };
      });
    },
    async addLinks(): Promise<any[]> {
      return [];
    },
  };
}

export type FakeCtx = ReturnType<typeof makeCtx>;

export interface FakePlayer {
  id: string;
  /**
   * Deliberately optional, and the reason this is a field rather than derived.
   *
   * In Classic, `game.players` is `scopesByKindMatching("player", "gameID", id)`
   * — a query over an ATTRIBUTE — while `player.participantID` is a FIELD
   * assigned inside `_.on("player", …)`. Two different mechanisms, so a player
   * can be in `game.players` without the field being set (`ISSUES.md` O4).
   * Modelling them as one thing would make that state unrepresentable here and
   * the bug untestable.
   */
  participantID?: string | undefined;
  get(k: string): unknown;
  set(): void;
}

export interface FakeGame {
  id: string;
  players: FakePlayer[];
  batch: FakeScope;
  hasEnded: boolean;
  get(k: string): unknown;
  set(): void;
}

/** `"p1"` for a connected player; `{ id: "p1", participantID: undefined }` for one that is not. */
export type PlayerSpec = string | { id: string; participantID?: string | undefined };

export function makeGame(id: string, players: PlayerSpec[], batch: FakeScope): FakeGame {
  return {
    id,
    players: players.map((spec) => {
      const p = typeof spec === "string" ? { id: spec, participantID: `participant-${spec}` } : spec;
      return { id: p.id, participantID: p.participantID, get: () => undefined, set: () => {} };
    }),
    batch,
    hasEnded: false,
    get: (k: string) => (k === "start" ? true : undefined),
    set: () => {},
  };
}

/** Materialise channel scopes, i.e. deliver them through the kind subscription. */
export async function materialise(
  c: FakeCollector,
  ctx: FakeCtx,
  scopes: FakeScope[]
): Promise<void> {
  for (const scope of scopes) {
    await c.emit(`${NBHD_KIND}/${NBHD_KEYS.OWNER}`, { [NBHD_KIND]: scope }, ctx);
  }
}

/** Start a game, then materialise every channel it provisioned. */
export async function startGame(
  c: FakeCollector,
  ctx: FakeCtx,
  game: FakeGame
): Promise<FakeScope[]> {
  const before = ctx.created.length;
  await c.emit("game/start", { game }, ctx);
  const channels = ctx.created.slice(before);
  await materialise(c, ctx, channels);
  return channels;
}

export async function endGame(c: FakeCollector, ctx: FakeCtx, game: FakeGame): Promise<void> {
  game.hasEnded = true;
  await c.emit("game/status", { game }, ctx);
}

/**
 * A participant connects, and any channel their connection makes provisionable
 * is materialised.
 *
 * Returns the channels created by the repair path, which is empty on the normal
 * path — a connect for a participant who already has one costs an idempotent
 * no-op call.
 */
export async function connectParticipant(
  c: FakeCollector,
  ctx: FakeCtx,
  participantID: string
): Promise<FakeScope[]> {
  const before = ctx.created.length;
  await c.emit(String(TajribaEvent.ParticipantConnect), { participant: { id: participantID } }, ctx);
  const channels = ctx.created.slice(before);
  await materialise(c, ctx, channels);
  return channels;
}

/** Put a message in a participant's outbox and let the relay see it. */
export async function say(
  c: FakeCollector,
  ctx: FakeCtx,
  sender: FakeScope,
  seq: number,
  text: string
): Promise<void> {
  sender.set(stateKey(OUTBOX_KEY), { seq, text, at: 1 });
  await c.emit(`${NBHD_KIND}/${stateKey(OUTBOX_KEY)}`, { [NBHD_KIND]: sender }, ctx);
}

export const textsOn = (scope: FakeScope): string[] =>
  ((scope.get(NBHD_KEYS.CHAT) ?? []) as ChatMessage[]).map((m) => m.text);

/** The neighbour views last published to a channel, or undefined if never published. */
export const viewOn = (scope: FakeScope): unknown[] | undefined =>
  scope.get(NBHD_KEYS.NEIGHBORS) as unknown[] | undefined;
