import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONNECTION_TARGETS } from '../src/connection-targets.mjs';

// The target table exists three times: in the Node runtime (the source of truth), in the Python bridge (it releases
// a pairing link only for the saved target's exact app) and in the Dashboard (it opens the saved target's web app).
// A row that differs between them would pair a device with the wrong app, or open the wrong site.
const bridgeFile = fileURLToPath(new URL('../hermes_paseo.py', import.meta.url));
const uiSource = fs.readFileSync(new URL('../dashboard/dist/index.js', import.meta.url), 'utf8');

const node = CONNECTION_TARGETS.map(row => ({ ...row }));
// The Python module is imported by path in isolated mode; importing it has no side effects.
const read = spawnSync('python3', ['-B', '-I', '-c',
  'import importlib.util, json, sys\nspec = importlib.util.spec_from_file_location("hermes_paseo_parity", sys.argv[1])\nmodule = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)\nprint(json.dumps({"targets": module.TARGETS, "origins": module.TARGET_ORIGINS}))',
  bridgeFile], { encoding: 'utf8' });
assert.equal(read.status, 0, 'python3 must be available to compare the bridge: ' + read.stderr);
const python = JSON.parse(read.stdout);
// Evaluated in its own realm, then copied through JSON so the rows compare as plain objects.
const ui = JSON.parse(JSON.stringify(vm.runInNewContext('(' + /const TARGETS = (\[[\s\S]*?\n  \]);/.exec(uiSource)[1] + ')'))).map(row => ({ id: row.id, label: row.label, appUrl: row.origin }));

/** What differs between two tables, as readable lines: missing or extra ids, and any compared field. */
function differences(name, rows, expected, fields) {
  const found = [];
  const byId = list => new Map(list.map(row => [row.id, row]));
  const have = byId(rows), want = byId(expected);
  if (rows.length !== have.size) found.push(`${name}: duplicate ids`);
  for (const id of want.keys()) if (!have.has(id)) found.push(`${name}: missing ${id}`);
  for (const id of have.keys()) if (!want.has(id)) found.push(`${name}: unexpected ${id}`);
  for (const [id, row] of have) for (const field of fields) if (want.has(id) && row[field] !== want.get(id)[field]) found.push(`${name}: ${id}.${field} is ${row[field]}, the runtime says ${want.get(id)[field]}`);
  return found;
}

test('the three target tables agree on id, label and web app, and the bridge also on the relay endpoint', () => {
  assert.deepEqual(differences('bridge', python.targets, node, ['label', 'appUrl', 'relayEndpoint']), []);
  assert.deepEqual(differences('dashboard', ui, node, ['label', 'appUrl']), []);
  assert.deepEqual(python.origins, Object.fromEntries(node.map(row => [row.id, row.appUrl])), 'the bridge\'s origin lookup is derived from its table');
});

test('the table is the one the release documents, in every layer', () => {
  const documented = [['paseo', 'Paseo', 'https://app.paseo.sh', 'relay.paseo.sh:443'], ['woowtech', 'Woowtech Smart', 'https://smart.woowtech.io', 'relay.woowtech.io:443'],
    ['apporo', 'Apporo Smart', 'https://smart.apporo.ai', 'relay.apporo.ai:443']];
  assert.deepEqual(node.map(row => [row.id, row.label, row.appUrl, row.relayEndpoint]), documented);
  assert.deepEqual(python.targets.map(row => [row.id, row.label, row.appUrl, row.relayEndpoint]), documented);
  assert.deepEqual([...ui].map(row => row.id).sort(), documented.map(row => row[0]).sort());
});

test('the comparison fails for any single drift in any layer', () => {
  const mutate = (rows, index, field, value) => rows.map((row, i) => i === index ? { ...row, [field]: value } : { ...row });
  for (const [name, rows, fields] of [['bridge', python.targets, ['label', 'appUrl', 'relayEndpoint']], ['dashboard', ui, ['label', 'appUrl']]]) {
    for (let index = 0; index < rows.length; index++) {
      for (const field of fields) assert.notDeepEqual(differences(name, mutate(rows, index, field, rows[index][field] + 'x'), node, fields), [], `${name} ${rows[index].id}.${field}`);
      assert.notDeepEqual(differences(name, mutate(rows, index, 'id', 'renamed'), node, fields), [], `${name} id of row ${index}`);
      assert.notDeepEqual(differences(name, rows.filter((_, i) => i !== index), node, fields), [], `${name} without row ${index}`);
    }
    assert.notDeepEqual(differences(name, [...rows, { ...rows[0], id: 'extra' }], node, fields), [], `${name} with an extra row`);
    assert.notDeepEqual(differences(name, [...rows, { ...rows[0] }], node, fields), [], `${name} with a duplicate row`);
  }
});

test('the Dashboard never falls back to a row by position: an unknown id is the named default', () => {
  assert.doesNotMatch(uiSource, /TARGETS\[\d+\]/);
  assert.match(uiSource, /const DEFAULT_TARGET = "paseo";/);
  assert.match(uiSource, /function targetOf\(id\) \{ return TARGETS\.find\(row => row\.id === id\) \|\| TARGETS\.find\(row => row\.id === DEFAULT_TARGET\); \}/);
  assert.deepEqual(ui.map(row => row.id), ['woowtech', 'apporo', 'paseo'], 'the page lists Woowtech Smart, Apporo Smart, Paseo');
});
