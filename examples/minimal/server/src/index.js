import { AdminContext } from "@empirica/core/admin";
import { Classic, ClassicLoader, Lobby } from "@empirica/core/admin/classic";
import { info, setLogLevel } from "@empirica/core/console";
// THE MANDATORY EDIT. `networkKinds` is `classicKinds` plus the `nbhd` scope
// kind — the per-participant private channel. Without it the channels are never
// modelled, there is nothing to write views to, and nothing errors: participants
// simply sit with empty neighbourhoods forever.
import { networkKinds } from "empirica-networks/admin";
import minimist from "minimist";
import process from "process";
import { Empirica, net } from "./callbacks";

const argv = minimist(process.argv.slice(2), { string: ["token"] });

setLogLevel(argv["loglevel"] || "info");

(async () => {
  const ctx = await AdminContext.init(
    argv["url"] || "http://localhost:3000/query",
    argv["sessionTokenPath"],
    "callbacks",
    argv["token"],
    {},
    // was: classicKinds
    networkKinds
  );

  ctx.register(ClassicLoader);
  ctx.register(Classic());
  ctx.register(Lobby());
  ctx.register(Empirica);
  ctx.register(function (_) {
    _.on("ready", function () {
      info("server: started");
    });
  });

  /**
   * The live network monitor. OFF unless asked for.
   *
   * It shows the COMPLETE graph — every tie, every seat assignment, and every
   * participant's private state — which is exactly what this package exists to
   * keep away from the people inside the study. So it is opt-in, it binds to
   * loopback, and it prints a URL carrying a fresh token each run.
   *
   *   MONITOR=1 npm run dev        then open the printed URL
   *
   * It holds no Empirica credential: it reads this process's own memory and
   * serves JSON. That matters because there is no write access control in
   * Empirica (see the module's ISSUES.md U1), so an admin token in a browser
   * would be unlimited write access over every participant's data, not just a
   * read-only view. Never put one there.
   */
  if (process.env["MONITOR"]) {
    const { monitor } = await import("empirica-networks/admin/monitor");
    await monitor(net);
  }
})();

process.on("unhandledRejection", function (reason, p) {
  process.exitCode = 1;
  console.error("Unhandled Promise Rejection. Reason: ", reason);
});
