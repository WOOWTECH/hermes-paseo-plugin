import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, assertSafePath, RuntimeError } from './state.mjs';

// The same three connection profiles as Agent Connect (WOOWTECH/pi-paseo-plugin). Each pairs one
// fixed web app with its own TLS relay; no caller supplies an origin or an endpoint. The Python
// bridge (hermes_paseo.py TARGETS) and the Dashboard (dashboard/dist/index.js TARGETS) carry the
// same rows; tests/target-parity.test.mjs fails when any of them drifts.
export const CONNECTION_TARGETS = Object.freeze([
  Object.freeze({ id: 'paseo', label: 'Paseo', appUrl: 'https://app.paseo.sh', relayEndpoint: 'relay.paseo.sh:443' }),
  Object.freeze({ id: 'woowtech', label: 'Woowtech Smart', appUrl: 'https://smart.woowtech.io', relayEndpoint: 'relay.woowtech.io:443' }),
  Object.freeze({ id: 'apporo', label: 'Apporo Smart', appUrl: 'https://smart.apporo.ai', relayEndpoint: 'relay.apporo.ai:443' }),
]);
export const DEFAULT_TARGET = 'paseo';

/** One of the three rows. Anything else, including a missing id, is INVALID_TARGET: never mapped to another row. */
export function connectionTarget(id) {
  const target = typeof id === 'string' ? CONNECTION_TARGETS.find(row => row.id === id) : undefined;
  if (!target) throw new RuntimeError('INVALID_TARGET');
  return target;
}

// The choice lives in its own file. preferences.json is read by the 0.1.4 releases, and rc.9 refuses to
// start on a record without a display name: a rollback has to keep working, so it is never written.
const connectionFile = loc => path.join(loc.stateDir, 'connection.json');
const MAX_RECORD_BYTES = 4096;

/** The saved target; Paseo when nothing was ever saved. A damaged record fails closed instead of reading as Paseo. */
export function selectedTarget(loc) {
  const file = connectionFile(loc);
  let record;
  try {
    assertSafePath(file);
    const bytes = fs.readFileSync(file);
    if (bytes.length > MAX_RECORD_BYTES) throw new RuntimeError('CONNECTION_STATE_CORRUPT');
    record = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return DEFAULT_TARGET;
    throw new RuntimeError(error.code === 'UNSAFE_SYMLINK' ? 'UNSAFE_SYMLINK' : 'CONNECTION_STATE_CORRUPT');
  }
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.version !== 1 ||
      Object.keys(record).some(key => !['version', 'target'].includes(key)) ||
      !CONNECTION_TARGETS.some(row => row.id === record.target)) throw new RuntimeError('CONNECTION_STATE_CORRUPT');
  return record.target;
}

/** Records the choice (private file, atomic replace). It is the only thing written: nothing about the daemon changes here. */
export function saveSelectedTarget(loc, target) {
  atomicJson(connectionFile(loc), { version: 1, target: connectionTarget(target).id });
}

const managedOrigins = new Set(CONNECTION_TARGETS.map(row => row.appUrl));
const managed = origin => managedOrigins.has(origin.trim().replace(/\/+$/, ''));

/**
 * The daemon configuration for one target: its web app, its relay (the endpoint and the public endpoint
 * alike, with TLS stated explicitly) and its web app's origin among the CORS origins. Everything else is
 * kept as it is, including origins that no target manages. Switching a Smart target therefore passes
 * through this table again and overwrites a custom relay or app URL; that is documented in the README.
 * `daemon.relay.requireProtectedSecurity` is deliberately never written: Paseo 0.11.2's strict schema does
 * not know it and would reject the whole file.
 */
export function targetConfiguration(config, target) {
  const profile = connectionTarget(target);
  const origins = config.daemon?.cors?.allowedOrigins ?? [];
  if (!Array.isArray(origins) || origins.some(origin => typeof origin !== 'string')) throw new RuntimeError('CONFIG_INVALID');
  return {
    ...config,
    app: { ...config.app, baseUrl: profile.appUrl },
    daemon: {
      ...config.daemon,
      relay: { ...config.daemon?.relay, enabled: true, endpoint: profile.relayEndpoint, publicEndpoint: profile.relayEndpoint, useTls: true, publicUseTls: true },
      cors: { ...config.daemon?.cors, allowedOrigins: [...origins.filter(origin => !managed(origin)), profile.appUrl] },
    },
  };
}
