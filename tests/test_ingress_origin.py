"""Exercise the same bounded origin policy at plugin, host and native routes."""
import asyncio
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
PRIMARY = 'http://192.0.2.40:8080'
INGRESS = 'https://ha.example:8123'
SETTING = 'HERMES_PASEO_INGRESS_ORIGIN'
INVALID = (
    '', ' ', '*', 'null', 'ha.example:8123', '//ha.example', 'ftp://ha.example',
    'https://', 'https://*.example', 'https://ha.*', 'https://user@ha.example',
    'https://user:password@ha.example', 'https://@ha.example', 'https://:@ha.example',
    'https://ha.example/', 'https://ha.example/api/hassio_ingress/token',
    'https://ha.example?x=1', 'https://ha.example?', 'https://ha.example#fragment',
    'https://ha.example#', 'https://ha.example:0', 'https://ha.example:65536',
    'https://ha.example:', 'https://ha.example:abc', 'https://ha.example\\evil',
    ' https://ha.example', 'https://ha.example\n', 'https://ha.\texample',
    'https://ha.example\x00', 'https://ha.example\x7f', 'https://ha%2eexample',
    'https://ha.example,https://other.example', 'https://ha.example https://other.example',
    'https://[::1', 'https://[::1]evil', 'https://[fe80::1%25eth0]',
    'https://-bad.example', 'https://bad..example', 'https://' + 'a' * 2048,
)


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


api = load('ingress_plugin_api', 'dashboard/plugin_api.py')
host = load('ingress_dashboard_control', 'host/dashboard_control.py')
bridge = api.bridge


class OriginSyntaxTests(unittest.TestCase):
    def test_independent_host_and_plugin_parsers_accept_only_origins(self):
        for value in (*INVALID, None, 123, [], {}):
            with self.subTest(value=value):
                with self.assertRaises(bridge.BridgeError):
                    bridge.validate_dashboard_origin(value)
                self.assertIsNone(host.origin(value))
        for value, expected in (
            (PRIMARY, ('http', '192.0.2.40', 8080)),
            (INGRESS, ('https', 'ha.example', 8123)),
            ('https://HA.Example:443', ('https', 'ha.example', 443)),
            ('http://homeassistant.local', ('http', 'homeassistant.local', 80)),
            ('https://xn--bcher-kva.example', ('https', 'xn--bcher-kva.example', 443)),
            ('http://[::1]:8123', ('http', '::1', 8123)),
        ):
            with self.subTest(value=value):
                self.assertEqual(bridge.validate_dashboard_origin(value), value)
                self.assertEqual(api._origin(value), expected)
                self.assertEqual(host.origin(value), expected)


