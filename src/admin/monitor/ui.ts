/**
 * The served page, as a string.
 *
 * A string rather than a file for one practical reason: a file would have to be
 * copied into `dist` by a build step tsup does not do by default, and resolved
 * at runtime relative to `import.meta.url` — two ways to ship a monitor that
 * 404s only on the consumer's machine. A string cannot get lost between the
 * source tree and the package.
 *
 * WHAT IS DELIBERATELY NOT IN HERE:
 *
 *   - Layout. Positions arrive precomputed (./layout.ts). PLATFORM-NOTES §8 says
 *     nothing mounted can be tested in this codebase, so every decision lives in
 *     a pure function on the server and this file is left with
 *     `createElementNS`.
 *   - History replay. `snapshotRows()` already replays the log into a full edge
 *     list per event, so the scrubber indexes an array that
 *     arrived in the payload. There is no second replay here to disagree with
 *     the exported `network_snapshots.csv`.
 *   - Any dependency. No CDN, no bundler, no import. The Content-Security-Policy
 *     the server sends is `default-src 'none'`, so an accidental third-party
 *     import fails visibly rather than quietly phoning out from a page that
 *     contains the complete seating plan.
 *
 * Colors follow the validated categorical palette, capped at THREE slots plus
 * "other". A node-link diagram compares every mark against every other, so the
 * all-pairs gate applies rather than the adjacent one, and only the first three
 * slots clear it in both modes (validated: worst all-pairs CVD ΔE 9.2 light /
 * 9.4 dark, normal-vision 24.0 / 20.9). Aqua sits at 2.74:1 on the light
 * surface, below the 3:1 bar, so the relief rule applies — every node carries a
 * visible label and a table view exists, and identity is therefore never
 * carried by color alone.
 */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>empirica-networks monitor</title>
