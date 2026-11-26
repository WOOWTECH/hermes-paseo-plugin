import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from test_bridge import b

class UpgradingRuntime:
    """The runtime's side of an older daemon waiting for the new release. `prepare` installs it, or fails with
    the code a test chooses; an explicit stop remains available."""

    def __init__(self):
        self.installed, self.running = False, True
        self.fail, self.details, self.last_failure = None, {}, None
        self.calls, self.gate = [], None

    def status(self):
        prepare = {'stage': 'ready'} if self.installed else (
            {'stage': 'failed', 'code': self.last_failure, **self.details} if self.last_failure else {'stage': 'pending'})
        return {'enabled': self.running, 'phase': 'running' if self.running else 'disabled', 'installed': self.installed,
                'diagnosticCode': 'RESTART_REQUIRED' if self.running else None, 'prepare': prepare, 'providers': [],
                'daemon': {'running': self.running, 'reachable': self.running, 'version': '0.11.2'}}

    def __call__(self, action, value=None):
        self.calls.append((action, value))
        if action == 'status':
            return self.status()
        if action == 'prepare':
            if self.gate is not None:
                self.gate.wait(3)
            if self.fail:
                self.last_failure = self.fail
                raise b.BridgeError(self.fail)
            self.installed, self.last_failure = True, None
            return self.status()
        if action == 'stop':
            self.running = False
            return self.status()
        raise AssertionError('unexpected runtime action ' + action)

    def count(self, action):
        return sum(1 for name, _ in self.calls if name == action)


