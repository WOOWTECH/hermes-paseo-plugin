import contextlib
import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

path = Path(__file__).resolve().parents[1] / 'bin/install-dashboard-control-k8s.py'
spec = importlib.util.spec_from_file_location('test_host_installer_module', path)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class HostInstallerTests(unittest.TestCase):
    args = ['installer', '--context', 'test-context', '--namespace', 'test-namespace',
            '--workload', 'hermes-test', '--preserve-private-profile']

    def replies(self, uid='10000', owner='owned-sts'):
        workload = {'metadata': {'uid': 'owned-sts', 'resourceVersion': '123'},
                    'spec': {'selector': {'matchLabels': {'app': 'test'}},
                             'template': {'spec': {'containers': [{'name': 'hermes-agent'}]}}}}
        pods = {'items': [{'metadata': {'name': 'hermes-test-0',
                                       'ownerReferences': [{'uid': owner}]},
                           'status': {'phase': 'Running'}}]}
        return [SimpleNamespace(stdout=json.dumps(workload)),
                SimpleNamespace(stdout=json.dumps(pods)), SimpleNamespace(stdout=uid)]

    def test_private_profile_requires_owned_pod_and_service_uid_before_mutation(self):
        for uid, owner in [('0', 'owned-sts'), ('10000', 'another-sts')]:
            with self.subTest(uid=uid, owner=owner), patch.object(sys, 'argv', self.args + ['--apply']), \
                    patch.object(installer.subprocess, 'run', side_effect=self.replies(uid, owner)) as run:
                with self.assertRaises(SystemExit):
                    installer.main()
                self.assertFalse(any('apply' in c.args[0] or 'patch' in c.args[0] for c in run.call_args_list))

    def test_verified_profile_dry_run_preserves_platform_fsgroup(self):
        output = io.StringIO()
        with patch.object(sys, 'argv', self.args), \
                patch.object(installer.subprocess, 'run', side_effect=self.replies()) as run, \
                contextlib.redirect_stdout(output):
            installer.main()
        result = json.loads(output.getvalue())
        self.assertTrue(result['dry_run'])
        self.assertNotIn('securityContext', result['patch']['spec']['template']['spec'])
        self.assertEqual(run.call_count, 3)
        self.assertFalse(any('apply' in c.args[0] or 'patch' in c.args[0] for c in run.call_args_list))


if __name__ == '__main__':
    unittest.main()
