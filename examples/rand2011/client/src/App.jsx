import { EmpiricaContext } from "@empirica/core/player/classic/react";
import { EmpiricaMenu, EmpiricaParticipant } from "@empirica/core/player/react";
// was: import { EmpiricaClassic } from "@empirica/core/player/classic";
//
// EmpiricaNetwork is a SUPERSET of EmpiricaClassic — it composes it rather than
// replacing it — so usePlayer, useGame, useStage and the rest keep working
// exactly as before. It just adds the private neighbourhood channel.
import { EmpiricaNetwork } from "empirica-networks/player";
import React from "react";
import { Game } from "./Game";
import { ExitSurvey } from "./intro-exit/ExitSurvey";
import { Introduction } from "./intro-exit/Introduction";

export default function App() {
  const urlParams = new URLSearchParams(window.location.search);
  const playerKey = urlParams.get("participantKey") || "";

  const { protocol, host } = window.location;
  const url = `${protocol}//${host}/query`;

  function introSteps() {
    return [Introduction];
  }

  function exitSteps() {
    return [ExitSurvey];
  }

  return (
    <EmpiricaParticipant url={url} ns={playerKey} modeFunc={EmpiricaNetwork}>
      <div className="h-screen relative">
        <EmpiricaMenu position="bottom-left" />
        <div className="h-full overflow-auto">
          <EmpiricaContext introSteps={introSteps} exitSteps={exitSteps}>
            <Game />
          </EmpiricaContext>
        </div>
      </div>
    </EmpiricaParticipant>
  );
}
