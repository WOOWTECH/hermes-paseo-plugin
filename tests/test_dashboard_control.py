import importlib.util
import os
import signal
import asyncio
import unittest
from pathlib import Path
from unittest.mock import Mock
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

path = Path(__file__).resolve().parents[1] / 'host/dashboard_control.py'
spec = importlib.util.spec_from_file_location('test_dashboard_control', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DashboardControlTests(unittest.TestCase):
    def setUp(self):
        self.signaler = Mock()
        self.pid_reader = Mock(return_value=os.getpid())
        self.control = module.Control(self.pid_reader, self.signaler, delay=0)
        self.enabled = True
        def require_auth(request):
            if request.headers.get('x-test-session') != 'valid':
                raise HTTPException(401)
        app = FastAPI()
        app.include_router(module.make_router(require_auth, lambda: 'https://hermes.test',
                                             lambda: self.enabled, self.control))
        self.client = TestClient(app)
        self.headers = {'x-test-session': 'valid', 'origin': 'https://hermes.test',
                        'sec-fetch-site': 'same-origin'}

    def post(self, **kwargs):
        return self.client.post(module.PREFIX + '/reload', headers=self.headers, **kwargs)

    def test_host_capability_and_reload_work_without_plugin_backend(self):
        r = self.client.get(module.PREFIX + '/capabilities', headers=self.headers)
        self.assertTrue(r.json()['supported'])
        self.assertEqual(self.client.get('/api/plugins/hermes-paseo/status').status_code, 404)
        r = self.post(json={'confirm': True})
        self.assertEqual(r.status_code, 202)
        self.assertEqual(r.json()['generation'], self.control.generation)
        self.signaler.assert_called_once_with(os.getpid(), signal.SIGTERM)
        self.assertEqual(r.headers['cache-control'], 'no-store')

    def test_unauthenticated_and_disabled_never_signal(self):
        self.assertEqual(self.client.post(module.PREFIX + '/reload', json={'confirm': True}).status_code, 401)
        self.enabled = False
        self.assertEqual(self.post(json={'confirm': True}).status_code, 403)
        self.signaler.assert_not_called()

    def test_cross_site_missing_origin_and_forwarded_headers_never_signal(self):
        for headers in ({**self.headers, 'origin': 'https://evil.test'},
                        {**self.headers, 'sec-fetch-site': 'cross-site'},
                        {'x-test-session': 'valid', 'x-forwarded-host': 'hermes.test',
                         'x-forwarded-proto': 'https'}):
            r = self.client.post(module.PREFIX + '/reload', headers=headers, json={'confirm': True})
            self.assertEqual(r.status_code, 403)
        self.signaler.assert_not_called()

    def test_scope_confirmation_and_size_are_closed(self):
        for body in ({}, {'confirm': False}, {'confirm': 1}, {'confirm': True, 'pid': 1}, []):
            self.assertEqual(self.post(json=body).status_code, 400)
        headers = {**self.headers, 'content-type': 'application/json'}
        for body, status in (('{"confirm":true,"confirm":true}', 400), ('x' * 129, 413)):
            r = self.client.post(module.PREFIX + '/reload', headers=headers, content=body)
            self.assertEqual(r.status_code, status)
        self.assertEqual(self.client.post(module.PREFIX + '/reload?profile=other',
                                         headers=self.headers, json={'confirm': True}).status_code, 400)
        self.signaler.assert_not_called()

    def test_duplicate_request_and_wrong_supervisor_never_restart_again(self):
        self.assertEqual(self.post(json={'confirm': True}).status_code, 202)
        self.assertEqual(self.post(json={'confirm': True}).status_code, 409)
        self.assertEqual(self.signaler.call_count, 1)
        self.control.pending = False
        self.pid_reader.return_value = os.getpid() + 1
        self.assertEqual(self.post(json={'confirm': True}).status_code, 503)
        self.assertEqual(self.signaler.call_count, 1)

    def test_supervisor_is_rechecked_and_signal_failure_allows_retry(self):
        self.pid_reader.side_effect = [os.getpid(), os.getpid() + 1]
        self.assertEqual(self.post(json={'confirm': True}).status_code, 202)
        self.signaler.assert_not_called()
        self.assertFalse(self.control.pending)
        self.pid_reader.side_effect = None
        self.signaler.side_effect = PermissionError()
        self.assertEqual(self.post(json={'confirm': True}).status_code, 202)
        self.assertFalse(self.control.pending)

    def test_native_install_places_control_before_spa_and_is_idempotent(self):
        app = FastAPI()
        @app.get('/{full_path:path}')
        def spa(full_path):
            return {'spa': True}
        server = SimpleNamespace(app=app, _require_token=lambda request: None)
        for _ in range(2):
            module.install(server, lambda: True, lambda: 'https://hermes.test', self.control)
        client = TestClient(app)
        r = client.get(module.PREFIX + '/capabilities', headers=self.headers)
        self.assertTrue(r.json()['supported'])
        self.assertNotIn('spa', r.json())
        self.assertEqual(client.get('/sessions').json(), {'spa': True})
        self.assertEqual(len([r for r in app.routes if getattr(r, 'path', '') == module.PREFIX + '/reload']), 1)


class LifecycleMiddlewareTests(unittest.TestCase):
    def setUp(self):
        self.order = []
        self.life = SimpleNamespace(error=None)
        async def run():
            await asyncio.Event().wait()
        self.life.run = run
        self.life.stop_for_disable = lambda record: self.order.append('stopped')
        self.life.mark_disabled = lambda: self.order.append('recorded')
        app = FastAPI()
        @app.middleware('http')
        async def native_auth_gate(request, call_next):
            if request.headers.get('x-test-session') == 'valid':
                request.state.session = 'verified-by-native-gate'
            return await call_next(request)
        @app.post('/api/dashboard/agent-plugins/hermes-paseo/disable')
        def disable():
            self.order.append('disabled')
            return {'ok': True}
        @app.delete('/api/dashboard/agent-plugins/hermes-paseo')
        def remove():
            self.order.append('removed')
            return {'ok': True}
        def auth(request):
            if getattr(request.state, 'session', None) != 'verified-by-native-gate':
                raise HTTPException(401)
        server = SimpleNamespace(app=app, _require_token=auth)
        module.install(server, enabled=lambda: True, public_origin=lambda: 'https://hermes.test',
                       control=module.Control(lambda: os.getpid(), Mock(), 0), lifecycle=self.life)
        self.client = TestClient(app)
        self.headers = {'x-test-session': 'valid', 'origin': 'https://hermes.test',
                        'sec-fetch-site': 'same-origin'}

    def test_gui_disable_and_remove_stop_before_source_is_removed(self):
        with self.client:
            self.assertEqual(self.client.post('/api/dashboard/agent-plugins/hermes-paseo/disable', headers=self.headers).status_code, 200)
            self.assertEqual(self.order, ['stopped', 'disabled', 'recorded'])
            self.order.clear()
            self.assertEqual(self.client.delete('/api/dashboard/agent-plugins/hermes-paseo', headers=self.headers).status_code, 200)
            self.assertEqual(self.order, ['stopped', 'removed', 'recorded'])

    def test_denied_requests_cannot_stop_or_remove(self):
        with self.client:
            r = self.client.delete('/api/dashboard/agent-plugins/hermes-paseo')
            self.assertEqual(r.status_code, 401)
            r = self.client.delete('/api/dashboard/agent-plugins/hermes-paseo',
                                   headers={**self.headers, 'origin': 'https://evil.test'})
            self.assertEqual(r.status_code, 403)
            self.assertEqual(self.order, [])


if __name__ == '__main__':
    unittest.main()
