/**
 * Every contract with @empirica/core that could break on a version bump, in one
 * file. If an upgrade breaks the harness, it breaks here.
 *
 * Verified against @empirica/core@1.12.5 / @empirica/tajriba@1.7.3 on 2026-08-14.
 * See docs/PLATFORM-NOTES.md.
 */
import { AdminContext, TajribaConnection } from "@empirica/core/admin";
import { TajribaProvider } from "@empirica/core/player";
import { share, shareReplay, type Observable } from "rxjs";

/**
 * Session types derived THROUGH TajribaConnection rather than imported from
 * @empirica/tajriba directly.
 *
 * Importing them directly pulls a second copy of the package (ours vs the one
 * nested under @empirica/core), and TypeScript rejects the two as incompatible
 * because `Tajriba` has private fields. That is the same duplicate-class hazard
 * that would break `instanceof` at runtime — here it surfaces at compile time.
 * Deriving from core's own method signatures guarantees exactly one copy.
 */
type Participant = Awaited<ReturnType<TajribaConnection["sessionParticipant"]>>;
type Admin = Awaited<ReturnType<TajribaConnection["sessionAdmin"]>>;

/**
 * The one declaration of which `@empirica/core` this repository pins, builds
 * against, and measured every platform claim against.
 *
 * It used to be two: this constant, which nothing read, and a second literal in
 * `cli.ts` that the CLI printed. Same number, no relationship — the O14 shape
 * (`ISSUES.md`), and in the one file whose whole job is version-fragile
 * contracts. Now `cli.ts` prints this one.
 *
 * Guarded by `test/unit/upstream_pin.test.ts`, which also holds it against the
 * `@empirica/core@…` citations in the docs. Bumping the pin is supposed to be
 * loud: every dated measurement in `docs/PLATFORM-NOTES.md` and every upstream
 * finding in `ISSUES.md` was taken against this number and has to be re-taken.
 */
export const VERIFIED_CORE = "1.12.5";

/**
 * Positional-argument contract:
 *   AdminContext.init(url, tokenFile, serviceName, serviceRegistrationToken, ctx, kinds)
 * `":mem:"` as tokenFile keeps the session token out of the filesystem.
 */
export function initAdminContext<Ctx, Kinds extends Record<string, any>>(
  url: string,
  srtoken: string,
  kinds: Kinds,
  ctx: Ctx = {} as Ctx
): Promise<AdminContext<Ctx, Kinds>> {
  return AdminContext.init<Ctx, Kinds>(
    url,
    ":mem:",
    "empirica-networks-verify",
    srtoken,
    ctx,
    kinds
  );
}

/**
 * How a participant's data provider is constructed. Mirrors ParticipantContext
 * (player/context.ts) exactly:
 *
 *   new TajribaProvider(part.changes(), taj.globalAttributes(), part.setAttributes.bind(part))
 *
 * This is the single most drift-prone line in the harness — a change to the
 * TajribaProvider constructor lands here and nowhere else.
 */
export function makeProvider(
  conn: TajribaConnection,
  part: Participant
): TajribaProvider {
  return makeSharedProvider(conn, part).provider;
}

/**
/**
 * The provider, plus the very stream it consumes — ONE subscription for both.
 *
 * `part.changes()` calls `this.subscribe(ChangesDocument, …)` internally, so every
 * call opens **another GraphQL subscription**. The harness used to call it twice
 * per participant whenever a test watched the wire: once for the mode, again for
 * the observer. That doubled the traffic the server carried for that participant,
 * and doing it for every participant before the batch was the single largest
 * contributor to `ISSUES.md` O8 — Classic's O(n²) assignment burst competing with
 * subscription setup, and losing. Sharing one subscription took
 * `scope_visibility.test.ts` from 1-2/15 to **0/15**.
 *
 * This is the same property that makes the composed participant mode possible
 * (`src/player/mode.ts` — two consumers of a multicast stream each receive
 * everything), applied one layer lower.
 *
 * **`record` is not a detail; it restores a semantic the second subscription used
 * to provide by accident.** A FRESH `part.changes()` replays current state to its
 * new subscriber, so an observer that subscribed late still saw the attributes that
 * already existed. A late subscriber to a plain `share()` sees only what arrives
 * afterwards. `test/e2e/rand2011.test.ts` subscribes after assignment and depends
 * on that history — and its own non-vacuity guard caught the difference
 * immediately: *"no player attribute was visible in any wire, so the key-shaped
 * search is blind"*. With `record`, every frame since connect is replayed, which is
 * strictly more than the old behaviour gave and removes the ordering hazard
 * entirely: an observer may subscribe whenever it likes.
 *
 * Off by default because it retains every frame for the participant's lifetime.
 * `npm run bench` and `npm run soak` run hundreds of participants over 60 rounds and
 * `soak` measures RSS — a buffer they never read would be both a leak and a
 * corrupted measurement.
 *
 * `resetOnRefCountZero: false` so a test that unsubscribes cannot tear down the
 * mode's own stream underneath it.
 */
export function makeSharedProvider(
  conn: TajribaConnection,
  part: Participant,
  opts: { record?: boolean } = {}
): { provider: TajribaProvider; wire: Observable<unknown> } {
  const changes = part.changes();
  const wire = opts.record
    ? changes.pipe(shareReplay({ bufferSize: Infinity, refCount: false }))
    : changes.pipe(share({ resetOnRefCountZero: false }));
  const provider = new TajribaProvider(
    wire,
    conn.tajriba.globalAttributes(),
    part.setAttributes.bind(part)
  );
  return { provider, wire: wire as Observable<unknown> };
}

/** Register + open a participant session. Returns the authenticated participant. */
export async function openParticipantSession(
  conn: TajribaConnection,
  identifier: string
): Promise<Participant> {
  const [token, pident] = await conn.tajriba.registerParticipant(identifier);
  return conn.sessionParticipant(token, pident);
}

/** Register a service and open an admin session. */
export async function openAdminSession(
  conn: TajribaConnection,
  srtoken: string,
  serviceName = "empirica-networks-verify"
): Promise<Admin> {
  const token = await conn.tajriba.registerService(serviceName, srtoken);
  return conn.sessionAdmin(token);
}