class PreparationTests(unittest.TestCase):
    """What a failed install of the new release does to the page, the retries and a stop."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.bridge = b.Bridge(home=Path(self.temp.name) / 'profile')
        self.runtime = UpgradingRuntime()
        patcher = patch.object(self.bridge, '_invoke', side_effect=self.runtime)
        patcher.start()
        self.addCleanup(patcher.stop)

    def settle(self):
        if self.bridge._worker is not None:
            self.bridge._worker.join(3)

    def read(self):
        self.bridge.status(fresh=True)
        self.settle()
        return self.bridge.status(fresh=True)

    def test_a_failed_preparation_is_shown_as_one_with_its_code_and_does_not_look_like_a_failed_start(self):
        for code, details in (('RUNTIME_INSTALL_FAILED', {}), ('INSUFFICIENT_DISK', {'requiredMiB': 1536, 'availableMiB': 12}),
                              ('RUNTIME_INSTALL_TIMEOUT', {})):
            with self.subTest(code=code):
                self.setUp()
                self.runtime.fail, self.runtime.details = code, details
                shown = self.read()
                self.assertFalse(shown['installed'])
                self.assertEqual((shown['phase'], shown['diagnosticCode'], shown['enabled']), ('running', 'RESTART_REQUIRED', True),
                                 'the old daemon serves; this is not a start that failed')
                self.assertEqual(shown['prepare']['stage'], 'failed')
                self.assertEqual(shown['prepare']['code'], code)
                self.assertTrue(0 < shown['prepare']['retryInSeconds'] <= b.RETRY_BACKOFF[0])
                for key, value in details.items():
                    self.assertEqual(shown['prepare'][key], value)
                self.assertEqual([name for name, _ in self.runtime.calls if name != 'status'], ['prepare'])
                self.assertIsNone(self.bridge._phase)

    def test_the_retries_follow_the_start_backoff_and_stop_when_the_attempts_are_used_up(self):
        self.runtime.fail = 'RUNTIME_INSTALL_FAILED'
        self.read()
        self.read()
        self.assertEqual(self.runtime.count('prepare'), 1, 'not again before the delay')
        for failures in range(1, b.RETRY_LIMIT):
            delay = b.RETRY_BACKOFF[min(failures - 1, len(b.RETRY_BACKOFF) - 1)]
            shown = self.bridge.status(fresh=True)
            self.assertEqual(self.bridge._prepare_failures, failures)
            self.assertTrue(delay - 2 <= shown['prepare']['retryInSeconds'] <= delay, (failures, shown['prepare']))
            self.bridge._prepare_retry_at = time.monotonic() - 1
            self.read()
        self.assertEqual(self.runtime.count('prepare'), b.RETRY_LIMIT)
        gave_up = self.bridge.status(fresh=True)
        self.assertIsNone(gave_up['prepare']['retryInSeconds'], 'attempts used up: no countdown is promised')
        self.read()
        self.assertEqual(self.runtime.count('prepare'), b.RETRY_LIMIT)
        # The next retry is the user's: an explicit start tries again at once and recovers when the cause is gone.
        self.runtime.fail = None
        self.bridge.start()
        self.settle()
        shown = self.read()
        self.assertTrue(shown['installed'])
        self.assertEqual(shown['prepare'], {'stage': 'ready'})
        self.assertEqual(self.runtime.count('prepare'), b.RETRY_LIMIT + 1)
        self.assertEqual(self.runtime.count('stop'), 0)

    def test_a_success_ends_the_retrying_and_clears_the_failure(self):
        self.runtime.fail = 'RUNTIME_INSTALL_FAILED'
        self.read()
        self.runtime.fail = None
        self.bridge._prepare_retry_at = time.monotonic() - 1
        shown = self.read()
        self.assertEqual((shown['installed'], shown['prepare']), (True, {'stage': 'ready'}))
        self.assertEqual((self.bridge._prepare_failures, self.bridge._prepare_error, self.bridge._prepare_given_up), (0, None, False))
        self.read()
        self.assertEqual(self.runtime.count('prepare'), 2)
        # Even a status that keeps disagreeing does not start npm checks in a loop.
        self.runtime.installed = False
        self.read()
        self.assertEqual(self.runtime.count('prepare'), 2)

    def test_explicit_stop_remains_available_after_failure_and_when_queued(self):
        for queued in (False, True):
            with self.subTest(queued=queued):
                self.setUp()
                self.bridge.onboarding(create=True)
                self.runtime.fail = 'RUNTIME_INSTALL_FAILED'
                if queued:
                    self.runtime.gate = threading.Event()
                    self.bridge.status(fresh=True)
                    self.bridge.call('stop', {})
                    self.runtime.gate.set()
                    self.settle()
                    self.bridge._stop_worker.join(3)
                else:
                    self.read()
                    self.bridge.call('stop', {})
                self.assertFalse(self.runtime.running)
                self.assertTrue(json.loads((self.bridge.state_dir / 'onboarding.json').read_text())['paused'])
                self.assertEqual(self.runtime.count('stop'), 1)

    def test_prepare_success_requires_strict_installed_boolean(self):
        for value in (False, None, 'true', 1):
            with patch.object(self.bridge, '_invoke', return_value={'installed':value}):
                self.bridge._prepare()
            self.assertEqual(self.bridge._prepare_error, 'RUNTIME_NOT_READY')
            self.assertIsNone(self.bridge._phase)
            self.assertFalse(self.bridge._pause_requested)

    def test_prepare_budget_strict_installed_and_no_input(self):
        self.assertEqual(b.TIMEOUTS['prepare'], 480)
        self.assertEqual(b.validate_input('prepare', {}), {})
        for body in ({'target':'paseo'}, {'force':True}, []):
            with self.assertRaises(b.BridgeError): b.validate_input('prepare',body)
        for value in (None, 1, 'true', {}, False):
            self.assertIs(self.bridge._decorate({'installed':value})['installed'], False)
        self.assertIs(self.bridge._decorate({'installed':True})['installed'], True)

    def test_what_the_runtime_recorded_is_shown_after_a_dashboard_restart_until_this_process_knows_better(self):
        fresh = b.Bridge(home=Path(self.temp.name) / 'other')
        shown = fresh._decorate({'installed': False, 'prepare': {'stage': 'failed', 'code': 'INSUFFICIENT_DISK',
                                                                  'requiredMiB': 1536, 'availableMiB': 12}})
        self.assertEqual(shown['prepare'], {'stage': 'failed', 'code': 'INSUFFICIENT_DISK', 'requiredMiB': 1536, 'availableMiB': 12})
        for value in ('failed', 'unknown', None):
            decorated = fresh._decorate({'installed': False, 'prepare': {'stage': value}})
            self.assertEqual(decorated['prepare']['stage'], value if value == 'failed' else 'pending')
        self.assertNotIn('prepare', fresh._decorate({'enabled': False, 'phase': 'stopping'}), 'synthetic answers say nothing about it')

    def test_a_preparation_cancelled_by_a_stop_is_not_counted_as_a_failure(self):
        self.bridge.onboarding(create=True)
        with self.bridge._condition:
            self.bridge._pause_requested = True
        self.bridge._preparing = True
        self.bridge._prepare()
        self.assertEqual((self.bridge._prepare_failures, self.bridge._preparing), (0, False))
        self.assertEqual(self.runtime.count('prepare'), 0)


