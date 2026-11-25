import fs from 'node:fs';
import path from 'node:path';

const MIB = 1024 * 1024;
// Measured on 0.17.4 (npm 10, x64 Linux): the tarball cache is about 0.4 GB and the extracted tree about
// 1.1 GB, so an install peaks near 1.5 GB before anything is removed. About 0.34 GB of the tree is the
// Claude SDK's musl binaries, which a glibc host never runs; without them a release settles near 0.75 GB.
export const INSTALL_PEAK_MIB = 1536;
// An install that failed with less than this left on the volume was almost certainly out of space.
export const OUT_OF_SPACE_MIB = 64;
// The newest earlier release (the rollback target) is kept only while this much stays free after pruning.
export const KEEP_PRIOR_MIN_FREE_MIB = 3072;

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
