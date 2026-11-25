// Shared test fixtures. Not a test file itself: `node --test tests/*.test.mjs` does not pick it up.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';

const KEYS = ['HOME', 'HERMES_HOME', 'HERMES_PASEO_STATE_DIR', 'HERMES_PASEO_RUNTIME_DIR', 'HERMES_PASEO_PORT', 'PASEO_HOME',
  'HERMES_PASEO_CONNECTION_TARGET', 'HERMES_PASEO_HERMES_COMMAND', 'PATH', 'FAKE_PASEO_SERVER_FILE', 'FAKE_PASEO_TRACE', 'FAKE_PASEO_OFFER_EXTRA'];

/** An isolated profile (HOME, HERMES_HOME, state and runtime directories) removed again by close(). */
export function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-paseo-fixture-'));
  const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  process.env.HOME = path.join(dir, 'home'); process.env.HERMES_HOME = path.join(dir, 'agent');
  process.env.HERMES_PASEO_STATE_DIR = path.join(dir, 'state'); process.env.HERMES_PASEO_RUNTIME_DIR = path.join(dir, 'runtime');
  delete process.env.HERMES_PASEO_PORT; delete process.env.PASEO_HOME; delete process.env.HERMES_PASEO_CONNECTION_TARGET;
  return {
    dir,
    close() {
      for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The exact upstream Paseo 0.11.2 websocket server (dist/server/server/websocket-server.js), as published. */
export const websocketServerSource = () => gunzipSync(fs.readFileSync(new URL('./fixtures/paseo-0.11.2/websocket-server.js.gz', import.meta.url))).toString('utf8');
export const fixtureProvenance = () => JSON.parse(fs.readFileSync(new URL('./fixtures/paseo-0.11.2/provenance.json', import.meta.url), 'utf8'));
