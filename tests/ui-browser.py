#!/usr/bin/env python3
"""Real React/Chromium tests with local plugin and host API fixtures only.

Usage: python3 tests/ui-browser.py --react-node-modules /path/to/node_modules
       [--chromium-executable /path/to/chrome] [--screenshot /tmp/mobile.png]
Install the locked tests/ui-browser-deps packages and ui-browser-requirements.txt
under /tmp, then install Playwright's Chromium under /tmp. CI shows the exact
commands. No package installation or UI build is performed by this script.
These tests verify browser behavior, not a live host, pairing or paid acceptance.
"""
import argparse
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
HARNESS = r'''
(function () {
  const React = window.hostReact;
  const h = React.createElement;
  let Page, Guide;
  window.__HERMES_PLUGIN_SDK__ = {
    React, hooks: React,
    authedFetch: (path, init) => fetch(path, init)
  };
  window.__HERMES_PLUGINS__ = {
    register(name, component) { if (name !== 'hermes-paseo') throw Error('Wrong name'); Page = component; },
    registerSlot(name, slot, component) { if (name !== 'hermes-paseo' || slot !== 'header-right') throw Error('Wrong slot'); Guide = component; }
  };
  window.mountShell = function () {
    function Shell() {
      const [path, setPath] = React.useState(location.pathname);
      const [enabled, setEnabled] = React.useState(!location.search.includes('disabled=1'));
      window.enablePlugin = () => setEnabled(true);
      window.disablePlugin = () => setEnabled(false);
      React.useEffect(() => {
        const update = () => setPath(location.pathname);
        window.addEventListener('popstate', update);
        return () => window.removeEventListener('popstate', update);
      }, []);
      return h(React.Fragment, null,
        h('header', { style: { display: 'flex', justifyContent: 'space-between', padding: '12px' } },
          h('span', null, 'Hermes Dashboard'), enabled && h(Guide)),
        enabled && path === '/paseo' ? h(Page) : h('p', null, 'Host plugin settings'));
    }
    window.hostReactDOM.createRoot(document.getElementById('root')).render(h(Shell));
  };
})();
'''


def react_browser_runtime(node_modules):
    modules = {
        'react': 'react/cjs/react.production.js',
        'scheduler': 'scheduler/cjs/scheduler.production.js',
        'react-dom': 'react-dom/cjs/react-dom.production.js',
        'react-dom/client': 'react-dom/cjs/react-dom-client.production.js',
    }
    parts = ['(function(){const factories={},cache={};']
    for name, relative in modules.items():
        parts.append(f'factories[{json.dumps(name)}]=function(module,exports,require){{\n')
        parts.append((node_modules / relative).read_text())
        parts.append('\n};')
    parts.append('''function require(name){if(cache[name])return cache[name].exports;
      const module={exports:{}};cache[name]=module;factories[name](module,module.exports,require);return module.exports;}
      window.hostReact=require('react');window.hostReactDOM=require('react-dom/client');})();''')
    return '\n'.join(parts).encode()


class Fixture:
    def __init__(self):
        self.calls = []
        self.phase = 'not_installed'
        self.enabled = False
        self.onboarding_id = None
        self.completed = False
        self.ready_at = None
        self.missing_api = False
        self.invalid_status = False
        self.host_supported = False
        self.generation = 'fixture-generation-before'
        self.reload_status = 202
        self.disconnect_reload = False
        self.documents = 0

    def status(self):
        if self.ready_at and time.monotonic() >= self.ready_at:
            self.phase, self.enabled, self.ready_at = 'running', True, None
        running = self.phase == 'running'
        return dict(enabled=self.enabled, phase=self.phase,
                    daemon=dict(running=running, reachable=running),
                    providers=[dict(provider='hermes', label='本機 Hermes ACP', status='ready'),
                               dict(provider='claude', label='未安裝 Claude', status='unavailable'),
                               dict(provider='codex', label='未安裝 Codex', status='unavailable')],
                    onboarding=dict(required=not self.completed, id=self.onboarding_id, completed=self.completed))

    def count(self, endpoint, method=None):
        return sum(call['path'].endswith(endpoint) and
                   (method is None or call['method'] == method) for call in self.calls)

    @classmethod
    def reloadable(cls, *, missing_api=False, paused=False):
        fixture = cls()
        fixture.host_supported = True
        fixture.phase, fixture.enabled = ('disabled', False) if paused else ('running', True)
        fixture.completed = True
        fixture.missing_api = missing_api
        return fixture


