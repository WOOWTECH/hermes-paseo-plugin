import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('acceptance_job_bridge', ROOT / 'hermes_paseo.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class AcceptanceJobsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'source'
        self.home = Path(self.temp.name) / 'profile'
        (self.root / 'bin').mkdir(parents=True)
        shutil.copyfile(ROOT / 'hermes_paseo.py', self.root / 'hermes_paseo.py')
        shutil.copyfile(ROOT / 'bin/acceptance-worker.py', self.root / 'bin/acceptance-worker.py')
        self.fake_control()
        self.b = bridge.Bridge(root=self.root, home=self.home)

    def tearDown(self):
        # Every spawned fixture is awaited through its durable receipt first.
        self.temp.cleanup()

    def fake_control(self, error=False):
        result = {'passed': True, 'providers': [{'provider': 'hermes', 'passed': True,
                  'firstReply': True, 'followup': True, 'cleanup': {'archived': True}}]}
        code = ('process.stdout.write(JSON.stringify({ok:false,code:"PROVIDER_AUTH_REQUIRED"}));process.exitCode=1;'
                if error else 'process.stdout.write(' + json.dumps(json.dumps(result)) + ');')
        (self.root / 'bin/control.mjs').write_text(
            "import fs from 'node:fs';\n"
            "for await (const chunk of process.stdin){}\n"
            "fs.appendFileSync('executions.txt','once\\n');\n"
            "await new Promise(resolve=>setTimeout(resolve,700));\n" + code)

    def finished(self):
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            result = bridge.Bridge(root=self.root, home=self.home).acceptance_status()
            if not result['pending']:
                return result
            time.sleep(.05)
        self.fail('fixture job did not finish')

    def test_submission_is_fast_and_parallel_clients_adopt_one_durable_job(self):
        started = time.monotonic()
        first = self.b.start_acceptance({'providers': ['hermes']})
        self.assertLess(time.monotonic() - started, .7)
        self.assertTrue(first['pending'])
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            adopted = list(pool.map(lambda _: bridge.Bridge(root=self.root, home=self.home).start_acceptance({}), range(4)))
        self.assertEqual({r['jobId'] for r in adopted}, {first['jobId']})
        result = self.finished()
        self.assertEqual(result['phase'], 'completed')
        self.assertTrue(result['result']['passed'])
        self.assertTrue(self.b.onboarding()['completed'])
        self.assertEqual((self.root / 'executions.txt').read_text().splitlines(), ['once'])
        self.assertNotIn('pid', result)
        self.assertNotIn('identity', result)
        self.assertEqual((self.b.state_dir / 'acceptance-job.json').stat().st_mode & 0o777, 0o600)

    def test_worker_survives_the_submitting_process_exiting(self):
        code = ('import importlib.util,json;from pathlib import Path;'
                f's=importlib.util.spec_from_file_location("b",{str(self.root / "hermes_paseo.py")!r});'
                'm=importlib.util.module_from_spec(s);s.loader.exec_module(m);'
                f'print(json.dumps(m.Bridge(root={str(self.root)!r},home={str(self.home)!r}).start_acceptance({{}})))')
        parent = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, timeout=5)
        self.assertEqual(parent.returncode, 0, parent.stderr)
        self.assertTrue(json.loads(parent.stdout)['pending'])
        self.assertTrue(self.finished()['result']['passed'])

    def test_failed_worker_reports_an_error_without_claiming_a_reply(self):
        self.fake_control(error=True)
        self.b.start_acceptance({})
        result = self.finished()
        self.assertEqual(result['phase'], 'error')
        self.assertEqual(result['code'], 'PROVIDER_AUTH_REQUIRED')
        self.assertIsNone(result['result'])
        self.assertFalse(self.b.onboarding()['completed'])

    def test_stale_worker_identity_is_interrupted_and_reads_never_restart_it(self):
        self.b.onboarding(create=True)
        bridge._write_json(self.b.state_dir / 'acceptance-job.json', {
            'version': 1, 'id': 'a' * 32, 'phase': 'running', 'pid': os.getpid(),
            'identity': '0', 'providers': ['hermes'], 'result': None, 'code': None})
        result = self.b.acceptance_status()
        self.assertEqual(result['phase'], 'interrupted')
        self.assertEqual(result['code'], 'ACCEPTANCE_INTERRUPTED')
        self.assertFalse(self.b.acceptance_status()['pending'])
        self.assertFalse((self.root / 'executions.txt').exists())


if __name__ == '__main__':
    unittest.main()