class IngressRouteTests(unittest.TestCase):
    plugin_prefix = '/api/plugins/hermes-paseo'
    disable = '/api/dashboard/agent-plugins/hermes-paseo/disable'
    remove = '/api/dashboard/agent-plugins/hermes-paseo'
    routes = (
        ('GET', plugin_prefix + '/status', None),
        ('GET', plugin_prefix + '/models/hermes', None),
        ('POST', plugin_prefix + '/pair', {}),
        ('POST', plugin_prefix + '/start', {}),
        ('POST', plugin_prefix + '/stop', {}),
        ('GET', plugin_prefix + '/acceptance', None),
        ('POST', plugin_prefix + '/acceptance', {}),
        ('GET', host.PREFIX + '/capabilities', None),
        ('POST', host.PREFIX + '/reload', {'confirm': True}),
        ('POST', disable, None),
        ('DELETE', remove, None),
    )

    def setUp(self):
        self.addCleanup(patch.stopall)
        patch.dict(os.environ).start()
        os.environ.pop(SETTING, None)
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.runtime = bridge.Bridge(home=Path(temp.name))
        self.runtime.set_dashboard_origin(PRIMARY)
        patch.object(bridge, 'get_bridge', return_value=self.runtime).start()
        self.operations = []
        for name in ('status', 'call', 'start', 'start_acceptance', 'acceptance_status'):
            mock = patch.object(self.runtime, name, return_value={'ok': True, 'pending': False}).start()
            self.operations.append(mock)
        self.order = []
        async def run():
            await asyncio.Event().wait()
        self.life = SimpleNamespace(
            run=run, error=None,
            stop_for_disable=Mock(side_effect=lambda _: self.order.append('stopped')),
            mark_disabled=Mock(side_effect=lambda: self.order.append('recorded')),
        )
        self.signaler = Mock()
        self.control = host.Control(lambda: os.getpid(), self.signaler, delay=0)
        self.operations += [self.life.stop_for_disable, self.life.mark_disabled, self.signaler]
        app = FastAPI()
        @app.middleware('http')
        async def native_auth(request, call_next):
            if request.headers.get('x-test-session') != 'valid':
                return JSONResponse({'detail': 'UNAUTHORIZED'}, status_code=401)
            request.state.authenticated = True
            return await call_next(request)
        def require_auth(request):
            if not getattr(request.state, 'authenticated', False):
                raise HTTPException(401)
        @app.post(self.disable)
        def disable():
            self.order.append('disabled')
            return {'ok': True}
        @app.delete(self.remove)
        def remove():
            self.order.append('removed')
            return {'ok': True}
        app.include_router(api.router, prefix=self.plugin_prefix)
        host.install(SimpleNamespace(app=app, _require_token=require_auth),
                     enabled=lambda: True, public_origin=lambda: PRIMARY,
                     control=self.control, lifecycle=self.life)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.headers = {'x-test-session': 'valid', 'origin': PRIMARY, 'sec-fetch-site': 'same-origin'}

    def request(self, route, headers, suffix=''):
        method, path, body = route
        kwargs = {'json': body} if body is not None else {}
        return self.client.request(method, path + suffix, headers=headers, **kwargs)

    def assert_no_actions(self):
        for operation in self.operations:
            operation.assert_not_called()
        self.assertEqual(self.order, [])

    def test_lan_and_ingress_work_without_replacing_private_primary(self):
        os.environ[SETTING] = INGRESS
        origin_file = self.runtime.state_dir / 'dashboard-origin.json'
        before = origin_file.read_bytes(), origin_file.stat()
        for origin in (PRIMARY, INGRESS):
            self.control.pending = False
            self.order.clear()
            for route in self.routes:
                with self.subTest(origin=origin, route=route[:2]):
                    response = self.request(route, {**self.headers, 'origin': origin})
                    self.assertIn(response.status_code, (200, 202), response.text)
            self.assertEqual(self.order, ['stopped', 'disabled', 'recorded', 'stopped', 'removed', 'recorded'])
        self.assertEqual(self.signaler.call_count, 2)
        self.assertEqual(self.runtime.dashboard_origin(), PRIMARY)
        self.assertEqual((origin_file.read_bytes(), origin_file.stat()), before)

    def test_ingress_is_optional_and_cannot_be_supplied_by_forwarded_headers(self):
        headers = {**self.headers, 'origin': INGRESS,
                   'forwarded': 'proto=https;host=ha.example:8123',
                   'x-forwarded-host': 'ha.example:8123', 'x-forwarded-proto': 'https',
                   'x-ingress-path': '/api/hassio_ingress/test'}
        for route in self.routes:
            with self.subTest(route=route[:2]):
                self.assertEqual(self.request(route, headers).status_code, 403)
        self.assert_no_actions()

    def test_foreign_and_malformed_request_origins_never_dispatch(self):
        os.environ[SETTING] = INGRESS
        for origin in ('https://foreign.example', 'http://ha.example:8123',
                       'https://ha.example', 'https://ha.example:8124',
                       'https://ha.example.evil:8123', 'https://ha.example:8123/',
                       'https://@ha.example:8123', 'https://ha.example:8123?', '', 'null'):
            for route in self.routes:
                with self.subTest(origin=origin, route=route[:2]):
                    response = self.request(route, {**self.headers, 'origin': origin,
                        'x-forwarded-host': 'ha.example:8123', 'x-forwarded-proto': 'https'})
                    self.assertEqual(response.status_code, 403)
        self.assert_no_actions()

    def test_fetch_metadata_and_auth_still_apply_to_both_origins(self):
        os.environ[SETTING] = INGRESS
        for origin in (PRIMARY, INGRESS):
            headers = {**self.headers, 'origin': origin}
            for overrides, status in (({'sec-fetch-site': 'cross-site'}, 403),
                                      ({'sec-fetch-site': 'same-site'}, 403),
                                      ({'sec-fetch-mode': 'no-cors'}, 403),
                                      ({'sec-fetch-mode': 'navigate'}, 403),
                                      ({'x-test-session': None}, 401)):
                for route in self.routes:
                    with self.subTest(origin=origin, overrides=overrides, route=route[:2]):
                        request_headers = {key: value for key, value in {**headers, **overrides}.items()
                                           if value is not None}
                        self.assertEqual(self.request(route, request_headers).status_code, status)
        self.assert_no_actions()

    def test_malformed_env_fails_closed_even_without_origin(self):
        for value in INVALID:
            if '\x00' in value:  # The OS rejects NUL; parser coverage is above.
                continue
            os.environ[SETTING] = value
            for origin in (PRIMARY, INGRESS, None):
                headers = {**self.headers, 'origin': origin}
                if origin is None:
                    headers.pop('origin')
                for route in self.routes:
                    with self.subTest(value=value, origin=origin, route=route[:2]):
                        response = self.request(route, headers)
                        expected = 400 if route[1].startswith(self.plugin_prefix) else 503
                        self.assertEqual(response.status_code, expected, response.text)
                        self.assertIn('INVALID_DASHBOARD_ORIGIN', response.text)
        self.assert_no_actions()

    def test_unset_setting_restores_primary_only_and_legacy_base_url_fallback(self):
        route = ('POST', self.plugin_prefix + '/pair', {})
        os.environ[SETTING] = INGRESS
        self.assertEqual(self.request(route, {**self.headers, 'origin': INGRESS}).status_code, 200)
        del os.environ[SETTING]
        self.assertEqual(self.request(route, {**self.headers, 'origin': INGRESS}).status_code, 403)
        self.assertEqual(self.request(route, self.headers).status_code, 200)
        (self.runtime.state_dir / 'dashboard-origin.json').unlink()
        self.assertEqual(self.request(route, {**self.headers, 'origin': 'http://testserver'}).status_code, 200)
        os.environ[SETTING] = INGRESS
        self.assertEqual(self.request(route, {**self.headers, 'origin': INGRESS}).status_code, 200)
        self.assertIsNone(self.runtime.dashboard_origin())

    def test_sdk_without_origin_keeps_metadata_requirement(self):
        os.environ[SETTING] = INGRESS
        headers = {key: value for key, value in self.headers.items() if key != 'origin'}
        for route in self.routes:
            if route[0] != 'GET':
                with self.subTest(route=route[:2]):
                    self.assertEqual(self.request(route, {'x-test-session': 'valid'}).status_code, 403)
        self.assert_no_actions()
        for route in self.routes:
            self.assertIn(self.request(route, headers).status_code, (200, 202))

    def test_query_and_duplicate_security_headers_cannot_bypass_ingress_guard(self):
        os.environ[SETTING] = INGRESS
        headers = {**self.headers, 'origin': INGRESS}
        for route in self.routes:
            for query in ('?profile=other', '?profile=default&profile=other', '?unexpected=1'):
                with self.subTest(route=route[:2], query=query):
                    self.assertEqual(self.request(route, headers, query).status_code, 400)
            for key in ('origin', 'sec-fetch-site', 'sec-fetch-mode', 'host', 'content-encoding'):
                duplicates = list(headers.items()) + [(key, 'same-origin' if key != 'origin' else PRIMARY)]
                if key not in headers:
                    duplicates += [(key, 'duplicate')]
                with self.subTest(route=route[:2], header=key):
                    self.assertEqual(self.request(route, duplicates).status_code, 400)
        self.assert_no_actions()

    def test_ingress_does_not_relax_body_validation_or_profile_alias(self):
        os.environ[SETTING] = INGRESS
        headers = {**self.headers, 'origin': INGRESS, 'content-type': 'application/json'}
        for path in (self.plugin_prefix + '/start', host.PREFIX + '/reload'):
            for content, status in (('{"unexpected":true}', 400), ('[]', 400),
                                     ('{"confirm":true,"confirm":true}', 400), ('x' * 16385, 413)):
                with self.subTest(path=path, content=content[:40]):
                    response = self.client.post(path, headers=headers, content=content)
                    self.assertEqual(response.status_code, status)
        self.assert_no_actions()
        self.assertEqual(self.client.post(self.plugin_prefix + '/pair?profile=default',
                                         headers=headers, json={}).status_code, 200)
        for route in self.routes[7:]:
            self.assertEqual(self.request(route, headers, '?profile=default').status_code, 400)

    def test_ingress_cannot_hide_a_bad_private_primary_or_missing_host_primary(self):
        os.environ[SETTING] = INGRESS
        origin_file = self.runtime.state_dir / 'dashboard-origin.json'
        origin_file.chmod(0o666)
        for headers in ({**self.headers, 'origin': INGRESS}, {'sec-fetch-site': 'same-origin', 'x-test-session': 'valid'}):
            self.assertEqual(self.client.post(self.plugin_prefix + '/pair', headers=headers, json={}).status_code, 503)
        # An unusable public URL now says so instead of returning an empty set that
        # read as ORIGIN_DENIED to a browser and as "nothing to compare" to anything
        # without an Origin header. The invariant this test exists for is unchanged:
        # the ingress origin never substitutes for the primary.
        for primary in ('', 'not an origin', PRIMARY + '/dashboard'):
            with self.subTest(primary=primary):
                with self.assertRaises(HTTPException) as caught:
                    host.allowed_origins(primary)
                self.assertEqual((caught.exception.status_code, caught.exception.detail),
                                 (503, 'INVALID_DASHBOARD_ORIGIN'))
                self.assertEqual(host.allowed_origins(primary, required=False), set())
        self.assertEqual(host.allowed_origins(PRIMARY + '/'), {host.origin(PRIMARY), host.origin(INGRESS)})
        self.assert_no_actions()


if __name__ == '__main__':
    unittest.main()
