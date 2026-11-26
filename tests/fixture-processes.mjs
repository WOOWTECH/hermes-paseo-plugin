// Unit fixtures own a small process universe, not the runner's systemd/user services.
// Keep real /proc metadata for that universe; production still examines every same-UID process.
import fs from 'node:fs';
import path from 'node:path';
import { runtimeProcessTable } from '../src/runtime-processes.mjs';

export const SCOPE_ENV = 'HERMES_PASEO_TEST_PROCESS_SCOPE';
const realOwner = runtimeProcessTable.owner;
const scopes = new Set();
const outsideUid = () => process.getuid() + 1;

function scopedOwner(base) {
  if (!scopes.size) return realOwner(base);
  const uid = realOwner(base);
  if (uid !== process.getuid()) return uid;
  const pid = Number(path.basename(base));
  for (const scope of scopes) {
    // A newly detached fake daemon can outlive its CLI before this scan first sees it.
    try {
      const record = JSON.parse(fs.readFileSync(path.join(scope.dir, 'state/daemon/paseo.pid'), 'utf8'));
      if (Number.isInteger(record.pid) && record.pid > 1) scope.pids.add(record.pid);
    } catch { /* No fixture daemon has published a PID yet. */ }
    if (scope.pids.has(pid)) return uid;
  }
  let env;
  try { env = fs.readFileSync(path.join(base, 'environ'), 'utf8').split('\0'); }
  catch (error) {
    // Membership is established independently for explicitly registered children/daemons.
    // Inaccessible ambient processes are outside this unit fixture, never a production exemption.
    if (['EACCES', 'EPERM', 'ENOENT', 'ESRCH'].includes(error.code)) return outsideUid();
    throw error;
  }
  for (const scope of scopes) {
    if (env.includes(`${SCOPE_ENV}=${scope.dir}`)) {
      scope.pids.add(pid); // Once selected, subsequent metadata failures reach the real guard.
      return uid;
    }
  }
  return outsideUid();
}

export function isolateFixtureProcesses(dir) {
  const previous = runtimeProcessTable.owner;
  const scope = { dir, pids: new Set([process.pid]) };
  scopes.add(scope); runtimeProcessTable.owner = scopedOwner;
  return {
    track(pid) { if (Number.isInteger(pid) && pid > 1) scope.pids.add(pid); },
    close() {
      scopes.delete(scope);
      if (!scopes.size && runtimeProcessTable.owner === scopedOwner) runtimeProcessTable.owner = previous === scopedOwner ? realOwner : previous;
    },
  };
}

// Only explicit `node --import tests/fixture-processes.mjs ...` opts a CLI test in.
if (process.env[SCOPE_ENV]) isolateFixtureProcesses(process.env[SCOPE_ENV]);
