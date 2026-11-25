// Which settings a release could not accept, named by key path only. The messages Paseo's validator
// writes (and the values behind them) never leave this module: a config.json holds credentials.
const MAX_PATHS = 20;
const MAX_LENGTH = 160;
const printable = text => Array.from(String(text), ch => ch.codePointAt(0) > 31 && ch.codePointAt(0) !== 127 ? ch : '').join('').slice(0, MAX_LENGTH);
function collect(candidates) {
  const seen = new Set();
  for (const candidate of candidates) {
    const path = printable(candidate);
    if (path) seen.add(path);
    if (seen.size >= MAX_PATHS) break;
  }
  return [...seen];
}
const join = (base, key) => base ? base + '.' + key : String(key);

/**
 * Key paths named by the error Paseo's own config reader throws. It lists one `  - <path>: <message>`
 * line per problem; an unrecognized key is reported against its parent, so the keys it names are
 * appended to that path. Everything else in the message is dropped.
 */
export function configIssuePaths(error) {
  const found = [];
  for (const line of String(error?.message ?? '').split('\n')) {
    const row = /^ {2}- (.*?): (.*)$/.exec(line);
    if (!row) continue;
    const unknown = /^Unrecognized keys?: (.+)$/.exec(row[2]);
    if (!unknown) { found.push(row[1] || '(root)'); continue; }
    for (const quoted of unknown[1].match(/"(?:[^"\\]|\\.)*"/g) ?? []) {
      try { found.push(join(row[1], JSON.parse(quoted))); } catch { /* an unreadable key name is not worth a guess */ }
    }
  }
  return collect(found);
}

/** Key paths of a zod-style issue list (`path`, plus `keys` for unrecognized keys). */
export function issueKeyPaths(issues) {
  const found = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    const base = Array.isArray(issue?.path) ? issue.path.join('.') : '';
    const keys = Array.isArray(issue?.keys) ? issue.keys : [];
    if (keys.length) for (const key of keys) found.push(join(base, key)); else found.push(base || '(root)');
  }
  return collect(found);
}
