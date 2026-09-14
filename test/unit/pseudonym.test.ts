/**
 * Per-viewer names for distant people.
 *
 * The properties below are the whole reason this module is not two lines of
 * `hashSeed`. Each test is one of them, and each corresponds to a way a
 * participant could learn something the study did not mean to tell them — so a
 * failure here is a disclosure, not a cosmetic defect.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { makeViewKey, refFor } from "../../src/admin/pseudonym.js";

const KEY = makeViewKey();
const OTHER = makeViewKey();

test("stable: the same viewer calling the same person gets the same name", () => {
  assert.equal(refFor(KEY, "alice", "zed"), refFor(KEY, "alice", "zed"));
});

/**
 * Property 2, and the one a participant would actually try.
 *
 * Two people comparing screens must not be able to say "you have `a3k9` too, so
 * we are looking at the same person".
 */
test("uncorrelated: two viewers give the same person different names", () => {
  assert.notEqual(refFor(KEY, "alice", "zed"), refFor(KEY, "bob", "zed"));
});

test("distinct: one viewer gives two people different names", () => {
  assert.notEqual(refFor(KEY, "alice", "zed"), refFor(KEY, "alice", "yan"));
});

/**
 * The separator. Without it `("ab","c")` and `("a","bc")` hash identically, and
 * two different pairs would share a ref — which on screen is two people merged
 * into one, with the picture still looking entirely correct.
 */
test("the viewer/target boundary is not ambiguous", () => {
  assert.notEqual(refFor(KEY, "ab", "c"), refFor(KEY, "a", "bc"));
  assert.notEqual(refFor(KEY, "", "abc"), refFor(KEY, "abc", ""));
});

test("keyed: a different key renames everybody", () => {
  assert.notEqual(refFor(KEY, "alice", "zed"), refFor(OTHER, "alice", "zed"));
});

/**
 * Property 3. A ref must not be a lightly-dressed player id, because the ids in
 * this package are ULIDs whose prefix is a timestamp — so anything that leaked a
 * substring would leak join order too.
 */
test("a ref contains nothing of the ids it was made from", () => {
  const ref = refFor(KEY, "01M2GTA40YK4PZVC7B9EKHXV5S", "01M2GTA48DH0M90P2P2HFQA223");
  for (let i = 0; i + 3 <= ref.length; i++) {
    const chunk = ref.slice(i, i + 3);
    assert.ok(!"01M2GTA48DH0M90P2P2HFQA223".toLowerCase().includes(chunk), `leaked ${chunk}`);
  }
});

test("shape: eight characters from an unambiguous alphabet", () => {
  const key = makeViewKey();
  for (let i = 0; i < 500; i++) {
    const ref = refFor(key, `v${i}`, `t${i * 7}`);
    assert.match(ref, /^[0-9abcdefghjkmnpqrstvwxyz]{8}$/, ref);
  }
});

/**
 * Not a proof of uniformity — that is what the construction is for — but it
 * would catch the implementation mistakes that matter: a truncation that always
 * emits the same leading character, or an accumulator that drops bits.
 */
test("names spread: 2000 refs from one key collide no more than chance allows", () => {
  const key = makeViewKey();
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) seen.add(refFor(key, "alice", `person-${i}`));
  assert.equal(seen.size, 2000, "a collision at this size means the space is not 40 bits");

  const firstChars = new Set([...seen].map((r) => r[0]));
  assert.ok(firstChars.size > 20, `only ${firstChars.size} distinct leading characters`);
});

test("keys are fresh", () => {
  assert.notEqual(makeViewKey(), makeViewKey());
  assert.equal(Buffer.from(makeViewKey(), "base64").length, 32);
});
