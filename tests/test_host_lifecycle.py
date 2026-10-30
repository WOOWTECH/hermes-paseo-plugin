import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('host_lifecycle_test', ROOT / 'host/profile_lifecycle.py')
module = importlib.util.module_from_spec(spec)
if spec.loader:
    spec.loader.exec_module(module)


class ProfileOriginTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.file = self.home / 'plugin-data/hermes-paseo/dashboard-origin.json'

    def test_remounted_private_origin_is_repaired_without_removing_fsgroup(self):
        self.file.parent.mkdir(parents=True)
        self.file.write_text(json.dumps({'origin': 'https://hermes.test'}))
        self.file.chmod(0o660)
        self.file.parent.chmod(0o770)
        module.prepare_profile_origin(self.home, 'https://hermes.test')
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.file.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(json.loads(self.file.read_text()), {'origin': 'https://hermes.test'})

    def test_a_moved_public_url_no_longer_wedges_the_adapter_forever(self):
        """End-to-end proof for the real failure, using the adapter's own code.

        The adapter writes this file once and thereafter only compares it, so an operator
        changing the Dashboard's public URL (on Home Assistant it is derived from a DHCP
        address) left prepare_profile_origin raising ORIGIN_MISMATCH on every reconcile, with
        no way back from the UI. The plugin bridge now re-anchors it from the same
        environment variable the adapter itself treats as authoritative.
        """
        import importlib.util as _util
        import os as _os
        from unittest.mock import patch as _patch
        spec = _util.spec_from_file_location('paseo_bridge_d1', ROOT / 'hermes_paseo.py')
        bridge_module = _util.module_from_spec(spec)
        spec.loader.exec_module(bridge_module)

        old, new = 'https://old.hermes.test', 'https://new.hermes.test'
        module.prepare_profile_origin(self.home, old)
        self.assertEqual(json.loads(self.file.read_text())['origin'], old)

        # The defect: the operator environment moved, and the adapter refuses for good.
        with self.assertRaises(module.LifecycleError) as caught:
            module.prepare_profile_origin(self.home, new)
        self.assertEqual(str(caught.exception), 'ORIGIN_MISMATCH')

        # The fix: the bridge adopts the new origin from the same authority.
        bridge = bridge_module.Bridge(home=self.home)
        with _patch.dict(_os.environ, {'HERMES_DASHBOARD_PUBLIC_URL': new}):
            self.assertEqual(bridge.adopt_environment_origin(), 'ORIGIN_ADOPTED')

        # The adapter now agrees, and the file is still owner-only.
        module.prepare_profile_origin(self.home, new)
        self.assertEqual(json.loads(self.file.read_text())['origin'], new)
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o600)

    def test_fresh_origin_is_created_before_plugin_initialization(self):
        module.prepare_profile_origin(self.home, 'https://hermes.test')
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o600)

    def test_foreign_origin_symlink_and_hardlink_fail_closed(self):
        self.file.parent.mkdir(parents=True)
        self.file.write_text(json.dumps({'origin': 'https://other.test'}))
        with self.assertRaises(module.LifecycleError):
            module.prepare_profile_origin(self.home, 'https://hermes.test')
        self.file.unlink()
        target = self.home / 'unrelated'
        target.write_text(json.dumps({'origin': 'https://hermes.test'}))
        self.file.symlink_to(target)
        with self.assertRaises(module.LifecycleError):
            module.prepare_profile_origin(self.home, 'https://hermes.test')
        self.file.unlink()
        os.link(target, self.file)
        with self.assertRaises(module.LifecycleError):
            module.prepare_profile_origin(self.home, 'https://hermes.test')


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        module.prepare_profile_origin(self.home, 'https://hermes.test')
        self.active = True
        self.snapshot = {'enabled': True, 'phase': 'stopped', 'daemon': {'running': False}}
        self.bridge = Mock()
        self.bridge.status.side_effect = lambda **kw: self.snapshot.copy()
        self.bridge.start.side_effect = self.started
        self.bridge.call.side_effect = self.stopped
        self.lifecycle = self.new_lifecycle()

    def new_lifecycle(self):
        life = module.ProfileLifecycle(self.home, lambda: self.active, lambda: 'https://hermes.test')
        life.load_bridge = lambda: self.bridge
        return life

    def paused(self, value):
        (self.home / 'plugin-data/hermes-paseo/onboarding.json').write_text(json.dumps({'paused': value}))

    def started(self):
        self.snapshot.update(enabled=True, phase='running', daemon={'running': True})
        self.paused(False)

    def stopped(self, action, value):
        self.assertEqual((action, value), ('stop', {}))
        self.snapshot.update(enabled=False, phase='disabled', daemon={'running': False})
        self.paused(True)

    def test_enabled_host_recovers_without_a_browser_and_preserves_manual_pause(self):
        self.lifecycle.reconcile()
        self.bridge.start.assert_called_once()
        self.lifecycle.reconcile()
        self.bridge.start.assert_called_once()
        self.paused(True)
        self.snapshot.update(enabled=False, phase='disabled', daemon={'running': False})
        self.lifecycle.reconcile()
        self.bridge.start.assert_called_once()

    def test_disable_reenable_survives_host_restart_and_repeated_disable(self):
        self.lifecycle.reconcile()
        self.active = False
        self.lifecycle.reconcile()
        self.bridge.call.assert_called_once()
        self.lifecycle.stop_for_disable()
        self.active = True
        restored = self.new_lifecycle()
        restored.reconcile()
        self.assertEqual(self.bridge.start.call_count, 2)
        self.assertFalse(restored._intent()['disabled'])

    def test_manually_paused_plugin_stays_paused_after_disable_reenable(self):
        self.paused(True)
        self.snapshot.update(enabled=False, phase='disabled')
        self.lifecycle.reconcile()
        self.active = False
        self.lifecycle.reconcile()
        self.active = True
        self.new_lifecycle().reconcile()
        self.bridge.start.assert_not_called()

    def test_fresh_enabled_install_initializes_once(self):
        self.snapshot.update(enabled=False, phase='not_installed')
        self.lifecycle.reconcile()
        self.bridge.start.assert_called_once()


if __name__ == '__main__':
    unittest.main()
