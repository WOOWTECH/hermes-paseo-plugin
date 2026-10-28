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
        self.assertEqual(b.public_pair({'url': 'https://app.paseo.sh/?offer=test', 'token': 'secret'}), {'url': 'https://app.paseo.sh/?offer=test'})
        for url in ['http://app.paseo.sh/a', 'https://app.paseo.sh.evil/a', 'https://user@app.paseo.sh/a',
                    'https://app.paseo.sh:444/a', 'https://app.paseo.sh/\nsecret', 'javascript:test']:
            with self.subTest(url=url), self.assertRaises(b.BridgeError):
                b.public_pair({'url': url})


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
                invoke.assert_called_once_with('stop')
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
