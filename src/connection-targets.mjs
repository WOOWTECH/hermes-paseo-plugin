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

/**
 * What the saved record says. `saved: false` means nobody ever saved a target: the plugin is in legacy mode,
 * behaves exactly as 0.1.4-rc.9 did and shows Paseo. `saved: true` is the managed mode that an explicit save
 * (Paseo included) switches on. A record that exists but cannot be read fails closed (CONNECTION_STATE_CORRUPT,
 * UNSAFE_SYMLINK): it is neither the legacy default nor Paseo.
 */
export function savedConnection(loc) {
  const file = connectionFile(loc);
  let record;
  try {
    assertSafePath(file);
    const bytes = fs.readFileSync(file);
    if (bytes.length > MAX_RECORD_BYTES) throw new RuntimeError('CONNECTION_STATE_CORRUPT');
    record = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { saved: false, target: DEFAULT_TARGET };
    throw new RuntimeError(error.code === 'UNSAFE_SYMLINK' ? 'UNSAFE_SYMLINK' : 'CONNECTION_STATE_CORRUPT');
  }
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.version !== 1 ||
      Object.keys(record).some(key => !['version', 'target'].includes(key)) ||
      !CONNECTION_TARGETS.some(row => row.id === record.target)) throw new RuntimeError('CONNECTION_STATE_CORRUPT');
  return { saved: true, target: record.target };
}

/** The selected target; Paseo when nothing was ever saved. */
export function selectedTarget(loc) { return savedConnection(loc).target; }

// The Smart apps refuse a daemon whose hello carries no brand, so only they need the runtime patch. The official Paseo
// app ignores the extra field, and Paseo needs nothing: a patched runtime is simply left alone for it.
const BRANDED_TARGETS = Object.freeze(['woowtech', 'apporo']);
export const requiresBrand = target => BRANDED_TARGETS.includes(connectionTarget(target).id);

/** Records the choice (private file, atomic replace). It is the only thing written: nothing about the daemon changes here. */
export function saveSelectedTarget(loc, target) {
  atomicJson(connectionFile(loc), { version: 1, target: connectionTarget(target).id });
}

const managedOrigins = new Set(CONNECTION_TARGETS.map(row => row.appUrl));
/**
 * Is this CORS entry one of the three apps' own origin? Compared the way a browser would (scheme and host ignore case, the
 * default port and trailing slashes do not matter), but only for a bare origin: an entry with a path, query or user
 * information is somebody else's setting and stays. Linear in the length: trailing slashes are counted, never re-scanned.
 */
function managed(entry) {
  const text = entry.trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === '/') end--;
  let url;
  try { url = new URL(text.slice(0, end)); } catch { return false; }
  return url.href === url.origin + '/' && managedOrigins.has(url.origin);
}

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

/**
 * The daemon's own pairing link for `target`, unchanged. Only the exact web app of the target, path `/` and a
 * `#offer=` fragment are accepted, and the offer it carries must be a version 2 offer for this daemon (server
 * id and public key present) naming this target's relay endpoint with TLS: a link for another relay, or one
 * without TLS, would pair a device with something else (that relay check is what `legacy` relaxes, see below). Offers that demand a minimum security mode cannot be
 * answered by the Smart apps (they speak the relay encryption of Paseo 0.10); 0.11.2 sends none, so this is
 * defensive only.
 */
export function targetPairUrl(official, target, { legacy = false } = {}) {
  const profile = connectionTarget(target);
  if (typeof official !== 'string' || official.length > 16384 || /[\s\\]/.test(official)) throw new RuntimeError('PAIRING_ORIGIN_INVALID');
  let url;
  try { url = new URL(official); } catch { throw new RuntimeError('PAIRING_ORIGIN_INVALID'); }
  if (url.origin !== profile.appUrl || url.username || url.password || url.pathname !== '/' || url.search || !/^#offer=[A-Za-z0-9_-]+$/.test(url.hash)) throw new RuntimeError('PAIRING_ORIGIN_INVALID');
  let offer;
  try { offer = JSON.parse(Buffer.from(url.hash.slice(7), 'base64url').toString('utf8')); }
  catch { throw new RuntimeError('PAIRING_OFFER_INVALID'); }
  if (offer?.v !== 2 || typeof offer.serverId !== 'string' || !offer.serverId || typeof offer.daemonPublicKeyB64 !== 'string' || !offer.daemonPublicKeyB64) throw new RuntimeError('PAIRING_TARGET_MISMATCH');
  // Legacy mode (no target ever saved) pairs as 0.1.4-rc.9 did: the app is checked, the relay is whatever the daemon is
  // configured with (a tenant may run its own). Once a target is saved, its relay and TLS must match exactly.
  if (!legacy && (offer.relay?.endpoint !== profile.relayEndpoint || offer.relay?.useTls !== true)) throw new RuntimeError('PAIRING_TARGET_MISMATCH');
  if (profile.id !== DEFAULT_TARGET && offer.minimumSecurityMode !== undefined) throw new RuntimeError('PAIRING_SECURITY_UNSUPPORTED');
  return `${profile.appUrl}/${url.hash}`;
}
