import fs from 'node:fs';
import path from 'node:path';

const MIB = 1024 * 1024;
// Reserve installation peak space before npm (cache plus extracted native SDKs).
export const INSTALL_PEAK_MIB = 1536;
// An install that failed with less than this left on the volume was almost certainly out of space.
export const OUT_OF_SPACE_MIB = 64;

/**
 * What the host offers. Tests replace these two functions; nothing else reads the volume or the libc.
 */
export const hostCapacity = {
  /** Space an unprivileged writer can still use where `target` lives (its nearest existing parent), in whole MiB; null when it cannot be told. */
  availableMiB(target) {
    let directory = path.resolve(target);
    for (;;) {
      try { fs.lstatSync(directory); break; } catch { const parent = path.dirname(directory); if (parent === directory) return null; directory = parent; }
    }
    try {
      const info = fs.statfsSync(directory);
      return Math.floor(Number(info.bavail) * Number(info.bsize) / MIB);
    } catch { return null; }
  },
  /** True on a Linux host whose C library is glibc (the standard check: only glibc reports a runtime version). */
  glibc() {
    if (process.platform !== 'linux' || typeof process.report?.getReport !== 'function') return false;
    // The report is only read for one header field and stays in memory; keep the environment out of it.
    const guarded = typeof process.report.excludeEnv === 'boolean', previous = process.report.excludeEnv;
    try {
      if (guarded) process.report.excludeEnv = true;
      return Boolean(process.report.getReport().header?.glibcVersionRuntime);
    } catch { return false; }
    finally { if (guarded) { try { process.report.excludeEnv = previous; } catch { /* keep the answer */ } } }
  },
};
