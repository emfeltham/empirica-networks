/**
 * The monitor's HTTP surface, against a synthetic source.
 *
 * No Empirica anywhere in this file, which is itself the first assertion: if
 * `serveMonitor` ever needed a connection or a token to do its job, this test
 * could not be written. It cannot, so it cannot leak one.
 *
 * These are unit-tier deliberately. Everything here is about the endpoint —
 * who can reach it, what it serves, what it refuses — and none of it needs a
 * running study. The claims that DO need one (a participant's wire stream
 * carries none of this; a participant's private write reaches the payload) are
 * in test/e2e/monitor.test.ts.
 */
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import test from "node:test";
import type { GameSnapshot } from "../../src/admin/inspect.js";
import { graphMetrics, historyFrames } from "../../src/admin/inspect.js";
import { serveMonitor, type MonitorServer } from "../../src/admin/monitor/http.js";
import { PAGE } from "../../src/admin/monitor/ui.js";
import type { Edge } from "../../src/topology/index.js";
import { ring } from "../../src/topology/index.js";

const ORDER = ["p0", "p1", "p2", "p3"];

/** A source whose answers the test controls outright. */
function fakeSource(initial: Partial<GameSnapshot> = {}) {
  let edges: Edge[] = (initial.edges as Edge[]) ?? ring(4);
  let present = true;
  let color = "blue";
  let throws = false;

  return {
    set edges(next: Edge[]) {
      edges = next;
    },
    setPresent(v: boolean) {
      present = v;
    },
    setColor(v: string) {
      color = v;
    },
    setThrows(v: boolean) {
      throws = v;
    },
    source: {
      games: () => (present ? ["g1"] : []),
      stats: () => ({ games: present ? 1 : 0, channels: 4, channelScopes: 4, cachedViews: 4 }),
      inspect: (gameID: string): GameSnapshot | undefined => {
        if (throws) throw new Error("synthetic inspect failure");
        if (!present || gameID !== "g1") return undefined;
        return {
          gameID: "g1",
          batchID: "b1",
          n: 4,
          edges,
          order: ORDER,
          seed: 7,
          radius: 1,
          recordedRadius: 1,
          seq: 3,
          nodes: ORDER.map((playerID, index) => ({
            index,
            playerID,
            degree: 2,
            neighbors: [],
            channel: true,
            attrs: {},
            state: { color: color },
          })),
          metrics: graphMetrics(4, edges),
          history: historyFrames("g1", [], ORDER),
          pendingChannels: [],
          awaitingPublish: false,
          watch: ["color"],
        };
      },
    },
  };
}

async function withMonitor(
  fake: ReturnType<typeof fakeSource>,
  fn: (m: MonitorServer) => Promise<void>,
  opts: Record<string, unknown> = {},
): Promise<void> {
  const server = await serveMonitor(fake.source, { pollMs: 25, log: () => {}, ...opts });
  try {
    await fn(server);
  } finally {
    await server.stop();
  }
}

interface Res {
  status: number;
  body: string;
}

