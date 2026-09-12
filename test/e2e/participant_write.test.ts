/**
 * R1: can a participant write its own state somewhere that is NOT broadcast?
 *
 * Why this is scope-defining. Empirica's Classic links the cross product of
 * every participant to every player node, so `player.set("choice", x)` is
 * already visible to everyone. If that is the only way a participant can write,
 * then neighbour-limited visibility is violated *at the source* and projecting
 * on the server buys nothing: a participant could read non-neighbours' raw
 * choices straight off the wire.
 *
 * The module's premise is that a participant writes to its own `nbhd` scope —
 * which it is linked to and nobody else is — and the server reads from there and
 * projects. The spike only ever tested server -> client delivery. This tests the
 * other direction.
 *
 * Outcomes:
 *   PASS  -> the module can claim "your state is visible only to your neighbours"
 *   FAIL  -> the claim must be restated as "your neighbours' PROJECTED VIEW is
 *            private; raw player attributes remain public", which is a much
 *            weaker product.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { classicKinds } from "@empirica/core/admin/classic";
import { EmpiricaClassic } from "@empirica/core/player/classic";
import { Scope } from "@empirica/core/player";
import {
  batchConfig,
  createBatch,
  gameInit,
  waitFor,
  withScenario,
  type Participant,
} from "../../src/harness/harness.js";
import { NBHD_KIND } from "../../src/shared/keys.js";

const N = 3;

/** Minimal admin-side model for the custom kind, so it can be registered. */
class Nbhd extends Scope<any, any> {}

/** Collects every raw payload a participant receives, as text, for substring scanning. */
function recordWire(p: Participant<unknown>): string[] {
  const seen: string[] = [];
  p.wireStream().subscribe({
    next: (msg: unknown) => {
      try {
        seen.push(JSON.stringify(msg));
      } catch {
        /* unserialisable frame, ignore */
      }
    },
  });
  return seen;
}