<style>
  :root {
    color-scheme: light dark;
    --surface-1: #fcfcfb;
    --plane: #f9f9f7;
    --ink: #0b0b0b;
    --ink-2: #52514e;
    --muted: #898781;
    --grid: #e1e0d9;
    --axis: #c3c2b7;
    --border: rgba(11,11,11,0.10);
    --s1: #2a78d6;
    --s2: #eb6834;
    --s3: #1baf7a;
    --good: #0ca30c;
    --warning: #fab219;
    --critical: #d03b3b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface-1: #1a1a19;
      --plane: #0d0d0d;
      --ink: #ffffff;
      --ink-2: #c3c2b7;
      --muted: #898781;
      --grid: #2c2c2a;
      --axis: #383835;
      --border: rgba(255,255,255,0.10);
      --s1: #3987e5;
      --s2: #d95926;
      --s3: #199e70;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--plane); color: var(--ink);
    font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
    padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--surface-1);
  }
  header h1 { font-size: 13px; font-weight: 600; margin: 0; }
  .badge {
    font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
    padding: 2px 8px; border-radius: 3px; border: 1px solid var(--border); color: var(--ink-2);
  }
  .badge.live { color: var(--good); border-color: var(--good); }
  .badge.history { color: var(--warning); border-color: var(--warning); }
  .badge.gone { color: var(--critical); border-color: var(--critical); }
  main { display: grid; grid-template-columns: 1fr 320px; gap: 0; height: calc(100vh - 100px); }
  #stage { background: var(--surface-1); overflow: hidden; position: relative; }
  svg { width: 100%; height: 100%; display: block; }
  aside {
    border-left: 1px solid var(--border); background: var(--surface-1);
    overflow-y: auto; padding: 12px 16px;
  }
  aside h2 {
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em;
    color: var(--muted); margin: 18px 0 6px;
  }
  aside h2:first-child { margin-top: 0; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 0; }
  dt { color: var(--ink-2); }
  dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
  dd.alert { color: var(--critical); font-weight: 600; }
  dd.warn { color: var(--warning); font-weight: 600; }
  .legend { display: flex; flex-direction: column; gap: 4px; }
  .legend div { display: flex; align-items: center; gap: 8px; }
  .swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; }
  footer {
    display: flex; align-items: center; gap: 12px; padding: 8px 16px;
    border-top: 1px solid var(--border); background: var(--surface-1);
  }
  footer input[type=range] { flex: 1; accent-color: var(--s1); }
  button {
    font: inherit; padding: 3px 10px; border-radius: 3px; cursor: pointer;
    border: 1px solid var(--axis); background: transparent; color: var(--ink);
  }
  button[disabled] { opacity: .4; cursor: default; }
  select { font: inherit; background: transparent; color: var(--ink); border: 1px solid var(--axis); border-radius: 3px; padding: 2px 4px; }
  #scrubLabel { font-variant-numeric: tabular-nums; color: var(--ink-2); min-width: 210px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--grid); }
  th { color: var(--muted); font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  #tableView { display: none; padding: 12px 16px; background: var(--surface-1); }
  #tableView.on { display: block; }
  #banner {
    display: none; padding: 10px 16px; background: var(--surface-1);
    border-bottom: 1px solid var(--critical); color: var(--critical);
  }
  #banner.on { display: block; }
  #tip {
    position: absolute; pointer-events: none; display: none; max-width: 260px;
    background: var(--surface-1); border: 1px solid var(--border); border-radius: 4px;
    padding: 6px 8px; font-size: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.18);
  }
  #tip.on { display: block; }
  #tip b { display: block; margin-bottom: 2px; }
  .k { color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>empirica-networks monitor</h1>
  <span id="mode" class="badge live">live</span>
  <span id="gameLabel" class="k"></span>
  <select id="gamePicker" style="display:none" aria-label="game"></select>
  <span style="flex:1"></span>
  <label class="k">color by
    <select id="colorKey"></select>
  </label>
  <button id="tableToggle">table view</button>
</header>
<div id="banner"></div>
<main>
  <div id="stage">
    <svg id="graph" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid meet" role="img"
         aria-label="Network of participants. Full data is in the table view."></svg>
    <div id="tip"></div>
  </div>
  <aside>
    <h2>Graph</h2>
    <dl id="metrics"></dl>
    <h2>Legend</h2>
    <div class="legend" id="legend"></div>
    <h2>Operations</h2>
    <dl id="ops"></dl>
    <h2>Selected</h2>
    <div id="detail" class="k">click a node</div>
  </aside>
</main>
<div id="tableView"></div>
<footer>
  <button id="liveBtn" disabled>live</button>
  <input type="range" id="scrub" min="0" max="0" value="0">
  <span id="scrubLabel">no history</span>
</footer>
<script>
(function () {
  "use strict";
  var params = new URLSearchParams(location.search);
  var token = params.get("t") || "";
  var gameParam = params.get("game") || "";

  var payload = null;      // last {snapshot, positions, digest}
  var frameIndex = null;   // null = live; otherwise an index into history.frames
  var colorKey = null;
  var selected = null;
  var SLOTS = ["--s1", "--s2", "--s3"];
  var SIZE = 1000;

  function url(path) {
    var q = path + "?t=" + encodeURIComponent(token);
    if (gameParam) q += "&game=" + encodeURIComponent(gameParam);
    return q;
  }
  function el(id) { return document.getElementById(id); }
  function svgEl(name) { return document.createElementNS("http://www.w3.org/2000/svg", name); }
  function text(v) {
    if (v === undefined) return "\\u2014";
    if (v === null) return "null";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  function banner(message) {
    var b = el("banner");
    if (!message) { b.className = ""; b.textContent = ""; return; }
    b.className = "on";
    b.textContent = message;
  }

  // ---- color assignment -------------------------------------------------
  // Value for the color key, preferring the participant's PRIVATE channel over
  // the broadcast player attribute: when an author keeps a key in both places
  // the private one is the value the projection actually used.
  function valueOf(node) {
    if (!colorKey) return undefined;
    if (node.state && node.state[colorKey] !== undefined) return node.state[colorKey];
    if (node.attrs && node.attrs[colorKey] !== undefined) return node.attrs[colorKey];
    return undefined;
  }

  // Fixed order by first appearance in seat order, never by frequency: a color
  // must follow the value, not its rank, or a participant changing their mind
  // repaints everyone else.
  function colorScale(nodes) {
    var values = [];
    for (var i = 0; i < nodes.length; i++) {
      var v = valueOf(nodes[i]);
      if (v === undefined) continue;
      var s = text(v);
      if (values.indexOf(s) === -1) values.push(s);
    }
    var map = {};
    for (var j = 0; j < values.length && j < SLOTS.length; j++) {
      map[values[j]] = "var(" + SLOTS[j] + ")";
    }
    return { map: map, values: values };
  }

  function fillFor(node, scale) {
    var v = valueOf(node);
    if (v === undefined) return "var(--axis)";
    return scale.map[text(v)] || "var(--muted)";
  }

  // ---- rendering ---------------------------------------------------------
  function edgesToDraw(snap) {
    if (frameIndex === null) {
      return { edges: snap.edges, added: [], removed: [] };
    }
    var f = snap.history.frames[frameIndex];
    if (!f) return { edges: snap.edges, added: [], removed: [] };
    return { edges: f.edges, added: f.added, removed: f.removed };
  }

  function key(e) { return e[0] < e[1] ? e[0] + "-" + e[1] : e[1] + "-" + e[0]; }

  function render() {
    var svg = el("graph");
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!payload) return;

    var snap = payload.snapshot;
    var pos = payload.positions;
    var view = edgesToDraw(snap);
    var scale = colorScale(snap.nodes);

    var addedSet = {};
    for (var a = 0; a < view.added.length; a++) addedSet[key(view.added[a])] = true;

    // Removed ties are drawn as well as absent ones: on a scrubbed frame the
    // interesting thing is usually the tie that just went away, and a graph
    // that only shows what remains cannot show it.
    var gRemoved = svgEl("g");
    for (var r = 0; r < view.removed.length; r++) {
      var rm = view.removed[r];
      if (!pos[rm[0]] || !pos[rm[1]]) continue;
      var rl = svgEl("line");
      rl.setAttribute("x1", pos[rm[0]].x); rl.setAttribute("y1", pos[rm[0]].y);
      rl.setAttribute("x2", pos[rm[1]].x); rl.setAttribute("y2", pos[rm[1]].y);
      rl.setAttribute("stroke", "var(--critical)");
      rl.setAttribute("stroke-width", "2");
      rl.setAttribute("stroke-dasharray", "6 5");
      rl.setAttribute("opacity", "0.85");
      gRemoved.appendChild(rl);
    }
    svg.appendChild(gRemoved);

    var gEdges = svgEl("g");
    for (var i = 0; i < view.edges.length; i++) {
      var e = view.edges[i];
      if (!pos[e[0]] || !pos[e[1]]) continue;
      var isNew = addedSet[key(e)];
      var line = svgEl("line");
      line.setAttribute("x1", pos[e[0]].x); line.setAttribute("y1", pos[e[0]].y);
      line.setAttribute("x2", pos[e[1]].x); line.setAttribute("y2", pos[e[1]].y);
      line.setAttribute("stroke", isNew ? "var(--good)" : "var(--axis)");
      line.setAttribute("stroke-width", isNew ? "3" : "2");
      line.setAttribute("stroke-linecap", "round");
      gEdges.appendChild(line);
    }
    svg.appendChild(gEdges);

    var gNodes = svgEl("g");
    for (var n = 0; n < snap.nodes.length; n++) {
      var node = snap.nodes[n];
      var p = pos[n];
      if (!p) continue;
      var g = svgEl("g");
      g.setAttribute("transform", "translate(" + p.x + "," + p.y + ")");
      g.setAttribute("cursor", "pointer");

      var c = svgEl("circle");
      c.setAttribute("r", "17");
      c.setAttribute("fill", fillFor(node, scale));
      // A 2px surface ring so a node crossing an edge stays a distinct mark.
      c.setAttribute("stroke", node.channel ? "var(--surface-1)" : "var(--critical)");
      c.setAttribute("stroke-width", node.channel ? "2" : "3");
      if (!node.channel) c.setAttribute("stroke-dasharray", "4 3");
      if (selected === n) { c.setAttribute("stroke", "var(--ink)"); c.setAttribute("stroke-width", "3"); }
      g.appendChild(c);

      var t = svgEl("text");
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("dy", "4");
      t.setAttribute("font-size", "12");
      t.setAttribute("font-weight", "600");
      t.setAttribute("fill", "var(--surface-1)");
      t.setAttribute("pointer-events", "none");
      t.textContent = String(node.index);
      g.appendChild(t);

      // The direct label. Required, not decorative: one light-mode slot sits
      // below 3:1 against the surface, so the relief rule applies and identity
      // may not rest on the fill.
      var v = valueOf(node);
      if (v !== undefined) {
        var lab = svgEl("text");
        lab.setAttribute("text-anchor", "middle");
        lab.setAttribute("dy", "33");
        lab.setAttribute("font-size", "11");
        lab.setAttribute("fill", "var(--ink-2)");
        lab.setAttribute("pointer-events", "none");
        lab.textContent = text(v);
        g.appendChild(lab);
      }

      (function (index) {
        g.addEventListener("click", function () { selected = index; render(); renderPanels(); });
        g.addEventListener("mousemove", function (ev) { showTip(ev, index); });
        g.addEventListener("mouseleave", hideTip);
      })(n);

      gNodes.appendChild(g);
    }
    svg.appendChild(gNodes);
  }

  function showTip(ev, index) {
    var snap = payload.snapshot;
    var node = snap.nodes[index];
    var tip = el("tip");
    var rect = el("stage").getBoundingClientRect();
    var html = "<b>seat " + node.index + " \\u00b7 degree " + node.degree + "</b>" +
      "<div class='k'>" + node.playerID + "</div>";
    for (var i = 0; i < snap.watch.length; i++) {
      var k = snap.watch[i];
      html += "<div><span class='k'>" + k + "</span> " + text(valueOfKey(node, k)) + "</div>";
    }
    if (!node.channel) html += "<div style='color:var(--critical)'>no channel scope yet</div>";
    tip.innerHTML = html;
    tip.className = "on";
    tip.style.left = Math.min(ev.clientX - rect.left + 14, rect.width - 270) + "px";
    tip.style.top = (ev.clientY - rect.top + 14) + "px";
  }
  function hideTip() { el("tip").className = ""; }

  function valueOfKey(node, k) {
    if (node.state && node.state[k] !== undefined) return node.state[k];
    if (node.attrs && node.attrs[k] !== undefined) return node.attrs[k];
    return undefined;
  }

  function row(dl, label, value, cls) {
    var dt = document.createElement("dt"); dt.textContent = label;
    var dd = document.createElement("dd"); dd.textContent = value;
    if (cls) dd.className = cls;
    dl.appendChild(dt); dl.appendChild(dd);
  }

  function renderPanels() {
    if (!payload) return;
    var snap = payload.snapshot;
    var m = snap.metrics;

    var metrics = el("metrics");
    metrics.innerHTML = "";
    row(metrics, "participants", String(m.n));
    row(metrics, "ties", String(m.edgeCount));
    row(metrics, "density", m.density.toFixed(3));
    row(metrics, "components", String(m.components), m.components > 1 ? "warn" : "");
    row(metrics, "isolated", String(m.isolated.length), m.isolated.length ? "warn" : "");
    row(metrics, "degree min/mean/max",
      m.minDegree + " / " + m.meanDegree.toFixed(1) + " / " + m.maxDegree);

    var ops = el("ops");
    ops.innerHTML = "";
    row(ops, "publishes", String(snap.seq));
    row(ops, "seed", String(snap.seed));
    row(ops, "history events", String(snap.history.frames.length));
    row(ops, "channels pending", String(snap.pendingChannels.length),
      snap.pendingChannels.length ? "alert" : "");
    row(ops, "awaiting publish", snap.awaitingPublish ? "yes" : "no",
      snap.awaitingPublish ? "warn" : "");
    row(ops, "history consistent", snap.history.consistent ? "yes" : "NO",
      snap.history.consistent ? "" : "alert");
    if (snap.history.dropped) row(ops, "unmapped pairs", String(snap.history.dropped), "alert");

    // A stalled game is the failure an operator cannot see from inside the
    // study: one missing channel blocks EVERY view, not just its owner's.
    if (snap.pendingChannels.length) {
      banner(snap.pendingChannels.length + " participant(s) have no channel scope yet. " +
        "publish() refuses to send a partial view, so NOBODY in this game is receiving updates.");
    } else if (!snap.history.consistent) {
      banner("The edge history does not add up: the log's own counts disagree with replaying it. " +
        "Treat the scrubber and the exported snapshots with suspicion.");
    } else {
      banner("");
    }

    var legend = el("legend");
    legend.innerHTML = "";
    var scale = colorScale(snap.nodes);
    if (!colorKey || scale.values.length === 0) {
      legend.innerHTML = "<div class='k'>no watched value to color by</div>";
    } else {
      for (var i = 0; i < scale.values.length; i++) {
        var d = document.createElement("div");
        var sw = document.createElement("span");
        sw.className = "swatch";
        sw.style.background = scale.map[scale.values[i]] || "var(--muted)";
        var lb = document.createElement("span");
        lb.textContent = scale.values[i] + (i >= SLOTS.length ? " (other)" : "");
        d.appendChild(sw); d.appendChild(lb);
        legend.appendChild(d);
      }
      if (scale.values.length > SLOTS.length) {
        var note = document.createElement("div");
        note.className = "k";
        note.textContent = "beyond 3 values colors repeat as \\u2018other\\u2019 \\u2014 read the labels";
        legend.appendChild(note);
      }
    }

    var detail = el("detail");
    if (selected === null || !snap.nodes[selected]) {
      detail.className = "k";
      detail.textContent = "click a node";
    } else {
      var node = snap.nodes[selected];
      detail.className = "";
      var dl = document.createElement("dl");
      row(dl, "seat", String(node.index));
      row(dl, "player", node.playerID);
      row(dl, "degree", String(node.degree));
      row(dl, "neighbors", node.neighbors.join(", ") || "\\u2014");
      row(dl, "channel", node.channel ? "yes" : "NO", node.channel ? "" : "alert");
      for (var w = 0; w < snap.watch.length; w++) {
        row(dl, snap.watch[w], text(valueOfKey(node, snap.watch[w])));
      }
      detail.innerHTML = "";
      detail.appendChild(dl);
    }

    renderTable(snap);
  }

  // The table view is the accessibility relief for the sub-3:1 light slot, and
  // the thing to copy out of when something looks wrong.
  function renderTable(snap) {
    var host = el("tableView");
    var head = "<tr><th>seat</th><th>player</th><th class='num'>degree</th>" +
      "<th>neighbors</th><th>channel</th>";
    for (var i = 0; i < snap.watch.length; i++) head += "<th>" + snap.watch[i] + "</th>";
    head += "</tr>";
    var body = "";
    for (var n = 0; n < snap.nodes.length; n++) {
      var node = snap.nodes[n];
      body += "<tr><td class='num'>" + node.index + "</td><td>" + node.playerID +
        "</td><td class='num'>" + node.degree + "</td><td>" + node.neighbors.join(" ") +
        "</td><td>" + (node.channel ? "yes" : "NO") + "</td>";
      for (var k = 0; k < snap.watch.length; k++) {
        body += "<td>" + text(valueOfKey(node, snap.watch[k])) + "</td>";
      }
      body += "</tr>";
    }
    host.innerHTML = "<table>" + head + body + "</table>";
  }

  function renderScrub() {
    var scrub = el("scrub");
    var label = el("scrubLabel");
    var mode = el("mode");
    if (!payload) {
      // Reset the range too, so a game that has gone does not leave a thumb
      // parked partway along a history that is no longer on the page.
      scrub.max = "0"; scrub.value = "0";
      label.textContent = "no history";
      return;
    }
    var frames = payload.snapshot.history.frames;
    scrub.max = String(Math.max(frames.length - 1, 0));
    if (frameIndex === null) {
      scrub.value = String(Math.max(frames.length - 1, 0));
      mode.className = "badge live";
      mode.textContent = "live";
      el("liveBtn").disabled = true;
      label.textContent = frames.length + " event(s) \\u00b7 following live";
    } else {
      var f = frames[frameIndex];
      mode.className = "badge history";
      mode.textContent = "history";
      el("liveBtn").disabled = false;
      label.textContent = "event " + (frameIndex + 1) + "/" + frames.length + " \\u00b7 " +
        f.op + " \\u00b7 " + f.edges.length + " ties \\u00b7 " +
        new Date(f.t).toLocaleTimeString();
    }
  }

  function setColorKeys(snap) {
    var sel = el("colorKey");
    var wanted = snap.watch.slice();
    var current = Array.prototype.map.call(sel.options, function (o) { return o.value; });
    if (current.length === wanted.length + 1 && wanted.every(function (k, i) { return current[i + 1] === k; })) return;
    sel.innerHTML = "";
    var none = document.createElement("option");
    none.value = ""; none.textContent = "(none)";
    sel.appendChild(none);
    for (var i = 0; i < wanted.length; i++) {
      var o = document.createElement("option");
      o.value = wanted[i]; o.textContent = wanted[i];
      sel.appendChild(o);
    }
    if (colorKey === null && wanted.length) colorKey = wanted[0];
    sel.value = colorKey || "";
  }

  function apply(next) {
    payload = next;
    // Undo what gone() disabled. A game can come back — the operator switches
    // games in the picker, or a stream reopens on a game this process still
    // holds — and a monitor stuck with a dead scrubber would need a reload.
    el("scrub").disabled = false;
    setColorKeys(next.snapshot);
    el("gameLabel").textContent = next.snapshot.gameID;
    renderScrub();
    render();
    renderPanels();
  }

  function gone(info) {
    var mode = el("mode");
    mode.className = "badge gone";
    mode.textContent = "gone";

    // Deliberately not "keep showing the last picture". A full restart never
    // reassigns players to their game, so there is nothing to reconnect
    // to, and a stale graph presented as live is worse than an honest gap.
    //
    // The DATA goes, not just the label. Dropping the payload is what makes
    // that true — an operator who scrolled past the banner, or who is on the
    // table view, would otherwise read a picture of a study that has stopped as
    // the current state of one that is running, which is the misreport
    // the "gone" state exists to prevent. Note that the table holds the same
    // complete seating plan the graph does and has to be cleared with it.
    payload = null;
    frameIndex = null;
    selected = null;
    render();
    renderScrub();
    el("scrub").disabled = true;
    el("liveBtn").disabled = true;
    el("metrics").innerHTML = "";
    el("ops").innerHTML = "";
    el("legend").innerHTML = "";
    el("tableView").innerHTML = "";
    el("detail").className = "k";
    el("detail").textContent = "";

    banner("This process is no longer networking game " + (info && info.gameID ? info.gameID : "") +
      ". The game has ended, or a restart lost it \\u2014 a full server restart does not put " +
      "participants back into their game, so there is nothing to reconnect to.");
  }

  // A batch normally runs several games at once, and without this the operator
  // silently gets whichever one the server listed first. Hidden for the common
  // single-game case rather than shown as a control with one option.
  function loadGames() {
    fetch(url("/api/games"))
      .then(function (r) { return r.json(); })
      .then(function (body) {
        var sel = el("gamePicker");
        var games = body.games || [];
        if (games.length < 2) { sel.style.display = "none"; return; }
        var current = gameParam || (payload ? payload.snapshot.gameID : games[0]);
        if (sel.options.length === games.length && sel.value === current) return;
        sel.innerHTML = "";
        for (var i = 0; i < games.length; i++) {
          var o = document.createElement("option");
          o.value = games[i]; o.textContent = games[i];
          sel.appendChild(o);
        }
        sel.value = current;
        sel.style.display = "";
      })
      .catch(function () { /* the state stream already reports a dead endpoint */ });
  }
  loadGames();
  setInterval(loadGames, 5000);

  el("gamePicker").addEventListener("change", function (ev) {
    location.search = "?t=" + encodeURIComponent(token) +
      "&game=" + encodeURIComponent(ev.target.value);
  });

  el("colorKey").addEventListener("change", function (ev) {
    colorKey = ev.target.value || null;
    render(); renderPanels();
  });
  el("scrub").addEventListener("input", function (ev) {
    var frames = payload ? payload.snapshot.history.frames : [];
    var v = Number(ev.target.value);
    frameIndex = v >= frames.length - 1 ? null : v;
    renderScrub(); render();
  });
  el("liveBtn").addEventListener("click", function () {
    frameIndex = null; renderScrub(); render();
  });
  el("tableToggle").addEventListener("click", function () {
    el("tableView").classList.toggle("on");
  });

  fetch(url("/api/state"))
    .then(function (r) { return r.json(); })
    .then(function (body) { if (body.gone) gone(body); else apply(body); })
    .catch(function (e) { banner("could not load state: " + e.message); });

  var es = new EventSource(url("/api/stream"));
  es.addEventListener("state", function (ev) { apply(JSON.parse(ev.data)); });
  es.addEventListener("gone", function (ev) { gone(JSON.parse(ev.data)); });
  es.onerror = function () {
    // Say so. A monitor that quietly stops updating is indistinguishable from a
    // study in which nothing is happening, which is the failure mode this whole
    // package is written against.
    banner("Lost the event stream. The graph below is frozen at the last update received.");
  };
})();
</script>
</body>
</html>
`;
