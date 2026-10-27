import { RuntimeError } from './state.mjs';

/** Paseo may silently keep an ACP provider's default when a model switch fails. */
export function requireHermesModel(agent, requestedModel) {
  if (!requestedModel || agent?.runtimeInfo?.model !== requestedModel) {
    throw new RuntimeError('MODEL_SELECTION_UNAVAILABLE');
  }
}

/** Send a turn only after the live ACP session reports the requested model. */
export async function sendVerifiedHermesMessage(client, agent, requestedModel, message) {
  requireHermesModel(agent, requestedModel);
  await client.sendAgentMessage(agent.id, message);
}
