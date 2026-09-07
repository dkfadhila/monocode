import {
  bindHermesSession,
  cancelHermesTurn,
  forgetHermesSession,
  respondHermesApproval,
  respondHermesQuestion,
  sendHermesTurn,
  steerHermesTurn,
  stopHermesSession,
} from "./hermes";
import { registerHarness, type HarnessAdapter } from "./registry";

export const hermesAdapter: HarnessAdapter = {
  id: "hermes",
  live: true,
  respondQuestion: respondHermesQuestion,
  sendTurn: sendHermesTurn,
  steerTurn: steerHermesTurn,
  cancelTurn: cancelHermesTurn,
  respondApproval: respondHermesApproval,
  stopSession: stopHermesSession,
  forgetSession: forgetHermesSession,
  bindSession: bindHermesSession,
  // Hermes is provider-agnostic — model catalog comes from user config,
  // not CLI probe. The default catalog in hermesCatalog.ts covers common
  // models. Users can add custom models via ~/.hermes/config.yaml.
  //
  // Future: implement refreshCatalog by parsing `hermes config` output,
  // and generateTitle via `hermes chat -q "generate a title for: ..."`.
};

let registered = false;

export function ensureHermesRegistered(): void {
  if (registered) return;
  registerHarness(hermesAdapter);
  registered = true;
}
