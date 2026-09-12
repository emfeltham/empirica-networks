/**
 * What a bot is called.
 *
 * Not a naming question. Every participant in a game receives every other
 * participant's `participantIdentifier` (`ISSUES.md` U10, measured in
 * `test/e2e/bots.test.ts`), so a bot's identifier is on screen in a browser. For
 * a design that does not tell subjects which neighbors are software, a
 * recognisable identifier discloses the manipulation.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertIdentifiers,
  botIdentifiers,
  botMarkerWarning,
} from "../../src/bots/identity.js";

test("the generated shape is the one Empirica's own client generates", () => {
  // `createNewParticipant` sets ?participantKey= to Date.now().toString(), so a
  // 13-digit number is what a dev-mode human looks like. This default exists to
  // blend into THAT and nothing else.
  const ids = botIdentifiers(3, { now: 1_755_000_000_000 });
  assert.deepEqual(ids, ["1755000000000", "1755000000001", "1755000000002"]);
  for (const id of ids) assert.match(id, /^\d{13}$/);
});

test("generated identifiers are distinct, because a duplicate is one participant", () => {
  const ids = botIdentifiers(50, { now: 1_755_000_000_000 });
  assert.equal(new Set(ids).size, 50);
});

test("botIdentifiers is a pure function of its arguments", () => {
  // Deterministic given `now`, so a study can record what its bots were called
  // and regenerate them. A `Date.now()` inside would make that impossible.
  assert.deepEqual(botIdentifiers(4, { now: 7 }), botIdentifiers(4, { now: 7 }));
  assert.notDeepEqual(botIdentifiers(4, { now: 7 }), botIdentifiers(4, { now: 8 }));
  assert.deepEqual(botIdentifiers(0, { now: 7 }), []);
});

test("a negative or fractional count is an error rather than an empty fleet", () => {
  assert.throws(() => botIdentifiers(-1), /non-negative integer/);
  assert.throws(() => botIdentifiers(2.5), /non-negative integer/);
});

test("the obvious naming mistake is caught, and it names the word it found", () => {
  const warning = botMarkerWarning(["bot-1", "bot-2", "bot-3"])!;
  assert.ok(warning, "bot-N is flagged");
  assert.match(warning, /3 of 3/);
  assert.match(warning, /contains "bot"/);
  assert.match(warning, /U10/, "points at the reason rather than just scolding");
});

test("every marker word is detected, case-insensitively", () => {
  for (const word of [
    "bot",
    "Agent",
    "ROBOT",
    "simulated",
    "artificial",
    "virtual",
    "npc",
    "fake",
    "dummy",
    "test",
    "debug",
  ]) {
    assert.ok(botMarkerWarning([`p-${word}-1`]), `"${word}" should be flagged`);
  }
});

test("the warning counts hits rather than reporting only the first", () => {
  // A list where only some identifiers are recognisable is the realistic
  // half-migrated case, and reporting "1 of 5" is what tells you it is half done.
  const warning = botMarkerWarning(["1755000000000", "bot-2", "1755000000002"])!;
  assert.match(warning, /1 of 3/);
});

test("realistic recruitment keys are not flagged", () => {
  // The check is a heuristic, so its false-positive rate matters: it must not
  // fire on the identifiers a real study actually uses.
  assert.equal(botMarkerWarning(botIdentifiers(5, { now: 1_755_000_000_000 })), undefined);
  assert.equal(botMarkerWarning(["5f8a1c2e9b4d3a7c6e1f0982", "60b3d4e5f6a7b8c9d0e1f234"]), undefined);
  assert.equal(botMarkerWarning(["A1B2C3D4E5F6G7"]), undefined);
});

test("a duplicate identifier throws, because it is a study that never starts", () => {
  // Tajriba keys a participant BY this string, so two bots sharing one are one
  // participant with two sockets. The game sits one player short of its count
  // forever, and nothing anywhere says why. This is the one case that is fatal
  // rather than a warning.
  assert.throws(() => assertIdentifiers(["a", "b", "a"]), /duplicate bot identifier/);
  assert.throws(() => assertIdentifiers(["a", "b", "a"]), /one player short/);
});

test("an empty fleet and an empty identifier are both rejected", () => {
  assert.throws(() => assertIdentifiers([]), /at least one identifier/);
  assert.throws(() => assertIdentifiers([""]), /non-empty strings/);
  assert.throws(() => assertIdentifiers([undefined as unknown as string]), /non-empty strings/);
});

test("a valid list passes", () => {
  assert.doesNotThrow(() => assertIdentifiers(botIdentifiers(3, { now: 1 })));
});
