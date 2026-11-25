"""Local tests: no provider calls, installs, daemon launches or credential files."""
from __future__ import annotations

import concurrent.futures
import contextvars
import importlib.util
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


native = load('test_hermes_paseo_native', ROOT / '__init__.py')
api = load('test_hermes_paseo_api', ROOT / 'dashboard/plugin_api.py')
b = native.bridge


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / 'profile-a'
        self.bridge = b.Bridge(home=self.home)

    def test_onboarding_survives_failed_start_and_is_idempotent(self):
        def invoke(action, *_):
            self.assertTrue((self.bridge.state_dir / 'onboarding.json').is_file())
            raise b.BridgeError('NODE_UNAVAILABLE')
        with patch.object(self.bridge, '_invoke', side_effect=invoke):
            self.bridge.start()
            self.bridge._worker.join(2)
            first = self.bridge.onboarding()
            self.bridge.start()
            self.bridge._worker.join(2)
        restored = b.Bridge(home=self.home).onboarding()
        self.assertEqual(first, restored)
        self.assertTrue(restored['required'])
        self.assertIsNone(restored['sessionId'])
        self.assertEqual(restored['limitation'], 'NATIVE_SESSION_CREATION_UNAVAILABLE')
        self.assertEqual(self.bridge._error, 'NODE_UNAVAILABLE')
        self.assertEqual((self.bridge.state_dir / 'onboarding.json').stat().st_mode & 0o777, 0o600)

    def test_concurrent_onboarding_preserves_one_id(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            records = list(pool.map(lambda _: b.Bridge(home=self.home).onboarding(create=True), range(12)))
        self.assertEqual(len({r['id'] for r in records}), 1)

    def test_completion_requires_successful_acceptance(self):
        self.bridge.onboarding(create=True)
        with patch.object(self.bridge, '_invoke', return_value={'passed': False}):
            self.bridge.call('acceptance', {'providers': ['hermes']})
        self.assertFalse(self.bridge.onboarding()['completed'])
        with patch.object(self.bridge, '_invoke', return_value={'passed': True}):
            self.bridge.call('acceptance', {'providers': ['hermes']})
        self.assertTrue(b.Bridge(home=self.home).onboarding()['completed'])

    def test_profile_environment_is_pinned_and_credentials_not_opened(self):
        with patch.dict(os.environ, {'HERMES_HOME': '/wrong', 'HERMES_PASEO_STATE_DIR': '/wrong/state',
                                     'HERMES_PASEO_RUNTIME_DIR': '/wrong/runtime',
                                     'HERMES_PASEO_HERMES_COMMAND': sys.executable,
                                     'EXAMPLE_ACTIVE_AUTH': 'test-only'}, clear=False), patch('builtins.open', side_effect=AssertionError('no credential reads')):
            env = self.bridge.environment()
        self.assertEqual(env['HERMES_HOME'], str(self.home))
        self.assertEqual(env['HERMES_PASEO_STATE_DIR'], str(self.bridge.state_dir))
        self.assertNotIn('HERMES_PASEO_RUNTIME_DIR', env)
        self.assertEqual(env['HERMES_PASEO_HERMES_COMMAND'], str(Path(sys.executable).resolve()))
        self.assertEqual(env['EXAMPLE_ACTIVE_AUTH'], 'test-only')

    def test_host_credentials_are_not_handed_to_the_runtime(self):
        """The runtime is reachable through the hosted relay and can read its own environment, so
        the credentials the host uses to authenticate its own callers must not reach it. Provider
        credentials must still pass: the agents need them to answer."""
        host = {name: 'host-secret' for name in b.HOST_CREDENTIALS}
        with patch.dict(os.environ, {**host, 'OPENROUTER_API_KEY': 'provider-only',
                                     'HERMES_DASHBOARD_BASIC_AUTH_USERNAME': 'admin'}, clear=False):
            env = self.bridge.environment()
        for name in b.HOST_CREDENTIALS:
            self.assertNotIn(name, env, name)
        self.assertNotIn('host-secret', ''.join(str(value) for value in env.values()))
        self.assertEqual(env['OPENROUTER_API_KEY'], 'provider-only')
        self.assertEqual(env['HERMES_DASHBOARD_BASIC_AUTH_USERNAME'], 'admin')

    def test_fsgroup_group_bits_after_a_pod_restart_do_not_503_every_route(self):
        """Kubelet reapplies fsGroup on every Pod restart, adding group read/write to the file
        behind dashboard_origin(). Rejecting that answered STATE_UNAVAILABLE on every plugin
        route; other users' access must still fail closed."""
        self.bridge.set_dashboard_origin('https://hermes.test')
        path = self.bridge.state_dir / 'dashboard-origin.json'
        path.chmod(0o660)
        self.assertEqual(self.bridge.dashboard_origin(), 'https://hermes.test')
        self.assertEqual(path.stat().st_mode & 0o777, 0o600, 'the read should retighten it')
        path.chmod(0o604)
        with self.assertRaises(b.BridgeError) as caught:
            self.bridge.dashboard_origin()
        self.assertEqual(caught.exception.code, 'STATE_UNAVAILABLE')

    def test_origin_is_re_anchored_when_the_operator_environment_moved(self):
        """The host adapter writes this file once and thereafter only compares it, so a changed
        public URL (on HA it comes from a DHCP address) wedged ORIGIN_MISMATCH forever."""
        self.bridge.set_dashboard_origin('https://old.hermes.test')
        with patch.dict(os.environ, {'HERMES_DASHBOARD_PUBLIC_URL': 'https://new.hermes.test/'}):
            self.assertEqual(self.bridge.adopt_environment_origin(), 'ORIGIN_ADOPTED')
            self.assertEqual(self.bridge.dashboard_origin(), 'https://new.hermes.test')
            self.assertEqual(self.bridge.adopt_environment_origin(), 'ORIGIN_CURRENT')

    def test_origin_adoption_reports_a_bad_or_missing_public_url_instead_of_raising(self):
        for value, expected in (('', 'PUBLIC_URL_MISSING'),
                                ('https://hermes.test/with/path', 'PUBLIC_URL_NOT_AN_ORIGIN'),
                                ('not-a-url', 'PUBLIC_URL_NOT_AN_ORIGIN')):
            with self.subTest(value=value):
                with patch.dict(os.environ, {'HERMES_DASHBOARD_PUBLIC_URL': value}):
                    self.assertEqual(self.bridge.adopt_environment_origin(), expected)

    def test_a_failed_start_is_offered_back_for_recovery_after_the_backoff(self):
        """The host adapter's unattended recovery arms only on not_installed / stopped, so a
        latched phase='error' disarmed it for the life of the Dashboard process."""
        with self.bridge._condition:
            self.bridge._phase = 'error'
            self.bridge._error = 'START_FAILED'
            self.bridge._retry_count = 1
            self.bridge._retry_at = time.monotonic() + 3600
        held = self.bridge._decorate({})
        self.assertEqual(held['phase'], 'error')
        with self.bridge._condition:
            self.bridge._retry_at = time.monotonic() - 1
        due = self.bridge._decorate({})
        self.assertEqual(due['phase'], 'stopped', 'the adapter can only recover from stopped')
        self.assertEqual(due['diagnosticCode'], 'START_FAILED', 'the real cause must survive')

    def test_retrying_is_bounded_so_a_broken_runtime_is_not_restarted_forever(self):
        with self.bridge._condition:
            self.bridge._phase = 'error'
            self.bridge._retry_count = b.RETRY_LIMIT + 1
            self.bridge._retry_at = None
        self.assertEqual(self.bridge._decorate({})['phase'], 'error')

    def test_context_home_selects_independent_bridge(self):
        home_var = contextvars.ContextVar('home')
        resolver = type(sys)('hermes_constants')
        resolver.get_hermes_home = lambda: home_var.get()
        with patch.dict(sys.modules, {'hermes_constants': resolver}):
            home_var.set(self.home)
            first = b.get_bridge()
            home_var.set(Path(self.temp.name) / 'profile-b')
            second = b.get_bridge()
        self.assertIsNot(first, second)
        self.assertNotEqual(first.state_dir, second.state_dir)

    def test_symlink_state_fails_closed(self):
        self.home.mkdir()
        (self.home / 'plugin-data').symlink_to(Path(self.temp.name))
        with self.assertRaises(b.BridgeError):
            self.bridge.onboarding(create=True)
        self.assertFalse((Path(self.temp.name) / 'hermes-paseo').exists())

    def test_status_coalesces_and_mutation_invalidates(self):
        calls = []
        def invoke(action, *_):
            calls.append(action)
            time.sleep(0.04)
            return {'enabled': True, 'phase': 'running', 'daemon': {'reachable': True}}
        with patch.object(self.bridge, '_invoke', side_effect=invoke):
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(lambda _: self.bridge.status(), range(8)))
            self.assertEqual(calls, ['status'])
            results[0]['daemon']['reachable'] = False
            self.assertTrue(self.bridge.status()['daemon']['reachable'])
            self.bridge.call('stop')
            self.bridge.status()
        self.assertEqual(calls, ['status', 'stop', 'status'])

    def test_status_failure_is_never_cached(self):
        with patch.object(self.bridge, '_invoke', side_effect=[b.BridgeError('PROCESS_TIMEOUT'), {'phase': 'disabled'}]) as invoke:
            failed = self.bridge.status()
            self.assertEqual(failed['diagnosticCode'], 'PROCESS_TIMEOUT')
            self.assertIn('onboarding', failed)
            self.assertEqual(self.bridge.status()['phase'], 'disabled')
            self.assertEqual(invoke.call_count, 2)

    def test_status_diagnostic_failure_is_not_cached(self):
        with patch.object(self.bridge, '_invoke', return_value={'diagnosticCode': 'DAEMON_UNREACHABLE'}) as invoke:
            self.bridge.status()
            self.bridge.status()
        self.assertEqual(invoke.call_count, 2)

    def test_background_start_is_single_and_stop_wins(self):
        entered, release = threading.Event(), threading.Event()
        calls = []
        def invoke(action, *_):
            calls.append(action)
            if action == 'status':
                return {'enabled': False, 'phase': 'not_installed'}
            if action == 'start':
                entered.set()
                release.wait(3)
            return {'enabled': action == 'start', 'phase': 'running' if action == 'start' else 'disabled'}
        with patch.object(self.bridge, '_invoke', side_effect=invoke):
            self.assertEqual(self.bridge.start()['phase'], 'installing')
            self.assertTrue(entered.wait(1))
            self.bridge.start()
            paused = self.bridge.call('stop')
            self.assertFalse(paused['enabled'])
            self.assertEqual(paused['phase'], 'stopping')
            self.assertEqual(self.bridge.start()['phase'], 'stopping')
            release.set()
            self.bridge._worker.join(2)
            self.bridge._stop_worker.join(2)
        self.assertEqual(calls, ['status', 'start', 'stop'])
        self.assertTrue(json.loads((self.bridge.state_dir / 'onboarding.json').read_text())['paused'])

    def test_background_preserves_profile_context(self):
        scope = contextvars.ContextVar('scope', default='wrong')
        seen = []
        def invoke(*_):
            seen.append(scope.get())
            return {'enabled': True, 'phase': 'running', 'daemon': {'reachable': True, 'relayVerified': True, 'relayVerifiedAt': '2999-01-01T00:00:00+00:00'}}
        with patch.object(self.bridge, '_invoke', side_effect=invoke):
            scope.set('profile-a')
            self.bridge.start()
            self.bridge._worker.join(2)
        self.assertEqual(seen, ['profile-a'])

    def test_pair_is_unavailable_to_tools(self):
        with patch.object(self.bridge, '_invoke') as invoke:
            with self.assertRaises(b.BridgeError):
                self.bridge.call('pair')
            invoke.assert_not_called()
        self.assertNotIn('url', b.redact({'url': 'https://app.paseo.sh/?offer=test', 'password': 'test'}))
        self.assertNotIn('offer=test', b.redact({'reply': 'https://app.paseo.sh/?offer=test'})['reply'])

    def test_known_input_fields_only(self):
        for action, body in [('start', {'provider': 'hermes'}), ('chat', {'provider': 'hermes', 'message': 'hello', 'cwd': '/tmp'}),
                             ('status', {'command': 'anything'}), ('continue', {'agentId': '../bad', 'message': 'hi'}),
                             ('models', {'provider': ['hermes']}), ('acceptance', {'providers': ['unknown']})]:
            with self.subTest(action=action), self.assertRaises(b.BridgeError):
                b.validate_input(action, body)
        self.assertEqual(b.validate_input('chat', {'provider': 'hermes', 'model': 'm', 'mode': 'normal', 'thinking': 'high', 'message': 'hi'})['mode'], 'normal')

    def test_utf8_input_byte_limit(self):
        with self.assertRaises(b.BridgeError) as error:
            b.validate_input('chat', {'provider': 'hermes', 'message': '界' * 6000})
        self.assertEqual(error.exception.code, 'REQUEST_TOO_LARGE')

    def test_cleanup_evidence_survives_output_redaction(self):
        result = b.redact({'passed': False, 'providers': [
            {'provider': 'hermes', 'cleanup': {'archived': False, 'code': 'ACCEPTANCE_CLEANUP_FAILED'},
             'password': 'test-only'}]})
        self.assertEqual(result['providers'][0]['cleanup'],
                         {'archived': False, 'code': 'ACCEPTANCE_CLEANUP_FAILED'})
        self.assertNotIn('password', result['providers'][0])

    def test_pair_origin_validation(self):
        self.assertEqual(b.public_pair({'url': 'https://app.paseo.sh/#offer=test', 'token': 'secret'}),
                         {'url': 'https://app.paseo.sh/#offer=test', 'target': 'paseo'})
        for url in ['http://app.paseo.sh/a', 'https://app.paseo.sh.evil/a', 'https://user@app.paseo.sh/a',
                    'https://app.paseo.sh:444/a', 'https://app.paseo.sh/\nsecret', 'javascript:test',
                    'https://app.paseo.sh/?offer=test', 'https://app.paseo.sh/pair#offer=test',
                    'https://app.paseo.sh:443/#offer=test', 'https://app.paseo.sh/?#offer=test',
                    'https://app.paseo.sh/#offer=', 'https://app.paseo.sh/#offer=a.b', 'https://app.paseo.sh/#token=x']:
            with self.subTest(url=url), self.assertRaises(b.BridgeError):
                b.public_pair({'url': url})

    def test_pair_links_are_released_only_for_the_selected_targets_exact_app(self):
        for target, origin in b.TARGET_ORIGINS.items():
            url = origin + '/#offer=PRIVATE_offer-1'
            with self.subTest(target=target):
                self.assertEqual(b.public_pair({'url': url, 'target': target}, target), {'url': url, 'target': target})
                for other in set(b.TARGET_ORIGINS) - {target}:
                    with self.assertRaises(b.BridgeError):
                        b.public_pair({'url': url}, other)
                with self.assertRaises(b.BridgeError):
                    b.public_pair({'url': url, 'target': 'paseo' if target != 'paseo' else 'apporo'}, target)
        with self.assertRaises(b.BridgeError):
            b.public_pair({'url': 'https://smart.woowtech.io/#offer=x'}, 'custom')

    def test_pair_uses_the_target_saved_on_disk_not_the_runtime_output(self):
        b._private_dir(self.bridge.state_dir)
        b._write_json(self.bridge.state_dir / 'connection.json', {'version': 1, 'target': 'apporo'})
        (self.bridge.state_dir / 'connection.json').chmod(0o600)
        self.assertEqual(self.bridge.connection_target(), 'apporo')
        good = {'url': 'https://smart.apporo.ai/#offer=abc', 'target': 'apporo', 'createdAt': 'now'}
        with patch.object(b, 'run_process', return_value=good), patch.object(b, 'resolve_executable', return_value=sys.executable):
            self.assertEqual(self.bridge._invoke('pair'), {'url': good['url'], 'target': 'apporo'})
        with patch.object(b, 'run_process', return_value={'url': 'https://app.paseo.sh/#offer=abc', 'target': 'paseo'}), \
                patch.object(b, 'resolve_executable', return_value=sys.executable), self.assertRaises(b.BridgeError) as caught:
            self.bridge._invoke('pair')
        self.assertEqual(caught.exception.code, 'INVALID_PAIR_URL')
        for corrupt in ({'version': 1, 'target': 'custom'}, {'target': 'paseo'}, {'version': 1, 'target': 'paseo', 'extra': 1}):
            b._write_json(self.bridge.state_dir / 'connection.json', corrupt)
            with self.subTest(corrupt=corrupt), self.assertRaises(b.BridgeError) as caught:
                self.bridge.connection_target()
            self.assertEqual(caught.exception.code, 'CONNECTION_STATE_CORRUPT')
        (self.bridge.state_dir / 'connection.json').chmod(0o606)
        with self.assertRaises(b.BridgeError):
            self.bridge.connection_target()

    def test_config_accepts_exactly_one_known_target(self):
        for target in b.TARGET_ORIGINS:
            self.assertEqual(b.validate_input('config', {'target': target}), {'target': target})
        for body, code in [({}, 'INVALID_TARGET'), ({'target': 'Paseo'}, 'INVALID_TARGET'), ({'target': 'custom'}, 'INVALID_TARGET'),
                           ({'target': ['paseo']}, 'INVALID_TARGET'), ({'target': None}, 'INVALID_TARGET'),
                           ({'target': 'paseo', 'url': 'https://evil.example'}, 'INVALID_REQUEST'),
                           ({'target': 'paseo', 'relayEndpoint': 'evil:443'}, 'INVALID_REQUEST')]:
            with self.subTest(body=body), self.assertRaises(b.BridgeError) as caught:
                b.validate_input('config', body)
            self.assertEqual(caught.exception.code, code)

    def test_config_saves_through_the_runtime_and_invalidates_cached_status(self):
        calls = []
        def invoke(action, value=None):
            calls.append((action, value))
            if action == 'config':
                return {'saved': True, 'target': value['target'], 'configurationPending': True, 'url': 'https://smart.woowtech.io/#offer=x'}
            return {'enabled': True, 'phase': 'running', 'daemon': {'reachable': True}, 'selectedTarget': 'paseo'}
        with patch.object(self.bridge, '_invoke', side_effect=invoke):
            self.bridge.status()
            result = self.bridge.call('config', {'target': 'woowtech'})
            self.bridge.status()
        self.assertEqual(result, {'saved': True, 'target': 'woowtech', 'configurationPending': True, 'url': 'https://smart.woowtech.io/#offer=x'})
        self.assertEqual([action for action, _ in calls], ['status', 'config', 'status'])
        self.assertEqual(b.redact({'saved': True, 'url': 'https://smart.woowtech.io/#offer=x'}), {'saved': True})

    def test_prepare_is_a_runtime_action_with_its_own_time_budget(self):
        self.assertEqual(b.validate_input('prepare', {}), {})
        for body in ({'target': 'paseo'}, {'force': True}, {'provider': 'hermes'}, []):
            with self.subTest(body=body), self.assertRaises(b.BridgeError) as caught:
                b.validate_input('prepare', body)
            self.assertEqual(caught.exception.code, 'INVALID_REQUEST')
        self.assertGreaterEqual(b.TIMEOUTS['prepare'], 480, 'npm may take 300 s after up to 120 s waiting for the runtime lock')
        answer = {'installed': True, 'daemon': {'running': True}, 'state': {'password': 'raw-state-never-leaves'},
                  'configCheck': {'ok': False, 'code': 'CONFIG_INCOMPATIBLE', 'checkedAt': 'now'}}
        with patch.object(b, 'run_process', return_value=answer) as run, patch.object(b, 'resolve_executable', return_value=sys.executable):
            result = self.bridge.call('prepare')
        self.assertEqual(run.call_args.args[0][1:], [str(self.bridge.root / 'bin' / 'control.mjs'), 'prepare'])
        self.assertEqual(run.call_args.args[3], b.TIMEOUTS['prepare'])
        self.assertEqual(result['configCheck'], {'ok': False, 'code': 'CONFIG_INCOMPATIBLE', 'checkedAt': 'now'})
        self.assertNotIn('state', result)

    def runtime_that_refuses_a_guarded_stop(self, code='CONFIG_INCOMPATIBLE'):
        """A runtime whose daemon is an older release and whose new release cannot start: a user's stop is
        declined (the daemon keeps running), a stop with reason `disable` is carried out."""
        calls = []
        running = {'enabled': True, 'phase': 'running', 'daemon': {'running': True, 'reachable': True}, 'diagnosticCode': 'RESTART_REQUIRED', 'installed': True}
        def invoke(action, value=None):
            calls.append((action, value))
            if action == 'stop' and (value or {}).get('reason') != 'disable':
                raise b.BridgeError(code)
            if action == 'stop':
                running.update(enabled=False, phase='disabled', daemon={'running': False, 'reachable': False})
            return dict(running)
        return calls, invoke

    def test_a_refused_stop_leaves_the_bridge_unpaused_and_enabled(self):
        """The runtime declines a stop it cannot undo (the new release cannot read config.json). The stop had
        already persisted the pause, which blocked pairing and unattended recovery and, through the host
        adapter, made disable and remove answer PLUGIN_STOP_PENDING."""
        self.bridge.onboarding(create=True)
        calls, invoke = self.runtime_that_refuses_a_guarded_stop()
        with patch.object(self.bridge, '_invoke', side_effect=invoke):
            with self.assertRaises(b.BridgeError) as refused:
                self.bridge.call('stop', {}, guard_config=True)
            self.assertEqual(refused.exception.code, 'CONFIG_INCOMPATIBLE')
            self.assertFalse(self.bridge._pause_requested)
            self.assertIsNone(self.bridge._phase)
            self.assertIsNone(self.bridge._error)
            self.assertFalse(json.loads((self.bridge.state_dir / 'onboarding.json').read_text())['paused'])
            shown = self.bridge.status(fresh=True)
        self.assertTrue(shown['enabled'])
        self.assertEqual(shown['phase'], 'running')
        self.assertEqual(shown['diagnosticCode'], 'RESTART_REQUIRED')
        self.assertEqual(calls[0], ('stop', None), 'a guarded stop sends no reason')

    def test_a_refused_stop_that_was_queued_behind_a_start_also_lifts_the_pause(self):
        self.bridge.onboarding(create=True)
        entered, release = threading.Event(), threading.Event()
        calls, refusing = self.runtime_that_refuses_a_guarded_stop()
        def invoke(action, value=None):
            if action == 'status' and not entered.is_set():
                return {'enabled': False, 'phase': 'not_installed', 'daemon': {'running': False, 'reachable': False}}
            if action == 'start':
                entered.set()
                release.wait(3)
                return {'enabled': True, 'phase': 'running', 'daemon': {'running': True, 'reachable': True}}
            return refusing(action, value)
        with patch.object(self.bridge, '_invoke', side_effect=invoke):
            self.bridge.start()
            self.assertTrue(entered.wait(2))
            queued = self.bridge.call('stop', {}, guard_config=True)
            self.assertEqual((queued['enabled'], queued['phase']), (False, 'stopping'))
            release.set()
            self.bridge._worker.join(2)
            self.bridge._stop_worker.join(2)
            shown = self.bridge.status(fresh=True)
        self.assertEqual([call for call in calls if call[0] == 'stop'], [('stop', None)])
        self.assertTrue(shown['enabled'])
        self.assertFalse(self.bridge._pause_requested)
        self.assertFalse(json.loads((self.bridge.state_dir / 'onboarding.json').read_text())['paused'])

    def test_a_stop_without_the_guard_is_the_host_turning_the_plugin_off_and_is_never_refused(self):
        self.bridge.onboarding(create=True)
        calls, invoke = self.runtime_that_refuses_a_guarded_stop()
        with patch.object(self.bridge, '_invoke', side_effect=invoke):
            result = self.bridge.call('stop', {})
        self.assertEqual(calls, [('stop', {'reason': 'disable'})])
        self.assertFalse(result['enabled'])
        self.assertTrue(json.loads((self.bridge.state_dir / 'onboarding.json').read_text())['paused'], 'a real stop keeps its pause')

    def test_only_the_bridge_adds_the_disable_reason(self):
        for body in ({'reason': 'disable'}, {'reason': 'x'}, {'force': True}):
            with self.subTest(body=body), self.assertRaises(b.BridgeError) as caught:
                b.validate_input('stop', body)
            self.assertEqual(caught.exception.code, 'INVALID_REQUEST')
        self.assertEqual(b.validate_input('stop', {'reason': 'disable'}, b.NODE_FIELDS), {'reason': 'disable'})
        for body in ({'reason': 'upgrade'}, {'reason': None}, {'other': 1}):
            with self.subTest(body=body), self.assertRaises(b.BridgeError):
                b.validate_input('stop', body, b.NODE_FIELDS)

    def test_a_refused_stop_leaves_a_stop_that_was_already_paused_as_it_found_it_enabled(self):
        # A failed earlier stop left the pause behind with the daemon still running: a refusal must not keep it.
        self.bridge.onboarding(create=True)
        with b._state_lock(self.bridge.state_dir):
            record = b._read_json(self.bridge.state_dir / 'onboarding.json')
            record['paused'] = True
            b._write_json(self.bridge.state_dir / 'onboarding.json', record)
        calls, invoke = self.runtime_that_refuses_a_guarded_stop('CONFIG_CORRUPT')
        with patch.object(self.bridge, '_invoke', side_effect=invoke), self.assertRaises(b.BridgeError):
            self.bridge.call('stop', {}, guard_config=True)
        self.assertFalse(json.loads((self.bridge.state_dir / 'onboarding.json').read_text())['paused'])

    def test_other_stop_failures_keep_the_pause_so_the_stop_can_be_retried(self):
        self.bridge.onboarding(create=True)
        with patch.object(self.bridge, '_invoke', side_effect=b.BridgeError('DAEMON_NOT_OWNED')), self.assertRaises(b.BridgeError):
            self.bridge.call('stop', {}, guard_config=True)
        self.assertTrue(self.bridge._pause_requested)
        self.assertEqual((self.bridge._phase, self.bridge._error), ('error', 'DAEMON_NOT_OWNED'))
        self.assertTrue(json.loads((self.bridge.state_dir / 'onboarding.json').read_text())['paused'])

    def test_config_key_paths_reach_the_dashboard_and_nothing_else_of_the_check_does(self):
        shown = b.redact({'configCheck': {'ok': False, 'code': 'CONFIG_INCOMPATIBLE', 'checkedAt': 'now',
                                          'paths': ['daemon.keepAliveSeconds', 'agents.providers.claude.enabled'], 'value': 'hunter2', 'file': '/private/daemon/config.json'}})
        self.assertEqual(shown, {'configCheck': {'ok': False, 'code': 'CONFIG_INCOMPATIBLE', 'checkedAt': 'now',
                                                 'paths': ['daemon.keepAliveSeconds', 'agents.providers.claude.enabled']}})

    def test_status_always_names_a_known_target_and_a_boolean_pending_flag(self):
        decorated = self.bridge._decorate({'selectedTarget': 'evil', 'activeTarget': 'other', 'configurationPending': 'yes'})
        self.assertEqual((decorated['selectedTarget'], decorated['activeTarget'], decorated['configurationPending']), ('paseo', None, False))
        decorated = self.bridge._decorate({'selectedTarget': 'apporo', 'activeTarget': 'paseo', 'configurationPending': True})
        self.assertEqual((decorated['selectedTarget'], decorated['activeTarget'], decorated['configurationPending']), ('apporo', 'paseo', True))
        self.assertEqual(set(b.redact({'selectedTarget': 'apporo', 'activeTarget': 'paseo', 'configurationPending': True, 'appUrl': 'x'})),
                         {'selectedTarget', 'activeTarget', 'configurationPending'})

    def test_an_older_daemon_gets_the_new_runtime_prepared_once_without_being_restarted(self):
        older = {'enabled': True, 'phase': 'running', 'installed': False, 'diagnosticCode': 'RESTART_REQUIRED',
                 'daemon': {'running': True, 'reachable': True}}
        calls = []
        def invoke(action, *_):
            calls.append(action)
            return older if action == 'status' else {**older, 'phase': 'restart_required', 'installed': True}
        with patch.object(self.bridge, '_invoke', side_effect=invoke):
            for _ in range(3):
                self.assertEqual(self.bridge.status()['phase'], 'running')
                if self.bridge._worker is not None:
                    self.bridge._worker.join(2)
        self.assertEqual(calls.count('prepare'), 1, 'prepared once while it keeps succeeding')
        self.assertEqual((calls.count('start'), calls.count('stop')), (0, 0), 'preparing never starts or stops a daemon')
        self.assertFalse((self.bridge.state_dir / 'onboarding.json').exists(), 'preparing never resumes or records onboarding')

    def test_preparation_waits_for_a_reason(self):
        older = {'enabled': True, 'phase': 'running', 'installed': False, 'diagnosticCode': 'RESTART_REQUIRED',
                 'daemon': {'running': True, 'reachable': True}}
        for patch_ in ({'installed': True}, {'diagnosticCode': None}, {'diagnosticCode': 'DAEMON_NOT_OWNED'},
                       {'enabled': False}, {'daemon': {'running': False, 'reachable': False}}, {'installed': None}):
            bridge = b.Bridge(home=Path(self.temp.name) / ('profile-' + str(abs(hash(str(patch_))))))
            with self.subTest(patch=patch_), patch.object(bridge, '_invoke', return_value={**older, **patch_}) as invoke:
                bridge.status()
                self.assertIsNone(bridge._worker)
                self.assertEqual([call.args[0] for call in invoke.call_args_list], ['status'])
        paused = b.Bridge(home=Path(self.temp.name) / 'profile-paused')
        paused.onboarding(create=True)
        with b._state_lock(paused.state_dir):
            record = b._read_json(paused.state_dir / 'onboarding.json')
            record['paused'] = True
            b._write_json(paused.state_dir / 'onboarding.json', record)
        with patch.object(paused, '_invoke', return_value=older) as invoke:
            paused.status()
        self.assertIsNone(paused._worker)
        self.assertEqual([call.args[0] for call in invoke.call_args_list], ['status'])

    def test_a_stop_during_preparation_waits_for_it_and_wins(self):
        older = {'enabled': True, 'phase': 'running', 'installed': False, 'diagnosticCode': 'RESTART_REQUIRED',
                 'daemon': {'running': True, 'reachable': True}}
        entered, release = threading.Event(), threading.Event()
        calls = []
        def invoke(action, *_):
            calls.append(action)
            if action == 'prepare':
                entered.set()
                release.wait(3)
                return {**older, 'phase': 'restart_required'}
            if action == 'stop':
                return {'enabled': False, 'phase': 'disabled', 'daemon': {'running': False, 'reachable': False}}
            return older
        with patch.object(self.bridge, '_invoke', side_effect=invoke):
            self.bridge.status()
            self.assertTrue(entered.wait(2))
            self.assertEqual(self.bridge.call('stop')['phase'], 'stopping')
            release.set()
            self.bridge._worker.join(2)
            self.bridge._stop_worker.join(2)
        self.assertEqual(calls, ['status', 'prepare', 'stop'])

    def test_upgrade_and_target_codes_reach_the_dashboard(self):
        for code in ('CONFIG_INCOMPATIBLE', 'CONFIGURATION_PENDING', 'PAIRING_SECURITY_UNSUPPORTED', 'TERMINAL_CLEANUP_NOT_CONFIRMED',
                     'CONNECTION_STATE_CORRUPT', 'RESTART_REQUIRED', 'INVALID_TARGET'):
            with self.subTest(code=code):
                self.assertEqual(b.redact({'diagnosticCode': code})['diagnosticCode'], code)
                self.assertEqual(b.BridgeError(code).code, code)
        self.assertEqual(b.redact({'daemon': {'version': '0.11.2'}}), {'daemon': {'version': '0.11.2'}})

    def test_install_failures_reach_the_dashboard_as_codes_and_numbers_only(self):
        for code in ('INSUFFICIENT_DISK', 'RUNTIME_INSTALL_FAILED', 'RUNTIME_INSTALL_TIMEOUT', 'RUNTIME_IN_USE'):
            with self.subTest(code=code):
                self.assertEqual(b.BridgeError(code).code, code)
                self.assertEqual(b.redact({'prepare': {'stage': 'failed', 'code': code}})['prepare']['code'], code)
        shown = b.redact({'prepare': {'stage': 'failed', 'code': 'INSUFFICIENT_DISK', 'at': '2026-11-25T00:00:00Z', 'requiredMiB': 1536,
                                      'availableMiB': 100, 'path': '/private/place', 'output': 'npm ERR! secret'}})
        self.assertEqual(shown['prepare'], {'stage': 'failed', 'code': 'INSUFFICIENT_DISK', 'at': '2026-11-25T00:00:00Z',
                                            'requiredMiB': 1536, 'availableMiB': 100})
        self.assertEqual(b.redact({'prepare': {'stage': 'failed', 'code': 'NPM ERR! with /private/path'}})['prepare']['code'], 'OPERATION_FAILED')

    def test_offers_for_every_official_app_are_hidden_in_free_text(self):
        for text in ['open https://smart.woowtech.io/#offer=PRIVATE now', 'https://smart.apporo.ai/#offer=PRIVATE',
                     'https://app.paseo.sh/#offer=PRIVATE', 'mirror https://elsewhere.example/#offer=PRIVATE']:
            with self.subTest(text=text):
                self.assertNotIn('PRIVATE', b.redact({'reply': text})['reply'])

    def test_a_pairing_offer_is_hidden_wherever_its_url_points(self):
        hidden = b.redact({'reply': 'mirror https://elsewhere.example/#offer=PRIVATE-1 and x#connect=PRIVATE-2, end'})['reply']
        self.assertNotIn('PRIVATE', hidden)
        self.assertEqual(hidden.count('[pairing hidden]'), 2)
        self.assertTrue(hidden.endswith(', end') or hidden.endswith(' end'))
        self.assertEqual(b.redact({'reply': 'a plain https://elsewhere.example/page link'})['reply'],
                         'a plain https://elsewhere.example/page link')

    def test_redaction_takes_linear_time_on_the_longest_replies(self):
        """`reply` comes from a model and may be as long as the process output limit, and `re` holds the GIL,
        so a pattern that scans forward from every character stalls the whole Hermes web process. The offer
        pattern once began with an unbounded run before the `#`: 80 KB without one took about 22 seconds."""
        cases = {
            'one unbroken run': 'a' * 80000,
            'a near miss at every position': '#offer' * 13000,
            'an unbroken run of offers': '#offer=' * 11000,
            'spaced offers': '#offer=x ' * 9000,
            'official links': 'https://smart.woowtech.io/#offer=SECRET-1 ' * 2000,
            'foreign links': 'https://elsewhere.example/#offer=SECRET-2 ' * 2000,
            'a scheme at every position': 'https://' * 10000,
            'userinfo without an app host': 'https://' + 'a@' * 40000,
            'a key with endless spacing': 'password' + ' ' * 80000 + 'x',
            'a bearer word with endless spacing': 'bearer' + ' ' * 80000,
            'an assignment then spacing': 'secret=' + ' ' * 80000 + ',',
            'repeated key names': 'api_key ' * 10000,
            'repeated assignments': 'password=x ' * 7000,
        }
        for name, text in cases.items():
            with self.subTest(name):
                started = time.perf_counter()
                result = b.redact({'reply': text})['reply']
                elapsed = time.perf_counter() - started
                self.assertLess(elapsed, 1.0, f'{name} took {elapsed:.2f}s')
                self.assertNotIn('SECRET', result)


