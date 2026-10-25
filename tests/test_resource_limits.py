import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('host_resources', Path(__file__).resolve().parents[1] / 'host/resource_limits.py')
resources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resources)


class ResourceLimitsTests(unittest.TestCase):
    def test_two_cpu_container_on_a_large_node_preserves_operator_overrides(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'cpu.max').write_text('200000 100000\n')
            env = {'LLAMA_ARG_THREADS': '1'}
            resources.configure_cpu_environment(env, root, affinity=128)
            self.assertEqual(env['LLAMA_ARG_THREADS'], '1')
            self.assertEqual(env['LLAMA_ARG_THREADS_BATCH'], '2')
            self.assertEqual(env['OMP_NUM_THREADS'], '2')
            self.assertEqual(env['LLAMA_ARG_THREADS_HTTP'], '3')

    def test_fractional_quota_and_affinity_bound_inference(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'cpu.max').write_text('150000 100000')
            env = {}
            resources.configure_cpu_environment(env, root, affinity=1)
            self.assertEqual(env['LLAMA_ARG_THREADS'], '1')

    def test_v1_and_unlimited_or_invalid_quota(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'cpu').mkdir()
            (root / 'cpu/cpu.cfs_quota_us').write_text('300000')
            (root / 'cpu/cpu.cfs_period_us').write_text('100000')
            self.assertEqual(resources.cpu_quota(root), 3)
            (root / 'cpu.max').write_text('max 100000')
            env = {}
            resources.configure_cpu_environment(env, root, affinity=128)
            self.assertEqual(env, {})
            (root / 'cpu.max').write_text('100000 0')
            self.assertIsNone(resources.cpu_quota(root))


if __name__ == '__main__':
    unittest.main()
