// Copied into the managed Paseo 0.11.2 runtime as hermes-paseo-brand-identity.mjs and imported by its
// websocket server, so it must stay self-contained (no imports).
// The Woowtech and Apporo Smart apps require the daemon's hello to carry a brand identity, and the daemon
// takes it from the target this plugin selected, never from a remote client's hello. Activation supplies
// the variable (its name does not start with PASEO_: a managed `daemon start` strips those), and a target
// change reaches the daemon only when it is stopped and started again.
const brands = Object.freeze({
  paseo: Object.freeze({ id: 'paseo', name: 'Paseo' }),
  woowtech: Object.freeze({ id: 'woowtech', name: 'Woowtech Smart' }),
  apporo: Object.freeze({ id: 'apporo', name: 'Apporo Smart' }),
});
export function selectedBrand(target = process.env.HERMES_PASEO_CONNECTION_TARGET ?? 'paseo') {
  if (!Object.hasOwn(brands, target)) throw Object.assign(new Error('INVALID_CONNECTION_TARGET'), { code: 'INVALID_CONNECTION_TARGET' });
  return brands[target];
}
export const agentConnectBrand = selectedBrand();
