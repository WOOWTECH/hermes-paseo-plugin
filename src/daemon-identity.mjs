import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// Linux boot IDs survive a container restart, while PID namespaces do not.
// A process born well after the lock's timestamp cannot be its original owner.
export function linuxProcessBirth(pid) {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 1) return null;
  try {
    const result = spawnSync('/usr/bin/getconf', ['CLK_TCK'], {
      encoding: 'utf8', timeout: 1000, maxBuffer: 1024, shell: false,
    });
    const ticks = Number(result.stdout?.trim());
    if (result.status !== 0 || !Number.isFinite(ticks) || ticks <= 0) return null;
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const start = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    const boot = Number(/^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'))?.[1]);
    return Number.isFinite(start) && Number.isFinite(boot) ? boot * 1000 + start * 1000 / ticks : null;
  } catch { return null; }
}

export function demonstrablyReusedPid(instance, birth = linuxProcessBirth(instance?.pid)) {
  const recorded = Date.parse(instance?.startedAt);
  return Number.isFinite(birth) && Number.isFinite(recorded) && birth > recorded + 60000;
}

export function linuxContainerIdentity() {
  if (process.platform !== 'linux') return null;
  try {
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = fs.readFileSync('/proc/1/stat', 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return /^[0-9a-f-]{36}$/.test(boot) && /^\d+$/.test(start) ? `${boot}:${start}` : null;
  } catch { return null; }
}

export function instanceFromPreviousContainer(instance, state, current = linuxContainerIdentity()) {
  return typeof current === 'string' && typeof state?.daemonContainerIdentity === 'string' &&
    /^[0-9a-f-]{36}:\d+$/.test(state.daemonContainerIdentity) &&
    state.daemonContainerIdentity !== current && state.daemonPid === instance?.pid &&
    state.daemonStartedAt === instance?.startedAt;
}