class UpgradingRuntime:
    """The runtime's side of an older daemon waiting for the new release. `prepare` installs it, or fails with
    the code a test chooses; a stop is refused until it is installed unless it carries reason `disable`."""

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
            if (value or {}).get('reason') != 'disable' and not self.installed:
                raise b.BridgeError('RUNTIME_NOT_READY')
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
        for failures in range(1, b.RETRY_LIMIT + 1):
            delay = b.RETRY_BACKOFF[min(failures - 1, len(b.RETRY_BACKOFF) - 1)]
            shown = self.bridge.status(fresh=True)
            self.assertEqual(self.bridge._prepare_failures, failures)
            self.assertTrue(delay - 2 <= shown['prepare']['retryInSeconds'] <= delay, (failures, shown['prepare']))
            self.bridge._prepare_retry_at = time.monotonic() - 1
            self.read()
        self.assertEqual(self.runtime.count('prepare'), b.RETRY_LIMIT + 1)
        gave_up = self.bridge.status(fresh=True)
        self.assertIsNone(gave_up['prepare']['retryInSeconds'], 'attempts used up: no countdown is promised')
        self.read()
        self.assertEqual(self.runtime.count('prepare'), b.RETRY_LIMIT + 1)
        # The next retry is the user's: an explicit start tries again at once and recovers when the cause is gone.
        self.runtime.fail = None
        self.bridge.start()
        self.settle()
        shown = self.read()
        self.assertTrue(shown['installed'])
        self.assertEqual(shown['prepare'], {'stage': 'ready'})
        self.assertEqual(self.runtime.count('prepare'), b.RETRY_LIMIT + 2)
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

    def test_a_stop_queued_behind_a_failing_preparation_does_not_stop_paseo(self):
        self.runtime.fail, self.runtime.gate = 'RUNTIME_INSTALL_FAILED', threading.Event()
        self.bridge.onboarding(create=True)
        self.bridge.status(fresh=True)
        self.assertTrue(self.bridge._preparing)
        queued = self.bridge.call('stop', {}, guard_config=True)
        self.assertEqual((queued['enabled'], queued['phase']), (False, 'stopping'))
        self.runtime.gate.set()
        self.settle()
        self.bridge._stop_worker.join(3)
        shown = self.bridge.status(fresh=True)
        self.assertTrue(self.runtime.running, 'Paseo is still up')
        self.assertTrue(shown['enabled'])
        self.assertEqual(shown['phase'], 'running')
        self.assertEqual(shown['stopRefused']['code'], 'RUNTIME_NOT_READY')
        self.assertEqual(shown['prepare']['code'], 'RUNTIME_INSTALL_FAILED')
        self.assertFalse(self.bridge._pause_requested)
        self.assertFalse(json.loads((self.bridge.state_dir / 'onboarding.json').read_text())['paused'])

    def test_a_stop_queued_behind_a_preparation_that_succeeds_goes_ahead(self):
        self.runtime.gate = threading.Event()
        self.bridge.onboarding(create=True)
        self.bridge.status(fresh=True)
        self.bridge.call('stop', {}, guard_config=True)
        self.runtime.gate.set()
        self.settle()
        self.bridge._stop_worker.join(3)
        self.assertFalse(self.runtime.running)
        self.assertTrue(json.loads((self.bridge.state_dir / 'onboarding.json').read_text())['paused'])

    def test_a_user_stop_while_the_release_is_not_installed_is_refused_at_once_with_nothing_paused(self):
        self.runtime.fail = 'RUNTIME_INSTALL_FAILED'
        self.read()
        self.bridge.onboarding(create=True)
        with self.assertRaises(b.BridgeError) as refused:
            self.bridge.call('stop', {}, guard_config=True)
        self.assertEqual(refused.exception.code, 'RUNTIME_NOT_READY')
        self.assertTrue(self.runtime.running)
        self.assertFalse(self.bridge._pause_requested)
        self.assertTrue(self.bridge.status(fresh=True)['enabled'])

    def test_the_host_can_still_disable_and_remove_while_the_release_is_not_installed(self):
        self.runtime.fail = 'RUNTIME_INSTALL_FAILED'
        self.read()
        self.bridge.call('stop', {})  # what the host adapter sends for Disable and Remove
        self.assertFalse(self.runtime.running)
        self.assertEqual(self.runtime.calls[-1], ('stop', {'reason': 'disable'}))

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


