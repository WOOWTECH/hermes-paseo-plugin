import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, assertSafePath, RuntimeError } from './state.mjs';

// The same three connection profiles as Agent Connect (WOOWTECH/pi-paseo-plugin 0.1.24).
// Each pairs a fixed official web app with its own TLS relay; no caller supplies an origin.
export const CONNECTION_TARGETS = Object.freeze([
  Object.freeze({ id: 'paseo', label: 'Paseo', appUrl: 'https://app.paseo.sh', relayEndpoint: 'relay.paseo.sh:443' }),
  Object.freeze({ id: 'woowtech', label: 'Woowtech Smart', appUrl: 'https://smart.woowtech.io', relayEndpoint: 'relay.woowtech.io:443' }),
  Object.freeze({ id: 'apporo', label: 'Apporo Smart', appUrl: 'https://smart.apporo.ai', relayEndpoint: 'relay.apporo.ai:443' }),
]);
export const DEFAULT_TARGET = 'paseo';

export function connectionTarget(id = DEFAULT_TARGET) {
  const target = CONNECTION_TARGETS.find(row => row.id === id);
  if (!target) throw new RuntimeError('INVALID_TARGET');
  return target;
}

// The choice lives in its own file. preferences.json is read by 0.1.4 releases, which
// reject any record without a display name: a rollback must keep working.
const connectionFile = loc => path.join(loc.stateDir, 'connection.json');

/** The saved target; Paseo when nothing was ever saved. A damaged record fails closed. */
export function selectedTarget(loc) {
  const file = connectionFile(loc);
  let record;
  try {
    assertSafePath(file);
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return DEFAULT_TARGET;
    throw new RuntimeError(error.code === 'UNSAFE_SYMLINK' ? 'UNSAFE_SYMLINK' : 'CONNECTION_STATE_CORRUPT');
  }
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.version !== 1 ||
      Object.keys(record).some(key => !['version', 'target'].includes(key)) ||
      !CONNECTION_TARGETS.some(row => row.id === record.target)) throw new RuntimeError('CONNECTION_STATE_CORRUPT');
  return record.target;
}

export function saveSelectedTarget(loc, target) {
  atomicJson(connectionFile(loc), { version: 1, target: connectionTarget(target).id });
}

const managedOrigins = new Set(CONNECTION_TARGETS.map(row => row.appUrl));
const managed = origin => managedOrigins.has(String(origin).trim().replace(/\/$/, ''));

/**
 * Settings environment for the CLI and daemon. A managed `paseo daemon start` drops the
 * PASEO_* settings keys before it launches the supervisor (0.11.2 and 0.17.4 alike), so the
 * daemon itself is configured by targetConfiguration(); the target id is not a Paseo setting
 * and reaches the daemon, where the brand identity reads it.
 * Operator CORS origins that are not one of the three official apps are kept.
 */
export function targetEnvironment(target, inheritedCorsOrigins = '') {
  const profile = connectionTarget(target);
  const kept = String(inheritedCorsOrigins || '').split(',').map(value => value.trim()).filter(value => value && !managed(value));
  return {
    HERMES_PASEO_CONNECTION_TARGET: profile.id,
    PASEO_APP_BASE_URL: profile.appUrl,
    PASEO_RELAY_ENABLED: 'true',
    PASEO_RELAY_ENDPOINT: profile.relayEndpoint,
    PASEO_RELAY_PUBLIC_ENDPOINT: profile.relayEndpoint,
    PASEO_RELAY_USE_TLS: 'true',
    PASEO_RELAY_PUBLIC_USE_TLS: 'true',
    PASEO_CORS_ORIGINS: [...new Set([...kept, profile.appUrl])].join(','),
  };
}

/** Daemon config for one target. Unrelated CORS origins and relay keys are kept as they are. */
export function targetConfiguration(config, target) {
  const profile = connectionTarget(target);
  const origins = config.daemon?.cors?.allowedOrigins || [];
  if (!Array.isArray(origins) || origins.some(origin => typeof origin !== 'string')) throw new RuntimeError('CONFIG_INVALID');
  return {
    ...config,
    app: { ...config.app, baseUrl: profile.appUrl },
    daemon: {
      ...config.daemon,
      relay: { ...config.daemon?.relay, enabled: true, endpoint: profile.relayEndpoint, publicEndpoint: profile.relayEndpoint, useTls: true, publicUseTls: true },
      cors: { ...config.daemon?.cors, allowedOrigins: [...new Set([...origins.filter(origin => !managed(origin)), profile.appUrl])] },
    },
  };
}

/**
 * The daemon's official pairing link for `target`, unchanged. Only the exact app origin, path
 * `/` and a V2 `#offer=` fragment naming this target's TLS relay are accepted. Smart apps speak
 * the older relay encryption, so an offer that demands protected security cannot pair with them.
 */
export function targetPairUrl(official, target = DEFAULT_TARGET) {
  const profile = connectionTarget(target);
  if (typeof official !== 'string' || official.length > 16384 || /[\s\\]/.test(official)) throw new RuntimeError('PAIRING_ORIGIN_INVALID');
  let url;
  try { url = new URL(official); } catch { throw new RuntimeError('PAIRING_ORIGIN_INVALID'); }
  if (url.origin !== profile.appUrl || url.username || url.password || url.pathname !== '/' || url.search || !/^#offer=[A-Za-z0-9_-]+$/.test(url.hash)) throw new RuntimeError('PAIRING_ORIGIN_INVALID');
  let offer;
  try { offer = JSON.parse(Buffer.from(url.hash.slice(7), 'base64url').toString('utf8')); }
  catch { throw new RuntimeError('PAIRING_OFFER_INVALID'); }
  if (offer?.v !== 2 || typeof offer.serverId !== 'string' || !offer.serverId || typeof offer.daemonPublicKeyB64 !== 'string' || !offer.daemonPublicKeyB64 ||
      offer.relay?.endpoint !== profile.relayEndpoint || offer.relay?.useTls !== true) throw new RuntimeError('PAIRING_TARGET_MISMATCH');
  if (profile.id !== 'paseo' && offer.minimumSecurityMode !== undefined) throw new RuntimeError('PAIRING_SECURITY_UNSUPPORTED');
  return `${profile.appUrl}/${url.hash}`;
}
