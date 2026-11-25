// Copied into the managed Paseo 0.17.4 runtime as hermes-paseo-brand-identity.mjs and
// imported by its websocket server, so it must stay self-contained (no imports).
// The managed daemon takes its identity from the host's selected target, never from a
// remote client's hello. Activation supplies this variable; a target change takes effect
// only when the daemon is stopped and started again.
const brands = Object.freeze({
  paseo: Object.freeze({ id: 'paseo', name: 'Paseo' }),
  woowtech: Object.freeze({ id: 'woowtech', name: 'Woowtech Smart' }),
  apporo: Object.freeze({ id: 'apporo', name: 'Apporo Smart' }),
});
export function selectedBrand(target = process.env.HERMES_PASEO_CONNECTION_TARGET ?? 'paseo') {
  if (!Object.hasOwn(brands, target)) throw Object.assign(new Error('INVALID_CONNECTION_TARGET'), { code: 'INVALID_CONNECTION_TARGET' });
  return brands[target];
}
export const hermesPaseoBrand = selectedBrand();