test("R1: a participant can write to its own nbhd scope, and it does not broadcast", async () => {
  // playerID -> nbhd scope ID, populated by the server listener below.
  const channels = new Map<string, string>();
  let provisioned = false;

  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);

    _.on("game", "tick", async (ctx: any, { game }: any) => {
      if (game.get("tick") !== "provision" || provisioned) return;
      for (const player of game.players) {
        const [scope] = await ctx.addScopes([
          {
            kind: NBHD_KIND,
            attributes: [
              { key: "ownerParticipantID", val: JSON.stringify(player.participantID), immutable: true },
            ],
          },
        ]);
        const scopeID = scope?.id ?? (scope as any)?.scope?.id;
        assert.ok(scopeID, "addScopes returned a scope id");
        await ctx.addLinks([
          { link: true, participantIDs: [player.participantID], nodeIDs: [scopeID] },
        ]);
        channels.set(player.id, scopeID);
      }
      provisioned = true;
    });
  };

  await withScenario(
    {
      n: N,
      kinds: { ...classicKinds, [NBHD_KIND]: Nbhd },
      listeners,
      modeFunc: EmpiricaClassic as any,
    },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(N, 1));
      await batch.running();

      await waitFor(
        () => participants.every((p: any) => p.mode.player.getValue()?.get("gameID")),
        { label: "all participants assigned a gameID" }
      );
      for (const p of participants as any[]) p.mode.player.getValue().set("introDone", true);
      await waitFor(
        () => participants.every((p: any) => Boolean(p.mode.game.getValue())),
        { label: "game visible to all" }
      );

      const gameID = (participants[0] as any).mode.player.getValue().get("gameID") as string;
      await admin.taj.setAttribute({
        key: "tick",
        val: JSON.stringify("provision"),
        nodeID: gameID,
      });
      await waitFor(() => provisioned && channels.size === N, {
        label: `${N} nbhd channels provisioned and linked`,
      });

      // Map each participant to its own channel via the player scope it holds.
      const chanFor = participants.map((p: any) => {
        const playerID = p.mode.player.getValue().id as string;
        const id = channels.get(playerID);
        assert.ok(id, "participant has a provisioned channel");
        return id!;
      });

      // Start recording every participant's wire before any writes happen.
      const wires = participants.map(recordWire);
      await new Promise((r) => setTimeout(r, 250));

      const SECRET_NBHD = "SEKRIT-nbhd-a1b2c3d4";
      const SECRET_PLAYER = "SEKRIT-player-e5f6g7h8";

      // (1) Participant 0 writes to ITS OWN nbhd channel.
      let selfWriteError: unknown;
      try {
        await participants[0]!.provider.setAttributes([
          { key: "selfState", nodeID: chanFor[0]!, val: JSON.stringify(SECRET_NBHD) },
        ]);
      } catch (e) {
        selfWriteError = e;
      }

      // (2) Control: participant 0 writes the same shape to its PLAYER scope,
      //     which Classic cross-links to everyone. This must leak, otherwise the
      //     detector below proves nothing.
      (participants[0] as any).mode.player.getValue().set("controlState", SECRET_PLAYER);

      await new Promise((r) => setTimeout(r, 1500));

      const others = [1, 2];
      const nbhdLeaks = others.filter((i) => wires[i]!.some((m) => m.includes(SECRET_NBHD)));
      const controlLeaks = others.filter((i) => wires[i]!.some((m) => m.includes(SECRET_PLAYER)));
      const ownerSawOwn = wires[0]!.some((m) => m.includes(SECRET_NBHD));

      console.log("\n=== R1: participant write path ===");
      console.log(`  write to own nbhd scope rejected : ${selfWriteError ? `YES — ${(selfWriteError as Error).message}` : "no (write accepted)"}`);
      console.log(`  owner saw its own nbhd write     : ${ownerSawOwn}`);
      console.log(`  nbhd write leaked to others      : ${nbhdLeaks.length}/${others.length}`);
      console.log(`  CONTROL player write leaked      : ${controlLeaks.length}/${others.length} (expected ${others.length})`);

      // The control must leak, or a clean nbhd result is meaningless.
      assert.equal(
        controlLeaks.length,
        others.length,
        "control: a player-scope write must reach every other participant, " +
          "otherwise this test cannot detect a leak at all"
      );

      assert.equal(selfWriteError, undefined, "participant may write to its own nbhd scope");
      assert.equal(nbhdLeaks.length, 0, "an nbhd write must not reach any other participant");

      // --- `admin.taj.attributes()`, exercised here rather than in a file of
      //     its own (`ISSUES.md` O7) -------------------------------------------
      //
      // Noted at M1 and never called since, which is how an API ends up listed
      // as available and turns out not to be. This scenario already holds a
      // channel scope carrying a participant-written attribute, so the marginal
      // cost is one query — and a new e2e file is the most expensive thing in
      // this repo to add (`ISSUES.md` O8).
      //
      // The result matters beyond coverage. `ISSUES.md` O11's design rests on
      // "an Empirica Scope exposes only get(key), with NO attribute
      // enumeration", which is why `watch`/`read` must be declared and why
      // `stateOf()` needs a key list to check against. That constraint is real
      // but it belongs to the SCOPE MODEL, not to the platform: the admin's raw
      // Tajriba session can enumerate. Worth knowing exactly, and worth not
      // over-reading — see the note below the assertions.
      const probe = async (label: string, input: unknown) => {
        try {
          const r = await admin.taj.attributes(input as any);
          const keys = (r?.edges ?? []).map((e: any) => e?.node?.key);
          console.log(`  ${label.padEnd(32)} : ${r?.totalCount} attrs — ${keys.join(", ")}`);
          return r;
        } catch (e) {
          console.log(`  ${label.padEnd(32)} : ERROR — ${(e as Error).message}`);
          return undefined;
        }
      };

      console.log("\n=== O7: admin.taj.attributes() ===");
      const onChannel = await probe("channel scope, first:100", {
        scopeID: chanFor[0]!,
        first: 100,
      });
      const onChannelBare = await probe("channel scope, no pagination", {
        scopeID: chanFor[0]!,
      });
      const onGame = await probe("game scope, first:100", { scopeID: gameID, first: 100 });
      const onNonsense = await probe("unknown scope id", { scopeID: "no-such-scope", first: 10 });

      // Deliberately NOT asserted as working. Measured 2026-08-16 against
      // @empirica/core@1.12.5: every shape above returns `[GraphQL] internal
      // system error`, including the one for a scope that certainly exists and
      // certainly has attributes — the assertions two lines up have just proved
      // the participant's write landed on it.
      //
      // So this is a characterisation, in the same spirit as R1b below, and the
      // assertion is on the SHAPE of the answer rather than on success: whatever
      // else changes, "the admin can enumerate a scope's attributes" must not
      // silently start being believed on no evidence. If upstream fixes it, the
      // first assertion fails and this becomes a working-API test.
      //
      // This is also where the news would ARRIVE, which is why the message below
      // says more than "rewrite this test" (`ISSUES.md` O7b). The e2e tier is run
      // weekly against @empirica/core@latest by .github/workflows/drift.yml, so a
      // fix upstream turns this line red without anyone going looking — but a red
      // line that only asks for a test rewrite would get one, and the larger
      // consequence would go unnoticed.
      assert.equal(
        onChannel,
        undefined,
        "attributes() still errors — if this now returns data, upstream fixed it. " +
          "Close ISSUES.md U9 and rewrite this test to assert the contents, and then " +
          "REOPEN the question it settled: ISSUES.md O11's design (declared watch/read " +
          "keys, stateOf() checking against a list) rests on there being no attribute " +
          "enumeration at ANY layer, and this query working is the counter-example. " +
          "The declaration requirement may still be right — it is synchronous and " +
          "in-process, which this never will be — but it would be chosen rather than forced."
      );
      assert.equal(onChannelBare, undefined, "…with or without pagination arguments");
      assert.equal(onGame, undefined, "…and on a stock Classic scope, so it is not our kind");
      assert.equal(onNonsense, undefined, "…and an unknown id is indistinguishable from a real one");

      // What this does NOT license, stated because the temptation is obvious:
      // it cannot replace the `watch`/`read` declaration. It lives on the raw
      // admin session rather than on a Scope, it is asynchronous, and it is a
      // network round trip per scope — so it cannot serve `inspect()`, which is
      // synchronous plain data built inside a listener, nor `stateOf()`, whose
      // value is throwing on an undeclared key rather than discovering one. It
      // is an OPERATOR and TEST tool: "what is actually on this scope", asked
      // from outside the runloop.
    }
  );
});

