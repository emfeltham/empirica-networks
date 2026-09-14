/**
 * Per-viewer names for people a participant can see but is not connected to.
 *
 * WHY THIS EXISTS AT ALL. Everything on the wire today is named by POSITION in
 * the viewer's own neighbor array: local index 0 is the viewer, 1..d are
 * `NEIGHBORS[0..d-1]` in order (`src/admin/subgraph.ts`). That works precisely
 * because every visible node is in that array. Above radius 1 it stops being
 * true — a node two hops away has no entry — and the seating plan cannot be used
 * instead, because a topology index is a stable name for everybody in the study
 * and handing one out is a larger disclosure than the ties themselves
 * (PLATFORM-NOTES §4b).
 *
 * So a distant node needs a name with four properties, and each one is load
 * bearing:
 *
 *   1. Stable for this (viewer, person) pair for the life of the game, so a
 *      participant can tell "the same node I saw last round" from "a new one" —
 *      including across a ball that changed shape in between, and across a
 *      server restart.
 *   2. Uncorrelated between viewers, so two participants comparing screens
 *      cannot line their pictures up by name.
 *   3. Never derivable from a seat or a player id by anyone holding only what
 *      participants are sent.
 *   4. Invertible by whoever holds the batch export, or `structure.csv` and
 *      `positions.csv` cannot be joined to anything.
 *
 * NOT `hashSeed`. `src/admin/seed.ts` says of itself that it is "not
 * cryptographic", and it takes a 32-bit salt — so a participant who learns one
 * (ref, id) pair recovers the salt in 2^32 tries and can then map any candidate
 * id into any other viewer's name space, which is properties 2 and 3 gone at
 * once. Learning such a pair is not exotic: a distant node that rewires into
 * being your neighbor arrives in `NEIGHBORS`, where `project()` typically hands
 * you its real id, while its ref is still on your screen.
 *
 * NOT the game seed as the key, either. The seed defaults to
 * `hashSeed(String(game.id))` and the game scope IS delivered to participants,
 * so a seed-derived key is a key every participant already holds.
 *
 * The key is therefore random, per game, and lives on the BATCH scope — the one
 * durable scope measured not to reach participants, which is where the edge list
 * and the seed already live for the same reason. That is also what buys property
 * 1 across a restart and property 4 for the analyst.
 */
import crypto from "node:crypto";

/**
 * A fresh key. One per game, recorded on the batch scope.
 *
 * 32 bytes because that is HMAC-SHA256's block-optimal key size; there is no
 * argument for less and no benefit to more.
 */
export function makeViewKey(): string {
  return crypto.randomBytes(32).toString("base64");
}

/**
 * Crockford's base32 alphabet, lowercased: no `i`, `l`, `o` or `u`.
 *
 * Chosen over hex because a ref may well be shown to a participant — a design
 * that asks "did you see the same person twice" needs something readable on
 * screen — and the excluded letters are the ones that get misread as `1` and
 * `0` or, in `u`'s case, complete an unfortunate word by accident.
 */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Characters per ref. 8 × 5 bits = 40 bits. */
const LENGTH = 8;

/**
 * What this viewer calls this person.
 *
 * Deterministic given the key, so two calls in one publish agree and a restart
 * that recovers the key keeps every name it had.
 *
 * The viewer id is inside the MESSAGE rather than mixed into the key, which is
 * what gives each viewer a disjoint name space from one stored secret. The NUL
 * separator matters: without it `("ab", "c")` and `("a", "bc")` hash equal, so
 * two different pairs could share a ref and the collision would look like one
 * person rather than like a bug.
 *
 * 40 bits leaves a birthday collision probability inside one participant's ball
 * around 2e-8 at the envelope's largest, which is small and is not zero — so the
 * caller checks for duplicates within a ball and refuses rather than shipping
 * two people under one name. That failure would be invisible: the picture stays
 * plausible and two participants merge into one.
 *
 * Cost is one HMAC per (viewer, node) pair per publish, microseconds each. Left
 * uncached here because a cache needs a lifetime, and the only scope that knows
 * when a game ends is the publish path.
 */
export function refFor(key: string, viewerID: string, targetID: string): string {
  const mac = crypto.createHmac("sha256", Buffer.from(key, "base64"));
  mac.update(viewerID, "utf8");
  mac.update("\0", "utf8");
  mac.update(targetID, "utf8");
  const digest = mac.digest();

  let out = "";
  let acc = 0;
  let bits = 0;
  for (let i = 0; out.length < LENGTH; i++) {
    acc = (acc << 8) | digest[i]!;
    bits += 8;
    while (bits >= 5 && out.length < LENGTH) {
      bits -= 5;
      out += ALPHABET[(acc >>> bits) & 31];
    }
  }
  return out;
}