def wait_for_calls(page, fixture, endpoint, count):
    """Wait for an observed HTTP event, without assuming a response latency."""
    deadline = time.monotonic() + 5
    while fixture.count(endpoint) < count:
        assert time.monotonic() < deadline, f'No fixture request for {endpoint}'
        page.wait_for_timeout(20)


def assert_posts(fixture, origin):
    for call in fixture.calls:
        if call['method'] != 'POST':
            continue
        expected = {'confirm': True} if call['path'] == '/api/hermes-paseo-host/reload' else {}
        assert json.loads(call['body']) == expected
        assert call['content_type'] == 'application/json'
        assert call['origin'] == origin and call['site'] == 'same-origin'


def run(args):
    runtime = react_browser_runtime(args.react_node_modules)
    fixture = Fixture()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def send(self, payload, mime='application/json', status=200):
            body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = urlsplit(self.path).path
            if path == '/api/hermes-paseo-host/capabilities':
                fixture.calls.append(dict(path=path, method='GET', generation=fixture.generation))
                if not fixture.host_supported:
                    return self.send({'detail': 'PRIVATE_BACKEND_BODY'}, status=404)
                return self.send(dict(supported=True, generation=fixture.generation))
            if path.startswith('/api/plugins/hermes-paseo/'):
                fixture.calls.append(dict(path=path, method='GET'))
                if fixture.missing_api:
                    return self.send({'detail': 'PRIVATE_BACKEND_BODY'}, status=404)
                if path.endswith('/status'):
                    return self.send({} if fixture.invalid_status else fixture.status())
                if path.endswith('/models/hermes'):
                    return self.send(dict(models=[dict(id='acp-discovered-model', label='Hermes 即時模型')],
                                          modes=[dict(id='discovered-mode', label='ACP 動態模式')]))
                return self.send({}, status=404)
            if path == '/react.js':
                return self.send(runtime, 'text/javascript')
            if path == '/harness.js':
                return self.send(HARNESS.encode(), 'text/javascript')
            if path == '/plugin.js':
                return self.send((ROOT / 'dashboard/dist/index.js').read_bytes(), 'text/javascript')
            if path == '/style.css':
                return self.send((ROOT / 'dashboard/dist/style.css').read_bytes(), 'text/css')
            if path not in ['/paseo', '/plugins']:
                return self.send({}, status=404)
            fixture.documents += 1
            return self.send(b'''<!doctype html><html lang="zh-Hant"><meta charset="utf-8">
              <meta name="viewport" content="width=device-width,initial-scale=1">
              <link rel="icon" href="data:,">
              <link rel="stylesheet" href="/style.css"><style>body{margin:0;font-family:system-ui}</style>
              <div id="root"></div><script src="/react.js"></script><script src="/harness.js"></script>
              <script src="/plugin.js"></script><script>mountShell()</script></html>''', 'text/html')

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            fixture.calls.append(dict(path=self.path, method='POST', body=body.decode(),
                                      content_type=self.headers.get('Content-Type'),
                                      origin=self.headers.get('Origin'), site=self.headers.get('Sec-Fetch-Site')))
            if self.path == '/api/hermes-paseo-host/reload':
                if (not fixture.host_supported or json.loads(body) != {'confirm': True} or
                        self.headers.get('Content-Type') != 'application/json'):
                    return self.send({}, status=400)
                if fixture.disconnect_reload:
                    fixture.generation = 'fixture-generation-after'
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                return self.send(dict(ok=fixture.reload_status == 202, generation=fixture.generation),
                                 status=fixture.reload_status)
            if body != b'{}' or self.headers.get('Content-Type') != 'application/json':
                return self.send({}, status=400)
            if self.path.endswith('/start'):
                fixture.onboarding_id = 'ONBOARDING-test-id'
                fixture.phase, fixture.enabled = 'installing', True
                fixture.ready_at = time.monotonic() + .15
                return self.send(fixture.status(), status=202)
            if self.path.endswith('/stop'):
                fixture.phase, fixture.enabled, fixture.ready_at = 'disabled', False, None
                return self.send(fixture.status())
            if self.path.endswith('/pair'):
                return self.send({'url': 'https://app.paseo.sh/pair#offer=TEST-PRIVATE-OFFER'})
            if self.path.endswith('/acceptance'):
                fixture.completed = True
                return self.send(dict(passed=True, checkedAt='2026-10-12', providers=[dict(
                    provider='hermes', firstReply=True, followup=True, passed=True,
                    cleanup=dict(archived=True, deleted=True))]))
            return self.send({}, status=404)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f'http://127.0.0.1:{server.server_port}'
    errors = []
    blocked_requests = []
    try:
        with sync_playwright() as p:
            options = dict(headless=True, args=['--no-sandbox'])
            if args.chromium_executable:
                options['executable_path'] = str(args.chromium_executable)
            browser = p.chromium.launch(**options)
            context = browser.new_context(viewport=dict(width=1280, height=900))
            # Permit local fixture requests only. The official-link click is fulfilled
            # locally to verify opener/referrer without contacting Paseo.
            def route(request):
                if request.request.url.startswith(origin + '/'):
                    request.continue_()
                elif request.request.url.startswith('https://app.paseo.sh/'):
                    request.fulfill(status=200, content_type='text/html', body='<p>Mock official binding</p>')
                else:
                    blocked_requests.append('Unexpected external request blocked')
                    request.abort()
            context.route('**/*', route)
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(origin + '/plugins?disabled=1')
            expect(page.get_by_text('Host plugin settings')).to_be_visible()
            assert not fixture.calls, 'installed disabled host must never mount/execute surfaces'
            page.evaluate('enablePlugin()')
            expect(page).to_have_url(origin + '/paseo')
            expect(page.get_by_role('heading', name='2. 配對精靈')).to_be_visible()
            expect(page.get_by_role('button', name='產生配對連結')).to_be_enabled(timeout=10000)
            assert fixture.count('/start') == 1
            assert fixture.count('/acceptance') == 0
            expect(page.get_by_role('button', name='重載 Dashboard', exact=True)).to_be_disabled()
            expect(page.get_by_text('一次性主機設定', exact=False)).to_be_visible()
            expect(page.get_by_role('combobox', name='代理', exact=True)).to_have_value('hermes')
            assert page.get_by_role('combobox', name='代理', exact=True).locator('option').all_text_contents() == ['本機 Hermes ACP']
            expect(page.get_by_role('combobox', name='模型', exact=True)).to_have_value('acp-discovered-model', timeout=10000)
            expect(page.get_by_role('combobox', name='模式', exact=True)).to_have_value('discovered-mode')
            page.get_by_role('button', name='產生配對連結').click()
            link = page.get_by_role('link', name='開啟 Paseo 官方網站並綁定')
            expect(link).to_be_visible()
            assert len(context.pages) == 1, 'generating an offer must not open a popup'
            assert link.get_attribute('rel') == 'noopener noreferrer'
            assert link.get_attribute('referrerPolicy') == 'no-referrer'
            assert 'TEST-PRIVATE-OFFER' not in page.inner_text('body')
            assert 'TEST-PRIVATE-OFFER' not in page.evaluate('JSON.stringify({...sessionStorage,...localStorage})')
            with context.expect_page() as opened:
                link.click()
            popup = opened.value
            popup.wait_for_load_state()
            assert popup.evaluate('window.opener === null && document.referrer === ""')
            popup.close()
            page.set_viewport_size(dict(width=390, height=844))
            if args.screenshot:
                page.screenshot(path=str(args.screenshot), full_page=True)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), page.evaluate('Array.from(document.querySelectorAll("*")).filter(el => el.getBoundingClientRect().right > innerWidth).map(el => [el.tagName, el.className, el.getBoundingClientRect().right])')
            assert page.get_by_role('combobox', name='代理', exact=True).bounding_box()['width'] > 250
            page.get_by_role('button', name='執行真實對話驗收（會消耗帳號額度）').click()
            expect(page.get_by_text('後端回報：真實對話驗收通過')).to_be_visible()
            assert fixture.count('/acceptance') == 1
            page.get_by_role('button', name='停止服務', exact=True).click()
            expect(page.get_by_text('已手動停止', exact=True).last).to_be_visible()
            page.reload()
            expect(page.get_by_role('button', name='恢復服務')).to_be_enabled()
            assert fixture.count('/start') == 1, 'reload after manual stop must never auto-start'
            page.get_by_role('button', name='恢復服務').click()
            expect(page.get_by_role('button', name='產生配對連結')).to_be_enabled(timeout=10000)
            assert fixture.count('/start') == 2
            page.evaluate('disablePlugin()')
            expect(page.get_by_text('Host plugin settings')).to_be_visible()
            before = len(fixture.calls)
            page.wait_for_timeout(5200)
            assert len(fixture.calls) == before, 'unmount must stop all polling'
            assert_posts(fixture, origin)
            context.close()
            fixture = Fixture()
            fixture.missing_api = True
            context = browser.new_context(viewport=dict(width=390, height=844))
            context.route('**/*', route)
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(origin + '/paseo')
            expect(page.get_by_role('alert')).to_contain_text('外掛 API 尚未載入')
            expect(page.get_by_role('alert')).to_contain_text('重載 Dashboard')
            expect(page.get_by_role('button', name='重載 Dashboard', exact=True)).to_be_disabled()
            expect(page.get_by_text('一次性主機設定', exact=False)).to_be_visible()
            expect(page.get_by_role('button', name='產生配對連結')).to_be_disabled()
            assert fixture.count('/start') == 0
            assert 'PRIVATE_BACKEND_BODY' not in page.inner_text('body')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            context.close()

            def open_reload_scenario(current):
                nonlocal fixture
                fixture = current
                ctx = browser.new_context(viewport=dict(width=390, height=844), service_workers='block')
                ctx.route('**/*', route)
                tab = ctx.new_page()
                tab.on('pageerror', lambda error: errors.append(str(error)))
                # Pause before loading any application code. Only the real
                # browser's timers advance; production code is never patched.
                tab.clock.install(time=1_700_000_000_000)
                tab.clock.pause_at(1_700_000_001_000)
                tab.goto(origin + '/paseo')
                expect(tab.get_by_role('button', name='重載 Dashboard', exact=True)).to_be_enabled()
                return ctx, tab

            def confirm_reload(tab):
                tab.get_by_role('button', name='重載 Dashboard', exact=True).click()
                expect(tab.get_by_role('dialog', name='確認重載 Dashboard')).to_be_visible()
                assert fixture.count('/reload', 'POST') == 0, 'opening confirmation must never POST'
                tab.get_by_role('button', name='確認重載', exact=True).click()

            def advance_poll(tab, *, reads_status=False):
                def capabilities():
                    with tab.expect_response(origin + '/api/hermes-paseo-host/capabilities') as response:
                        tab.clock.run_for(2001)
                    response.value.json()
                if reads_status:
                    with tab.expect_response(origin + '/api/plugins/hermes-paseo/status') as response:
                        capabilities()
                    # The application deliberately ignores error bodies. With
                    # intercepted fetches Chromium may discard that body before
                    # Playwright can read it, so inspect only successful JSON.
                    if response.value.ok:
                        response.value.json()
                else:
                    capabilities()

            # Real DOM confirmation/cancel and both independent recovery gates.
            context, page = open_reload_scenario(Fixture.reloadable(missing_api=True))
            expect(page.get_by_role('alert')).to_contain_text('外掛 API 尚未載入')
            page.get_by_role('button', name='重載 Dashboard', exact=True).click()
            expect(page.get_by_role('dialog', name='確認重載 Dashboard')).to_be_visible()
            assert fixture.count('/reload', 'POST') == 0
            page.get_by_role('button', name='取消', exact=True).click()
            expect(page.get_by_role('dialog')).to_have_count(0)
            assert fixture.count('/reload', 'POST') == 0
            confirm_reload(page)
            expect(page.get_by_role('button', name='正在重載…', exact=True)).to_be_disabled()
            wait_for_calls(page, fixture, '/capabilities', 2)
            assert fixture.count('/reload', 'POST') == 1
            assert fixture.documents == 1, 'POST acceptance alone must not refresh'
            status_reads = fixture.count('/status')
            fixture.missing_api = False
            advance_poll(page)
            assert fixture.documents == 1, 'ready API with unchanged generation must not refresh'
            assert fixture.count('/status') == status_reads, 'old generation cannot establish recovery'
            fixture.missing_api = True
            fixture.generation = 'fixture-generation-after'
            advance_poll(page, reads_status=True)
            wait_for_calls(page, fixture, '/status', status_reads + 1)
            assert fixture.documents == 1, 'new generation while API is 404 must not refresh'
            fixture.missing_api, fixture.invalid_status = False, True
            advance_poll(page, reads_status=True)
            wait_for_calls(page, fixture, '/status', status_reads + 2)
            assert fixture.documents == 1, 'HTTP 200 with invalid plugin status must not refresh'
            fixture.invalid_status = False
            with page.expect_navigation(wait_until='load'):
                page.clock.run_for(2001)
            expect(page).to_have_url(origin + '/paseo')
            expect(page.get_by_role('button', name='產生配對連結', exact=True)).to_be_enabled()
            assert fixture.documents == 2
            assert fixture.count('/reload', 'POST') == 1
            assert all(fixture.count(path, 'POST') == 0 for path in ['/start', '/pair', '/acceptance'])
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            assert_posts(fixture, origin)
            context.close()
            print('PASS: confirmation/cancel; reload requires a new generation and valid recovered API status.')

            # A dropped response may mean the restart was accepted. Observe the
            # new host once without repeating a destructive POST or losing pause.
            current = Fixture.reloadable(paused=True)
            current.disconnect_reload = True
            context, page = open_reload_scenario(current)
            expect(page.get_by_text('已手動停止', exact=True).last).to_be_visible()
            with page.expect_navigation(wait_until='load'):
                confirm_reload(page)
            expect(page.get_by_role('button', name='恢復服務', exact=True)).to_be_enabled()
            saved = page.evaluate('JSON.parse(sessionStorage.getItem("hermes-paseo:ui:v1"))')
            assert saved['paused'] is True
            assert fixture.documents == 2 and fixture.count('/reload', 'POST') == 1
            assert fixture.count('/start', 'POST') == 0
            assert_posts(fixture, origin)
            context.close()
            print('PASS: disconnected reload POST is not retried; manual pause survives actual refresh.')

            for code, message in [(401, '登入已過期'), (403, '操作被拒絕'), (409, '上一項操作')]:
                current = Fixture.reloadable()
                current.reload_status = code
                context, page = open_reload_scenario(current)
                confirm_reload(page)
                expect(page.get_by_role('alert')).to_contain_text(message)
                page.clock.run_for(4001)
                assert fixture.documents == 1 and fixture.count('/reload', 'POST') == 1
                assert_posts(fixture, origin)
                context.close()
            print('PASS: reload auth/permission/busy failures remain actionable without refresh or POST retries.')

            context, page = open_reload_scenario(Fixture.reloadable())
            confirm_reload(page)
            wait_for_calls(page, fixture, '/capabilities', 2)
            page.clock.fast_forward(60001)
            expect(page.get_by_role('alert')).to_contain_text('尚未確認重載完成')
            assert fixture.documents == 1 and fixture.count('/reload', 'POST') == 1
            assert_posts(fixture, origin)
            context.close()
            print('PASS: unchanged generation times out without refresh or automatic POST retries.')

            context, page = open_reload_scenario(Fixture.reloadable(missing_api=True))
            confirm_reload(page)
            wait_for_calls(page, fixture, '/capabilities', 2)
            page.evaluate('disablePlugin()')
            expect(page.get_by_text('Host plugin settings')).to_be_visible()
            before = len(fixture.calls)
            page.clock.fast_forward(62001)
            assert len(fixture.calls) == before, 'unmount must stop recovery polling and timeout work'
            assert fixture.documents == 1 and fixture.count('/reload', 'POST') == 1
            context.close()
            print('PASS: unmount during reload cancels observation and never refreshes the host.')

            for phase in ['installing', 'starting', 'stopping']:
                current = Fixture.reloadable()
                current.phase = phase
                fixture = current
                context = browser.new_context()
                context.route('**/*', route)
                page = context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(origin + '/paseo')
                wait_for_calls(page, fixture, '/capabilities', 1)
                expect(page.get_by_role('button', name='重載 Dashboard', exact=True)).to_be_disabled()
                assert fixture.count('/reload', 'POST') == 0
                context.close()
            print('PASS: active installer/start/stop phases disable Dashboard reload.')
            browser.close()
        assert not errors, f'Browser React errors: {errors}'
        assert not blocked_requests, blocked_requests
        print('PASS: real React DOM, host activation, first start, secure explicit link, dynamic ACP selectors, '
              'paid-action gating, manual pause/resume, unmount cleanup, mobile layout, old-host 404 guidance. '
              'API and official binding are local mocks; no real acceptance or deployment performed.')
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--react-node-modules', type=Path, required=True)
    parser.add_argument('--chromium-executable', type=Path)
    parser.add_argument('--screenshot', type=Path)
    run(parser.parse_args())
