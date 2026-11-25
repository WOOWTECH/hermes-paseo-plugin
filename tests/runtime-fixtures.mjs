// Shared test fixtures. Not a test file itself: `node --test tests/*.test.mjs` does not pick it up.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const KEYS = ['HOME', 'HERMES_HOME', 'HERMES_PASEO_STATE_DIR', 'HERMES_PASEO_RUNTIME_DIR', 'HERMES_PASEO_PORT', 'PASEO_HOME',
  'HERMES_PASEO_CONNECTION_TARGET'];

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