function get(
  m: Pick<MonitorServer, "host" | "port">,
  path: string,
  headers: Record<string, string> = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: m.host, port: m.port, path, method: "GET", agent: false, headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ------------------------------------------------------------------ the token

test("no token is refused", async () => {
  const fake = fakeSource();
  await withMonitor(fake, async (m) => {
    for (const path of ["/", "/api/state", "/api/games", "/api/stream"]) {
      const res = await get(m, path);
      assert.equal(res.status, 401, `${path} must not be open`);
    }
  });
});

test("a wrong token of the right length is refused", async () => {
  const fake = fakeSource();
  await withMonitor(
    fake,
    async (m) => {
      const res = await get(m, "/api/state?t=" + "b".repeat(32));
      assert.equal(res.status, 401);
    },
    { token: "a".repeat(32) },
  );
});

test("a token of the wrong length is refused rather than throwing", async () => {
  // timingSafeEqual throws on length mismatch. Unguarded, a short token would
  // crash the request handler instead of returning 401 — and a monitor that
  // 500s on a guess tells the guesser more than a 401 does.
  const fake = fakeSource();
  await withMonitor(
    fake,
    async (m) => {
      assert.equal((await get(m, "/api/state?t=short")).status, 401);
      assert.equal((await get(m, "/api/state?t=" + "a".repeat(500))).status, 401);
    },
    { token: "a".repeat(32) },
  );
});

test("the token is accepted in the query string and in a Bearer header", async () => {
  // Both, because EventSource cannot set headers — without the query form the
  // SSE stream could not authenticate at all.
  const fake = fakeSource();
  await withMonitor(
    fake,
    async (m) => {
      assert.equal((await get(m, "/api/state?t=" + "a".repeat(32))).status, 200);
      assert.equal(
        (await get(m, "/api/state", { authorization: "Bearer " + "a".repeat(32) })).status,
        200,
      );
    },
    { token: "a".repeat(32) },
  );
});

test("a generated token is long and random", async () => {
  const a = fakeSource();
  const b = fakeSource();
  await withMonitor(a, async (m1) => {
    await withMonitor(b, async (m2) => {
      assert.ok(m1.token.length >= 32, `token is only ${m1.token.length} chars`);
      assert.notEqual(m1.token, m2.token, "two runs must not share a token");
    });
  });
});

// ----------------------------------------------------------------- reachability

test("the default bind is loopback, and nothing else can reach it", async () => {
  const fake = fakeSource();
  await withMonitor(fake, async (m) => {
    assert.equal(m.host, "127.0.0.1");
    assert.equal((await get(m, "/api/state?t=" + m.token)).status, 200, "loopback works");

    // The real claim: a machine's own LAN address must not answer. Asserted
    // against an actual interface rather than inferred from the bind argument,
    // because "we passed 127.0.0.1" and "nothing else answers" are different
    // statements and only the second is the one that matters.
    const external = externalIPv4();
    if (!external) {
      // Said out loud rather than passing quietly. A test that silently checks
      // nothing when the machine has no LAN interface is the "count was never
      // populated" failure this repo warns about.
      assert.fail(
        "no non-loopback IPv4 interface on this machine, so the unreachability " +
          "claim could not be exercised — do not read this run as evidence",
      );
    }
    await assert.rejects(
      () => connect(external, m.port),
      /ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|ENETUNREACH/,
      `${external}:${m.port} answered; the monitor is not loopback-only`,
    );
  });
});

test("binding off loopback is allowed but says what it costs", async () => {
  // Convention, not structure, and labeled as such. The
  // package's job is to make the override loud, not to forbid it.
  const fake = fakeSource();
  const logged: string[] = [];
  const server = await serveMonitor(fake.source, {
    host: "0.0.0.0",
    pollMs: 25,
    log: (m) => logged.push(m),
  });
  try {
    const warning = logged.join("\n");
    assert.match(warning, /NOT loopback/);
    assert.match(warning, /complete network|private state/i);
  } finally {
    await server.stop();
  }
});

// --------------------------------------------------------------------- content

test("/api/state serves the graph and its coordinates", async () => {
  const fake = fakeSource();
  await withMonitor(fake, async (m) => {
    const res = await get(m, "/api/state?t=" + m.token);
    const body = JSON.parse(res.body);
    assert.equal(body.snapshot.gameID, "g1");
    assert.equal(body.snapshot.edges.length, 4);
    assert.equal(body.positions.length, 4);
    assert.equal(body.snapshot.seq, 3, "publish counts are part of the operational view");
    // How much of the graph the people being watched can see. Serialized here
    // and asserted by nothing until this line: the field was present in the
    // fixture only because the type demands it, so a serializer that dropped it
    // would have been caught by no test in this tier.
    assert.equal(body.snapshot.radius, 1, "the radius survives serialization");
    assert.equal(
      body.snapshot.recordedRadius,
      1,
      "and so does the recorded one, which is the half an operator cannot get elsewhere"
    );
  });
});

test("a game this process does not hold is reported gone, not empty", async () => {
  // The distinction the monitor's `gone` state turns on. An empty graph and a lost game
  // look identical on screen, and an unresumable restart makes the second one common.
  const fake = fakeSource();
  await withMonitor(fake, async (m) => {
    const res = await get(m, "/api/state?t=" + m.token + "&game=nope");
    const body = JSON.parse(res.body);
    assert.equal(body.gone, true);
    assert.ok(!body.snapshot, "no empty snapshot may be served in its place");
  });
});

test("an inspect() that throws does not take the endpoint down", async () => {
  // The monitor is an observer. If it can crash the process it is watching, it
  // is worse than not having one.
  const fake = fakeSource();
  await withMonitor(fake, async (m) => {
    fake.setThrows(true);
    const res = await get(m, "/api/state?t=" + m.token);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).gone, true);

    fake.setThrows(false);
    assert.ok(JSON.parse((await get(m, "/api/state?t=" + m.token)).body).snapshot);
  });
});

