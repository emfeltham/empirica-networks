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
import { Empirica } from "./callbacks";

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
})();

process.on("unhandledRejection", function (reason, p) {
  process.exitCode = 1;
  console.error("Unhandled Promise Rejection. Reason: ", reason);
});
