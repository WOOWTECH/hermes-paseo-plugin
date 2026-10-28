"""Relay self-check wiring in the bridge: no provider calls, installs or daemon launches."""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


native = load('test_hermes_paseo_native_relay', ROOT / '__init__.py')
b = native.bridge


def stamp(age):
    return (datetime.now(timezone.utc) - age).isoformat()


class RelayBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.bridge = b.Bridge(home=Path(self.temp.name) / 'profile-a')

    def start_with(self, snapshot, relay=None, pause=False):
        calls = []

        def invoke(action, *_):
            calls.append(action)
            if action == 'relay':
                if isinstance(relay, Exception):
                    raise relay
                return {'daemon': {'relayVerified': True}}
            return snapshot

        with patch.object(self.bridge, '_invoke', side_effect=invoke):
            if pause:
                self.bridge._pause_requested = True
            self.bridge._initialize()
        return calls

    @staticmethod
    def running(**daemon):
        return {'enabled': True, 'phase': 'running', 'daemon': {'reachable': True, **daemon}}

    def test_relay_is_checked_once_the_daemon_is_up_and_a_failure_never_blocks_setup(self):
        self.assertEqual(self.start_with(self.running(relayVerified=False)), ['status', 'relay'])
        self.assertIsNone(self.bridge._phase)
        self.assertEqual(self.start_with(self.running(relayVerified=False), relay=b.BridgeError('RELAY_UNVERIFIED')), ['status', 'relay'])
        self.assertIsNone(self.bridge._phase)
        self.assertIsNone(self.bridge._error)

    def test_a_recent_verification_is_kept_and_a_day_old_one_is_repeated(self):
        fresh = self.running(relayVerified=True, relayVerifiedAt=stamp(timedelta(hours=3)))
        self.assertEqual(self.start_with(fresh), ['status'])
        old = self.running(relayVerified=True, relayVerifiedAt=stamp(timedelta(hours=25)))
        self.assertEqual(self.start_with(old), ['status', 'relay'])
        unreadable = self.running(relayVerified=True, relayVerifiedAt='yesterday')
        self.assertEqual(self.start_with(unreadable), ['status', 'relay'])

    def test_relay_is_not_checked_for_an_unreachable_daemon_or_a_paused_start(self):
        down = {'enabled': True, 'phase': 'running', 'diagnosticCode': 'DAEMON_UNREACHABLE', 'daemon': {'reachable': False}}
        self.assertEqual(self.start_with(down), ['status', 'start'])
        self.assertEqual(self.start_with(self.running(relayVerified=False), pause=True), [])

    def test_relay_action_takes_no_input_and_never_returns_an_offer(self):
        self.assertEqual(b.validate_input('relay'), {})
        with self.assertRaises(b.BridgeError):
            b.validate_input('relay', {'url': 'https://app.paseo.sh/#offer=x'})
        leaky = {'daemon': {'relayVerified': True}, 'url': 'https://app.paseo.sh/#offer=secret'}
        with patch.object(self.bridge, '_invoke', return_value=leaky):
            self.assertNotIn('offer', json.dumps(b.redact(self.bridge.call('relay'))))


if __name__ == '__main__':
    unittest.main()