class ProcessTests(unittest.TestCase):
    def run_python(self, code, timeout=2, limit=b.MAX_OUTPUT):
        return b.run_process([sys.executable, '-c', code], b'{}', os.environ.copy(), timeout, limit)

    def test_one_object_and_no_shell(self):
        result = self.run_python('import sys,json; value=json.load(sys.stdin); print(json.dumps({"reply":"literal $(echo nope) `id`"}))')
        self.assertIn('$(echo nope)', result['reply'])

    def test_stderr_and_exception_are_redacted(self):
        for code, expected in [('import sys;sys.stderr.write("password=private-test");print("{\\"ok\\":false,\\"code\\":\\"NPM_UNAVAILABLE\\"}");sys.exit(1)', 'NPM_UNAVAILABLE'),
                               ('import sys;sys.stderr.write("private-test");print("{\\"code\\":\\"SECRET_ABC\\"}");sys.exit(1)', 'OPERATION_FAILED')]:
            with self.subTest(expected=expected), self.assertRaises(b.BridgeError) as error:
                self.run_python(code)
            self.assertEqual(error.exception.code, expected)
            self.assertNotIn('private-test', str(error.exception))

    def test_rejects_multiple_objects_invalid_utf8_and_nonobject(self):
        for code in ['print("{}\\n{}")', 'print("[]")', 'import sys;sys.stdout.buffer.write(b"\\xff")', 'print("{\\"ok\\":NaN}")']:
            with self.subTest(code=code), self.assertRaises(b.BridgeError) as error:
                self.run_python(code)
            self.assertEqual(error.exception.code, 'INVALID_COMMAND_OUTPUT')

    def test_both_output_pipes_are_bounded(self):
        for target in ('stdout', 'stderr'):
            with self.subTest(target=target), self.assertRaises(b.BridgeError) as error:
                self.run_python(f'import sys;sys.{target}.write("x"*100000)', limit=4096)
            self.assertEqual(error.exception.code, 'OUTPUT_LIMIT')

    def test_process_group_timeout_kills_descendant(self):
        with tempfile.TemporaryDirectory() as temp:
            pidfile = Path(temp) / 'pid'
            script = ('import subprocess,sys,time; '
                      'child=subprocess.Popen([sys.executable,"-c","import time;time.sleep(30)"]); '
                      f'open({str(pidfile)!r},"w").write(str(child.pid));time.sleep(30)')
            before = time.monotonic()
            with self.assertRaises(b.BridgeError) as error:
                self.run_python(script, timeout=0.3)
            self.assertEqual(error.exception.code, 'PROCESS_TIMEOUT')
            self.assertLess(time.monotonic() - before, 3)
            pid = int(pidfile.read_text())
            for _ in range(30):
                try:
                    status = Path(f'/proc/{pid}/stat').read_text().split(') ')[1].split()[0]
                except (FileNotFoundError, ProcessLookupError):
                    # procfs can report ESRCH if the child is reaped after open.
                    break
                if status == 'Z':
                    break
                time.sleep(0.02)
            else:
                os.kill(pid, signal.SIGKILL)
                self.fail('descendant still running after process-group deadline')


