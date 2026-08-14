/**
 * Every contract with @empirica/core that could break on a version bump, in one
 * file. If an upgrade breaks the harness, it breaks here.
 *
 * Verified against @empirica/core@1.12.5 / @empirica/tajriba@1.7.3 on 2026-08-14.
 * See docs/PLATFORM-NOTES.md.
 */
import { AdminContext, TajribaConnection } from "@empirica/core/admin";
import { TajribaProvider } from "@empirica/core/player";

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

/** Range this harness has actually been verified against. */
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
  return new TajribaProvider(
    part.changes(),
    conn.tajriba.globalAttributes(),
    part.setAttributes.bind(part)
  );
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