test("the stream pushes on change and stays quiet otherwise", async () => {
  const fake = fakeSource();
  await withMonitor(fake, async (m) => {
    const stream = openStream(m);
    try {
      await stream.waitForEvents(1);
      const first = stream.events[0]!;
      assert.equal(first.event, "state");
      assert.equal(first.data.snapshot.nodes[0].state.color, "blue");

      // Quiet for several poll intervals: the byte-identical suppression has to
      // actually suppress, or an idle study is a busy loop.
      await delay(150);
      assert.equal(stream.events.length, 1, "an unchanged study must push nothing");

      fake.setColor("green");
      await stream.waitForEvents(2);
      assert.equal(stream.events[1]!.data.snapshot.nodes[0].state.color, "green");

      fake.edges = ring(4).filter(([a, b]) => !(a === 0 && b === 1));
      await stream.waitForEvents(3);
      assert.equal(stream.events[2]!.data.snapshot.edges.length, 3, "a dropped tie arrives");
    } finally {
      stream.close();
    }
  });
});

test("the stream reports a vanished game rather than freezing", async () => {
  const fake = fakeSource();
  await withMonitor(fake, async (m) => {
    const stream = openStream(m);
    try {
      await stream.waitForEvents(1);
      fake.setPresent(false);
      await stream.waitForEvents(2);
      assert.equal(stream.events[1]!.event, "gone");
    } finally {
      stream.close();
    }
  });
});

test("a stream opened on a game that is not there says so immediately", async () => {
  // Otherwise the page waits on a poll that will never have anything to say,
  // which on screen is indistinguishable from a study where nothing happens.
  const fake = fakeSource();
  fake.setPresent(false);
  await withMonitor(fake, async (m) => {
    const stream = openStream(m, "g1");
    try {
      await stream.waitForEvents(1);
      assert.equal(stream.events[0]!.event, "gone");
    } finally {
      stream.close();
    }
  });
});

test("gone is announced once, not on every poll", async () => {
  // A game that has ended stays ended. Re-announcing at the poll rate is a busy
  // loop that also makes the browser look like it is still receiving updates.
  const fake = fakeSource();
  await withMonitor(fake, async (m) => {
    const stream = openStream(m);
    try {
      await stream.waitForEvents(1);
      fake.setPresent(false);
      await stream.waitForEvents(2);
      assert.equal(stream.events[1]!.event, "gone");

      // Many poll intervals later, still exactly one announcement.
      await delay(300);
      assert.equal(
        stream.events.filter((e) => e.event === "gone").length,
        1,
        `gone was re-sent ${stream.events.length - 1} times`,
      );
    } finally {
      stream.close();
    }
  });
});