class RegistrationTests(unittest.TestCase):
    def test_public_registration_has_no_process_network_or_state_side_effects(self):
        tools, hooks, commands = {}, {}, {}
        class Context:
            def register_tool(self, **entry): tools[entry['name']] = entry
            def register_hook(self, name, callback): hooks[name] = callback
            def register_command(self, name, callback, **_): commands[name] = callback
        with patch.object(subprocess, 'Popen', side_effect=AssertionError('process in register')), patch.object(socket, 'create_connection', side_effect=AssertionError('network in register')), patch.object(b, 'get_bridge', side_effect=AssertionError('state in register')):
            native.register(Context())
        self.assertEqual(set(tools), {'paseo_status', 'paseo_start', 'paseo_stop', 'paseo_models', 'paseo_chat', 'paseo_continue'})
        self.assertNotIn('paseo_pair', tools)
        self.assertIn('/paseo', commands['paseo'](''))
        self.assertIn('on_session_start', hooks)
        for tool in tools.values():
            self.assertFalse(tool['schema']['parameters']['additionalProperties'])

    def test_native_hook_attaches_real_id_and_skips_acp(self):
        with tempfile.TemporaryDirectory() as temp:
            runtime = b.Bridge(home=Path(temp))
            with patch.object(b, 'get_bridge', return_value=runtime), patch.object(subprocess, 'Popen', side_effect=AssertionError('hook spawn')):
                self.assertIsNone(native._session_start(None, session_id='acp-id', platform='acp'))
                self.assertIsNone(runtime.onboarding()['id'])
                self.assertIn('/paseo', native._session_start(None, session_id='real-session-123', platform='cli'))
                native._session_start(None, session_id='real-session-456', platform='cli')
                self.assertEqual(runtime.onboarding()['sessionId'], 'real-session-123')

    def test_explicit_cli_stop_before_disable_without_pairing_offer(self):
        with tempfile.TemporaryDirectory() as temp:
            runtime = b.Bridge(home=Path(temp))
            with patch.object(b, 'get_bridge', return_value=runtime), patch.object(runtime, '_invoke', return_value={
                'enabled': False, 'phase': 'disabled', 'daemon': {'running': False, 'reachable': False}}) as invoke:
                result = json.loads(native._setup_command('stop'))
                self.assertFalse(result['daemon']['running'])
                # Stopping before a removal is never refused by an upgrade check.
                invoke.assert_called_once_with('stop', {'reason': 'disable'})
                self.assertNotIn('url', result)
        self.assertIn('cannot automatically', native._setup_command(''))
        self.assertIn('/paseo stop', native._setup_command('pair'))

    def test_native_and_dashboard_share_bridge_module(self):
        self.assertIs(native.bridge, api.bridge)


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = b.Bridge(home=Path(self.temp.name))
        self.fake = patch.object(b, 'get_bridge', return_value=self.runtime)
        self.fake.start()
        self.addCleanup(self.fake.stop)
        app = FastAPI()
        app.include_router(api.router, prefix='/api/plugins/hermes-paseo')
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.prefix = '/api/plugins/hermes-paseo'
        self.origin = {'Origin': 'http://testserver'}

    def privacy(self, response):
        self.assertEqual(response.headers['cache-control'], 'no-store')
        self.assertEqual(response.headers['referrer-policy'], 'no-referrer')

    def test_foreign_origin_and_fetch_metadata_rejected_before_bridge(self):
        with patch.object(self.runtime, 'call', side_effect=AssertionError('untrusted invocation')):
            for headers in [{'Origin': 'https://evil.test'}, {'Origin': 'null'}, {'Origin': 'http://testserver', 'Sec-Fetch-Site': 'same-site'},
                            {'Origin': 'http://testserver', 'Sec-Fetch-Site': 'cross-site'}, {}, {'Origin': 'http://testserver.evil'},
                            {'Origin': 'http://testserver', 'Sec-Fetch-Mode': 'no-cors'}]:
                response = self.client.post(self.prefix + '/pair', json={}, headers=headers)
                self.assertEqual(response.status_code, 403)
                self.privacy(response)

    def test_relay_route_is_origin_protected_and_returns_status_only(self):
        with patch.object(self.runtime, 'call', side_effect=AssertionError('untrusted invocation')):
            response = self.client.post(self.prefix + '/relay', json={}, headers={'Origin': 'https://evil.test'})
        self.assertEqual(response.status_code, 403)
        self.privacy(response)
        with patch.object(self.runtime, '_invoke', return_value={'daemon': {'relayVerified': True, 'relayVerifiedAt': 'now'}}) as invoke:
            response = self.client.post(self.prefix + '/relay', json={}, headers=self.origin)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['daemon']['relayVerified'])
        invoke.assert_called_once_with('relay', {})
        with patch.object(self.runtime, '_invoke', side_effect=b.BridgeError('RELAY_UNVERIFIED')):
            response = self.client.post(self.prefix + '/relay', json={}, headers=self.origin)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {'ok': False, 'code': 'RELAY_UNVERIFIED'})

    def test_config_route_is_protected_like_every_mutation(self):
        with patch.object(self.runtime, 'call', side_effect=AssertionError('untrusted invocation')):
            for headers in [{'Origin': 'https://evil.test'}, {}, {'Origin': 'http://testserver', 'Sec-Fetch-Site': 'cross-site'},
                            {'Origin': 'http://testserver', 'Sec-Fetch-Site': 'same-site'},
                            {'Origin': 'http://testserver', 'Sec-Fetch-Mode': 'no-cors'}, {'Origin': 'null'}]:
                response = self.client.post(self.prefix + '/config', json={'target': 'woowtech'}, headers=headers)
                self.assertEqual(response.status_code, 403, headers)
                self.privacy(response)
            for body in ['{"target":"custom"}', '{}', '{"target":"paseo","extra":1}',
                         '{"target":"paseo","target":"woowtech"}', '[]', '{"target":null}']:
                response = self.client.post(self.prefix + '/config', content=body,
                                            headers={**self.origin, 'Content-Type': 'application/json'})
                self.assertEqual(response.status_code, 400, body)
                self.privacy(response)
            response = self.client.post(self.prefix + '/config', content='{"target":"apporo"}',
                                        headers={**self.origin, 'Content-Type': 'text/plain'})
            self.assertEqual(response.status_code, 415)
            self.assertEqual(self.client.post(self.prefix + '/config?profile=other', json={'target': 'apporo'},
                                              headers=self.origin).status_code, 400)
        with patch.object(self.runtime, '_invoke', return_value={'saved': True, 'target': 'woowtech', 'configurationPending': True}) as invoke:
            response = self.client.post(self.prefix + '/config?profile=default', json={'target': 'woowtech'},
                                        headers={'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'saved': True, 'target': 'woowtech', 'configurationPending': True})
        invoke.assert_called_once_with('config', {'target': 'woowtech'})
        self.privacy(response)
        with patch.object(self.runtime, '_invoke', side_effect=b.BridgeError('RUNTIME_BUSY')):
            response = self.client.post(self.prefix + '/config', json={'target': 'woowtech'}, headers=self.origin)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {'ok': False, 'code': 'RUNTIME_BUSY'})
        self.assertEqual(self.client.get(self.prefix + '/config').status_code, 404)

    def test_pair_route_answers_for_the_saved_target_and_refuses_a_pending_switch(self):
        with patch.object(self.runtime, 'call', return_value={'url': 'https://smart.apporo.ai/#offer=x', 'target': 'apporo'}):
            response = self.client.post(self.prefix + '/pair', json={}, headers=self.origin)
        self.assertEqual(response.json(), {'url': 'https://smart.apporo.ai/#offer=x', 'target': 'apporo'})
        with patch.object(self.runtime, '_invoke', side_effect=b.BridgeError('CONFIGURATION_PENDING')):
            response = self.client.post(self.prefix + '/pair', json={}, headers=self.origin)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {'ok': False, 'code': 'CONFIGURATION_PENDING'})
        self.privacy(response)

    def test_the_dashboard_stop_is_a_guarded_user_stop_and_a_refusal_says_so_without_changing_anything(self):
        self.runtime.onboarding(create=True)
        calls = []
        def invoke(action, value=None):
            calls.append((action, value))
            raise b.BridgeError('CONFIG_INCOMPATIBLE')
        with patch.object(self.runtime, '_invoke', side_effect=invoke):
            response = self.client.post(self.prefix + '/stop', json={}, headers=self.origin)
        self.assertEqual(calls, [('stop', None)])
        self.assertEqual(response.status_code, 412)
        self.assertEqual(response.json(), {'ok': False, 'code': 'CONFIG_INCOMPATIBLE'})
        self.privacy(response)
        self.assertFalse(json.loads((self.runtime.state_dir / 'onboarding.json').read_text())['paused'])
        with patch.object(self.runtime, '_invoke', return_value={'enabled': False, 'phase': 'disabled', 'daemon': {'running': False}}):
            self.assertEqual(self.client.post(self.prefix + '/stop', json={}, headers=self.origin).status_code, 200)
        # A failure that is not a refusal stays a service error.
        with patch.object(self.runtime, '_invoke', side_effect=b.BridgeError('DAEMON_NOT_OWNED')):
            self.assertEqual(self.client.post(self.prefix + '/stop', json={}, headers=self.origin).status_code, 503)

    def test_a_request_cannot_ask_for_the_unguarded_stop(self):
        with patch.object(self.runtime, '_invoke', side_effect=AssertionError('untrusted invocation')):
            for body in ('{"reason":"disable"}', '{"guard_config":false}', '{"force":true}'):
                response = self.client.post(self.prefix + '/stop', content=body, headers={**self.origin, 'Content-Type': 'application/json'})
                self.assertEqual(response.status_code, 400, body)

    def test_get_security_applies_to_status_and_models(self):
        with patch.object(self.runtime, '_invoke', side_effect=AssertionError('untrusted invocation')):
            for path in ('/status', '/models/hermes'):
                response = self.client.get(self.prefix + path, headers={'Origin': 'https://evil.test'})
                self.assertEqual(response.status_code, 403)
                self.privacy(response)

    def configure_origin(self, value):
        b._private_dir(self.runtime.state_dir)
        file = self.runtime.state_dir / 'dashboard-origin.json'
        b._write_json(file, value)
        return file

    def test_configured_https_origin_accepts_http_reverse_proxy_without_trusting_headers(self):
        self.configure_origin({'origin': 'https://dashboard.example:8443'})
        with patch.object(self.runtime, '_invoke', return_value={'url': 'https://app.paseo.sh/?offer=test'}):
            response = self.client.post(self.prefix + '/pair', json={}, headers={
                'Origin': 'https://dashboard.example:8443', 'Sec-Fetch-Site': 'same-origin'})
        self.assertEqual(response.status_code, 200)
        self.privacy(response)

    def test_configured_origin_still_rejects_foreign_scheme_port_credentials_and_fetch_site(self):
        self.configure_origin({'origin': 'https://dashboard.example:8443'})
        with patch.object(self.runtime, '_invoke', side_effect=AssertionError('untrusted invocation')):
            for headers in [
                {'Origin': 'https://evil.test'}, {'Origin': 'http://dashboard.example:8443'},
                {'Origin': 'https://dashboard.example'}, {'Origin': 'https://dashboard.example:8443.evil'},
                {'Origin': 'https://user@dashboard.example:8443'},
                {'Origin': 'https://dashboard.example:8443', 'Sec-Fetch-Site': 'cross-site'},
                {'Origin': 'http://testserver', 'X-Forwarded-Host': 'dashboard.example:8443', 'X-Forwarded-Proto': 'https'},
            ]:
                response = self.client.post(self.prefix + '/pair', json={}, headers=headers)
                self.assertEqual(response.status_code, 403)
                self.privacy(response)

    def test_forwarded_origin_is_not_authority_without_operator_configuration(self):
        response = self.client.post(self.prefix + '/pair', json={}, headers={
            'Origin': 'https://dashboard.example', 'X-Forwarded-Host': 'dashboard.example',
            'X-Forwarded-Proto': 'https', 'Sec-Fetch-Site': 'same-origin'})
        self.assertEqual(response.status_code, 403)
        self.privacy(response)

    def test_origin_file_requires_private_permissions_valid_schema_and_no_symlink(self):
        with patch.object(self.runtime, '_invoke', side_effect=AssertionError('invalid origin invocation')):
            for value in [{'origin': 'https://user:password@dashboard.example'},
                          {'origin': 'https://dashboard.example/path'},
                          {'origin': 'https://dashboard.example', 'unexpected': True}]:
                self.configure_origin(value)
                response = self.client.post(self.prefix + '/pair', json={}, headers=self.origin)
                self.assertEqual(response.status_code, 503)
                self.privacy(response)
            file = self.configure_origin({'origin': 'http://testserver'})
            file.chmod(0o666)
            self.assertEqual(self.client.post(self.prefix + '/pair', json={}, headers=self.origin).status_code, 503)
            file.unlink()
            target = Path(self.temp.name) / 'origin-target.json'
            target.write_text('{"origin":"http://testserver"}')
            file.symlink_to(target)
            self.assertEqual(self.client.post(self.prefix + '/pair', json={}, headers=self.origin).status_code, 503)

    def test_json_size_unknown_fields_and_encoding(self):
        with patch.object(self.runtime, '_invoke', side_effect=AssertionError('invalid body invocation')):
            for body, headers, expected in [('{}', {'Content-Type': 'text/plain'}, 415), ('{"provider":"hermes"}', {'Content-Type': 'application/json'}, 400),
                                           ('[]', {'Content-Type': 'application/json'}, 400), ('{"x":NaN}', {'Content-Type': 'application/json'}, 400),
                                           ('{"x":1,"x":2}', {'Content-Type': 'application/json'}, 400), ('x' * 16385, {'Content-Type': 'application/json'}, 413),
                                           ('{}', {'Content-Type': 'application/json', 'Content-Encoding': 'gzip'}, 415)]:
                response = self.client.post(self.prefix + '/start', content=body, headers={**self.origin, **headers})
                self.assertEqual(response.status_code, expected)
                self.privacy(response)

    def test_fetch_metadata_permits_sdk_post_without_origin(self):
        with patch.object(self.runtime, '_invoke', return_value={'url': 'https://app.paseo.sh/?offer=test'}):
            response = self.client.post(self.prefix + '/pair', json={},
                                        headers={'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors'})
        self.assertEqual(response.status_code, 200)
        self.privacy(response)

    def test_stream_limit_is_checked_even_with_false_content_length(self):
        response = self.client.post(self.prefix + '/start', content=iter([b'x' * 16385]),
                                    headers={**self.origin, 'Content-Type': 'application/json',
                                             'Content-Length': '2'})
        self.assertEqual(response.status_code, 413)
        self.privacy(response)

    def test_start_returns_pending_and_checkpoints_before_failure(self):
        release = threading.Event()
        def invoke(*_):
            release.wait(2)
            raise b.BridgeError('NODE_UNAVAILABLE')
        with patch.object(self.runtime, '_invoke', side_effect=invoke):
            response = self.client.post(self.prefix + '/start', json={}, headers=self.origin)
            self.assertEqual(response.status_code, 202)
            self.assertEqual(response.json()['phase'], 'installing')
            self.assertTrue(response.json()['onboarding']['required'])
            self.assertIsNotNone(response.json()['onboarding']['id'])
            self.privacy(response)
            release.set()
            self.runtime._worker.join(2)

    def test_pair_only_returns_valid_https_url(self):
        with patch.object(self.runtime, '_invoke', return_value={'url': 'https://app.paseo.sh/?offer=test'}):
            response = self.client.post(self.prefix + '/pair', json={}, headers=self.origin)
        self.assertEqual(response.json(), {'url': 'https://app.paseo.sh/?offer=test'})
        self.privacy(response)

    def test_backend_error_redaction_and_privacy(self):
        with patch.object(self.runtime, '_invoke', side_effect=RuntimeError('stderr password=private-test')):
            response = self.client.get(self.prefix + '/models/hermes')
        self.assertEqual(response.status_code, 503)
        self.assertNotIn('private-test', response.text)
        self.privacy(response)

    def test_query_profile_cannot_cross_old_host_launch_profile(self):
        for query in ('profile=other', 'profile=default&profile=other', 'profile=default&extra=1', 'profile='):
            response = self.client.get(self.prefix + '/status?' + query)
            self.assertEqual(response.status_code, 400)
            self.privacy(response)

    def test_new_sdk_default_profile_alias_stays_in_the_launch_profile(self):
        with patch.object(self.runtime, '_invoke', return_value={'enabled': False, 'phase': 'disabled', 'providers': []}):
            response = self.client.get(self.prefix + '/status?profile=default')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['phase'], 'disabled')
        with patch.object(self.runtime, 'call', return_value={'url': 'https://app.paseo.sh/?offer=test'}) as call:
            response = self.client.post(self.prefix + '/pair?profile=default', json={}, headers=self.origin)
            self.assertEqual(response.status_code, 200)
            call.assert_called_once_with('pair', {}, allow_pair=True)

    def test_status_shape_and_models(self):
        with patch.object(self.runtime, '_invoke', return_value={'enabled': False, 'phase': 'disabled', 'providers': []}):
            response = self.client.get(self.prefix + '/status')
            self.assertIn('onboarding', response.json())
            self.assertIn('daemon', response.json())
            self.privacy(response)
        response = self.client.get(self.prefix + '/models/unknown')
        self.assertEqual(response.status_code, 400)
        self.privacy(response)

    def test_acceptance_submission_returns_a_job_and_polling_never_runs_models(self):
        receipt = {'jobId': 'a' * 32, 'phase': 'running', 'pending': True, 'result': None, 'code': None}
        with patch.object(self.runtime, 'start_acceptance', return_value=receipt) as start:
            response = self.client.post(self.prefix + '/acceptance?profile=default', json={}, headers=self.origin)
            self.assertEqual(response.status_code, 202)
            self.assertEqual(response.json(), receipt)
            self.privacy(response)
            start.assert_called_once_with({})
        with patch.object(self.runtime, 'acceptance_status', return_value=receipt), patch.object(self.runtime, '_invoke', side_effect=AssertionError('poll must not run a model')):
            response = self.client.get(self.prefix + '/acceptance?profile=default')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), receipt)
            self.privacy(response)
        with patch.object(self.runtime, 'start_acceptance', side_effect=AssertionError('foreign origin job')):
            self.assertEqual(self.client.post(self.prefix + '/acceptance', json={}, headers={'Origin': 'https://evil.test'}).status_code, 403)

    def test_wrong_method_and_missing_path_have_privacy_headers(self):
        for response in [self.client.get(self.prefix + '/pair'), self.client.get(self.prefix + '/missing')]:
            self.assertEqual(response.status_code, 404)
            self.privacy(response)