/**
 * R1b: what stops a participant writing into someone else's channel?
 *
 * Finding (2026-08-14): NOTHING, by default. Tajriba does not gate writes by
 * link membership — a participant that knows a node ID can set attributes on it,
 * and the owner receives them. Knowing the ID is the only barrier, and
 * security-by-unknown-identifier is not a guarantee.
 *
 * Tajriba's own docs point at the mitigation: `protected` means "the Attribute
 * will not be updatable by other Participants" — which implies unprotected
 * attributes are. This test pins down whether that actually holds, because it
 * decides whether the module writes every projected attribute `protected` (and
 * whether the server may ever trust a participant-written value).
 */
test("R1b: Empirica has no write ACL — characterising what a participant can write", async () => {
  const channels = new Map<string, string>();
  let provisioned = false;

  const listeners = (_: any) => {
    gameInit(1, 1, 3_600_000)(_);
    _.on("game", "tick", async (ctx: any, { game }: any) => {
      if (game.get("tick") !== "provision" || provisioned) return;
      for (const player of game.players) {
        const [scope] = await ctx.addScopes([
          {
            kind: NBHD_KIND,
            attributes: [
              { key: "ownerParticipantID", val: JSON.stringify(player.participantID), immutable: true },
              // Pre-created by the server as protected: the arm under test.
              { key: "guarded", val: JSON.stringify("server-owned"), protected: true },
              // Pre-created unprotected, as a control.
              { key: "unguarded", val: JSON.stringify("server-owned") },
            ],
          },
        ]);
        const scopeID = scope?.id ?? (scope as any)?.scope?.id;
        await ctx.addLinks([{ link: true, participantIDs: [player.participantID], nodeIDs: [scopeID] }]);
        channels.set(player.id, scopeID);
      }
      provisioned = true;
    });
  };

  await withScenario(
    { n: 2, kinds: { ...classicKinds, [NBHD_KIND]: Nbhd }, listeners, modeFunc: EmpiricaClassic as any },
    async ({ admin, participants }) => {
      const batch = await createBatch(admin, batchConfig(2, 1));
      await batch.running();
      await waitFor(() => participants.every((p: any) => p.mode.player.getValue()?.get("gameID")), { label: "gameID" });
      for (const p of participants as any[]) p.mode.player.getValue().set("introDone", true);
      await waitFor(() => participants.every((p: any) => Boolean(p.mode.game.getValue())), { label: "game" });

      const gameID = (participants[0] as any).mode.player.getValue().get("gameID") as string;
      await admin.taj.setAttribute({ key: "tick", val: JSON.stringify("provision"), nodeID: gameID });
      await waitFor(() => provisioned && channels.size === 2, { label: "channels provisioned" });

      const victimPlayerID = (participants[1] as any).mode.player.getValue().id as string;
      const victimChannel = channels.get(victimPlayerID)!;

      // Record the victim's wire BEFORE any injection attempt.
      const victimWire = recordWire(participants[1]!);
      await new Promise((r) => setTimeout(r, 250));

      const attempt = async (key: string, value: string) => {
        try {
          await participants[0]!.provider.setAttributes([
            { key, nodeID: victimChannel, val: JSON.stringify(value) },
          ]);
          return undefined;
        } catch (e) {
          return e as Error;
        }
      };

      const NEW_KEY = "SEKRIT-newkey-11112222";
      const OVER_UNGUARDED = "SEKRIT-unguarded-33334444";
      const OVER_GUARDED = "SEKRIT-guarded-55556666";

      const errNew = await attempt("injectedNewKey", NEW_KEY);
      const errUnguarded = await attempt("unguarded", OVER_UNGUARDED);
      const errGuarded = await attempt("guarded", OVER_GUARDED);

      // The genuinely exploitable arm: every participant already knows every
      // other participant's PLAYER scope id, because Classic cross-links them.
      // No id has to leak for this one.
      const victimPlayerScopeID = (participants[1] as any).mode.player.getValue().id as string;
      const OVER_PLAYER = "SEKRIT-otherplayer-77778888";
      let errPlayer: Error | undefined;
      try {
        await participants[0]!.provider.setAttributes([
          { key: "injectedIntoPlayer", nodeID: victimPlayerScopeID, val: JSON.stringify(OVER_PLAYER) },
        ]);
      } catch (e) {
        errPlayer = e as Error;
      }

      await new Promise((r) => setTimeout(r, 1500));
      const reached = (needle: string) => victimWire.some((m) => m.includes(needle));

      console.log("\n=== R1b: cross-participant write ===");
      console.log(`  new key on another's channel   : ${errNew ? "REJECTED" : "accepted"}, reached victim=${reached(NEW_KEY)}`);
      console.log(`  overwrite unprotected attribute: ${errUnguarded ? "REJECTED" : "accepted"}, reached victim=${reached(OVER_UNGUARDED)}`);
      console.log(`  overwrite PROTECTED attribute  : ${errGuarded ? "REJECTED" : "accepted"}, reached victim=${reached(OVER_GUARDED)}`);
      console.log(`  write into another PLAYER scope: ${errPlayer ? "REJECTED" : "accepted"}, reached victim=${reached(OVER_PLAYER)}`);

      // CHARACTERISATION, not aspiration. Empirica/Tajriba has no write ACL:
      // any participant that knows a node id can set attributes on it, and
      // `protected: true` does not prevent it. These assertions pin the CURRENT
      // behaviour so that if upstream ever adds enforcement, this test fails
      // loudly and we can tighten the module's guarantees rather than silently
      // keep defending against a threat that no longer exists.
      assert.equal(errGuarded, undefined, "characterisation: protected writes are not rejected today");
      assert.equal(
        reached(OVER_GUARDED),
        true,
        "characterisation: a protected attribute IS overwritable by another participant"
      );
      assert.equal(
        reached(OVER_PLAYER),
        true,
        "characterisation: any participant can write into any other participant's player scope"
      );

      // The invariant the module must therefore be built on: server-side code
      // may never trust a participant-written value's provenance.
    }
  );
});