test("an unknown path is a 404, not the page", async () => {
  const fake = fakeSource();
  await withMonitor(fake, async (m) => {
    assert.equal((await get(m, "/../etc/passwd?t=" + fakeToken(m))).status, 401);
    assert.equal((await get(m, "/nope?t=" + m.token)).status, 404);
  });
});

// ------------------------------------------------------------------- the page

test("the served page fetches nothing from anywhere else", async () => {
  // The page holds the complete seating plan. A CDN import would send the
  // referrer — and any query string the operator's URL carries — off the
  // machine. The CSP the server sends is default-src 'none' so it would fail
  // anyway; this asserts there is nothing to fail.
  const external = PAGE.match(/https?:\/\/[^"' )]+/g) ?? [];
  const allowed = new Set(["http://www.w3.org/2000/svg"]);
  const offenders = external.filter((u) => !allowed.has(u));
  assert.deepEqual(offenders, [], "the only URL may be the SVG XML namespace, which is never fetched");
  assert.equal(/<(script|img|link)[^>]+\ssrc=|<link[^>]+href=/i.test(PAGE), false, "no external asset tags");
});

test("the page's script parses", () => {
  // The cheapest possible guard on the one part of the monitor no test drives
  // (ISSUES.md O9). A syntax error here produces a completely blank page, the
  // server still returns 200, and every other test in this file still passes —
  // which is precisely the silent-failure shape this package keeps meeting.
  //
  // `new Function` COMPILES the body without running it, so this catches a
  // syntax error without needing a DOM. It says nothing about whether the
  // script is correct; that is still O9.
  const script = /<script>([\s\S]*?)<\/script>/.exec(PAGE)?.[1];
  assert.ok(script && script.length > 1000, "the page must actually carry its script");
  assert.doesNotThrow(() => new Function(script), "the served script does not parse");
});

test("the page carries no credential of any kind", async () => {
  // The monitor token arrives in the URL at request time; the srtoken never
  // exists in this half of the system at all. Both stated as a test so that a
  // future convenience ("just bake the token in") is caught.
  assert.equal(/srtoken/i.test(PAGE), false);
  const fake = fakeSource();
  await withMonitor(fake, async (m) => {
    const page = (await get(m, "/?t=" + m.token)).body;
    assert.equal(page.includes(m.token), false, "the token must not be echoed into the body");
  });
});

test("the served page and the API are marked no-store", async () => {
  const fake = fakeSource();
  await withMonitor(fake, async (m) => {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        { host: m.host, port: m.port, path: "/?t=" + m.token, agent: false },
        resolve,
      );
      req.on("error", reject);
      req.end();
    });
    res.resume();
    assert.equal(res.headers["cache-control"], "no-store");
    assert.match(String(res.headers["content-security-policy"]), /default-src 'none'/);
  });
});

// ------------------------------------------------------------------- helpers

function fakeToken(m: MonitorServer): string {
  return "z".repeat(m.token.length);
}

function externalIPv4(): string | undefined {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return undefined;
}

function connect(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port, timeout: 2_000 });
    socket.on("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("ETIMEDOUT"));
    });
    socket.on("error", (e) => {
      socket.destroy();
      reject(e);
    });
  });
}

interface StreamEvent {
  event: string;
  data: any;
}

function openStream(m: MonitorServer, gameID?: string) {
  const events: StreamEvent[] = [];
  let buffer = "";
  const req = http.request({
    host: m.host,
    port: m.port,
    // Named explicitly when the game is already absent: without an id the
    // server has no games() entry to default to and refuses with 409, which
    // would test the wrong branch.
    path: "/api/stream?t=" + m.token + (gameID ? "&game=" + gameID : ""),
    agent: false,
  });
  req.on("response", (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buffer += chunk;
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
        sep = buffer.indexOf("\n\n");
      }
    });
  });
  req.end();

  return {
    events,
    async waitForEvents(count: number, timeoutMs = 5_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (events.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`only ${events.length} of ${count} SSE events arrived`);
        }
        await delay(20);
      }
    },
    close: () => req.destroy(),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