if __name__ == '__main__':
    unittest.main()


class NativeCommandTests(unittest.TestCase):
    def test_start_command_invokes_the_same_profile_bridge_and_keeps_acp_guard(self):
        runtime = unittest.mock.Mock()
        runtime.call.return_value = {'phase': 'installing', 'enabled': True}
        with patch.object(native.bridge, 'get_bridge', return_value=runtime):
            self.assertEqual(json.loads(native._setup_command('start'))['phase'], 'installing')
            runtime.call.assert_called_once_with('start', {})
            runtime.reset_mock()
            with patch.dict(os.environ, {'HERMES_PASEO_ACP_CHILD': '1'}):
                self.assertEqual(json.loads(native._setup_command('start'))['code'], 'INVALID_REQUEST')
                runtime.call.assert_not_called()

    def test_stop_and_status_call_profile_bridge(self):
        runtime = unittest.mock.Mock()
        runtime.call.return_value = {'phase': 'disabled', 'daemon': {'running': False}}
        with patch.object(native.bridge, 'get_bridge', return_value=runtime):
            self.assertFalse(json.loads(native._setup_command('stop'))['daemon']['running'])
            native._setup_command('status')
        self.assertEqual(runtime.call.call_args_list, [unittest.mock.call('stop', {}), unittest.mock.call('status', {})])

    def test_pair_and_arbitrary_commands_never_execute_or_echo_input(self):
        with patch.object(native.bridge, 'get_bridge', side_effect=AssertionError('must not execute')):
            result = native._setup_command('pair private-marker')
            self.assertNotIn('private-marker', result)
            native._setup_command('exec touch /tmp/unsafe')
