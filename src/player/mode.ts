import { BehaviorSubject, Subject, type Observable } from "rxjs";
import { Attributes } from "@empirica/core/player";
import { Scope, Scopes, Steps, type TajribaProvider } from "@empirica/core/player";
import {
  EmpiricaClassic,
  Game,
  Player,
  PlayerGame,
  PlayerRound,
  PlayerStage,
  Round,
  Stage,
} from "@empirica/core/player/classic";
import { NBHD_KEYS, NBHD_KIND } from "../shared/keys.js";

/**
 * Participant mode: everything EmpiricaClassic provides, plus `nbhd`.
 *
 * COMPOSED, not reimplemented. EmpiricaClassic's body is ~150 lines of
 * subscription wiring — getMainObjects' ordering, players diffing, the
 * participant-presence filter — that upstream keeps editing and we do not own.
 * Composition works because TajribaProvider's streams are multicast rxjs
 * Subjects: two consumers each receive everything.
 */

class NetworkCtx {
  public game?: unknown;
  public stage?: unknown;
}

/** Client-side model of a participant's private channel. */
export class Nbhd extends Scope<NetworkCtx, any> {
  /** The projected neighbor views, as returned by the server's project(). */
  get neighbors(): unknown[] {
    const v = this.get(NBHD_KEYS.NEIGHBORS);
    return Array.isArray(v) ? v : [];
  }

  /**
   * Whether the server has published a view to this channel yet.
   *
   * `neighbors` cannot answer this: it returns `[]` both for "not published yet"
   * and for "genuinely has no neighbors", and those must not be conflated —
   * rendering an isolated node during startup is a silent data-validity bug, not
   * a cosmetic one. The hooks use this to return `undefined` until a real view
   * has arrived.
   */
  get published(): boolean {
    return this.get(NBHD_KEYS.NEIGHBORS) !== undefined;
  }

  get ownerParticipantID(): string | undefined {
    return this.get(NBHD_KEYS.OWNER) as string | undefined;
  }

  /** The viewer's own player id — the same id space neighbor views are in. */
  get playerID(): string | undefined {
    return this.get(NBHD_KEYS.PLAYER_ID) as string | undefined;
  }

  get seq(): number | undefined {
    return this.get(NBHD_KEYS.SEQ) as number | undefined;
  }
}

/**
 * The classic kind map, rebuilt.
 *
 * `kinds` is not exported from @empirica/core/player/classic, but all seven
 * Scope classes are, so this is an eight-line reconstruction rather than a
 * reason to vendor anything. Registering the full set means our scope tree emits
 * no unknown-kind warnings.
 */
const networkClientKinds = {
  game: Game,
  player: Player,
  playerGame: PlayerGame,
  playerRound: PlayerRound,
  playerStage: PlayerStage,
  round: Round,
  stage: Stage,
  [NBHD_KIND]: Nbhd,
};

export class DonesWiringError extends Error {
  constructor() {
    super(
      "empirica-networks: the neighborhood scope exists but its attributes are " +
        "unreadable. This is the `dones` wiring failure: Attributes and Scopes " +
        "only resolve values when their dones subjects are fed the set of updated " +
        "node ids. It fails silently — every .get() simply returns undefined."
    );
    this.name = "DonesWiringError";
  }
}

export interface NetworkContext {
  nbhd: BehaviorSubject<Nbhd | undefined>;
}

export type EmpiricaNetworkContext = ReturnType<typeof EmpiricaClassic> & NetworkContext;

function networkContext(
  participantID: string,
  provider: TajribaProvider
): NetworkContext {
  const attributesDones = new Subject<string[]>();
  const scopesDones = new Subject<string[]>();

  const attributes = new Attributes(
    provider.attributes,
    attributesDones,
    provider.setAttributes
  );
  const steps = new Steps(provider.steps, provider.dones as unknown as Observable<void>);
  const scopes = new Scopes(
    provider.scopes,
    scopesDones,
    new NetworkCtx(),
    networkClientKinds as any,
    attributes,
    steps
  );

  const nbhd = new BehaviorSubject<Nbhd | undefined>(undefined);

  // Mirrors EmpiricaClassic (classic.ts:180-190 and 264-267). Without it every
  // Scope materialises correctly and every .get() returns undefined, with no
  // error — the single most confusing failure in this codebase.
  const scopesUpdated = new Set<string>();
  provider.attributes.subscribe({
    next: (attr: any) => {
      const nodeID = attr?.attribute?.node?.id || attr?.attribute?.nodeID;
      if (nodeID) scopesUpdated.add(nodeID);
    },
  });

  let sawUpdateForOurScope = false;

  provider.dones.subscribe({
    next: () => {
      // FLUSH FIRST, then read.
      //
      // Selection depends on the owner attribute, and attributes are only
      // resolved by this flush. Selecting beforehand meant owner was still
      // undefined, so with two channels present (a stale one plus ours) neither
      // the owner match nor the single-channel fallback applied and the mode
      // silently kept serving the stale channel. Invisible in e2e, where a
      // participant only ever sees one channel.
      const updatedIDs = [...scopesUpdated];
      scopesDones.next(updatedIDs);
      attributesDones.next(updatedIDs);
      scopesUpdated.clear();

      const all = [...scopes.byKind(NBHD_KIND).values()] as Nbhd[];

      // Select by OWNER, not first-wins. The spike took index 0 of whatever
      // arrived, which breaks the moment a stale channel survives a rewire or a
      // reconnect — silently handing the participant someone else's view.
      const mine =
        all.find((s) => s.ownerParticipantID === participantID) ??
        (all.length === 1 ? all[0] : undefined);

      if (mine && updatedIDs.includes(mine.id)) sawUpdateForOurScope = true;
      if (mine) nbhd.next(mine);

      // Self-check, AFTER flushing: if updates arrived for our scope but nothing
      // on it is readable, the wiring above is wrong. Fail loudly rather than
      // serve empty views.
      //
      // The probe is `ownerParticipantID`, not `_seq`: owner is immutable and
      // written at channel creation, so it is present from the moment the scope
      // exists. `_seq` only appears at the first publish, which is strictly
      // later — probing it reported a wiring failure on every healthy run.
      if (mine && sawUpdateForOurScope && mine.ownerParticipantID === undefined) {
        throw new DonesWiringError();
      }
    },
  });

  return { nbhd };
}

/**
 * Pass to `<EmpiricaParticipant modeFunc={EmpiricaNetwork}>`.
 *
 * The returned object is a superset of EmpiricaClassicContext, so every existing
 * classic hook (usePlayer, useGame, useStage, ...) keeps working.
 */
export function EmpiricaNetwork(
  participantID: string,
  provider: TajribaProvider
): EmpiricaNetworkContext {
  const classic = EmpiricaClassic(participantID, provider);
  const net = networkContext(participantID, provider);

  // A removal upstream would silently strip a key from the merged object.
  for (const key of ["game", "player", "players", "round", "stage", "globals"]) {
    if (!(key in classic)) {
      throw new Error(
        `empirica-networks: EmpiricaClassic no longer returns "${key}". ` +
          `The composed mode is out of date with this version of @empirica/core.`
      );
    }
  }

  return { ...classic, ...net };
}
