#!/usr/bin/env python3
"""Local DOM smoke test with real React and mocked plugin API (no paid/remote calls).

Usage: python3 tests/ui-browser.py --react-node-modules /path/to/node_modules
       [--chromium-executable /path/to/chrome] [--screenshot /tmp/mobile.png]
Requires an existing React/ReactDOM/scheduler installation and Python Playwright.
No package installation or UI build is performed.
"""
import argparse
import json
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

    def count(self, endpoint):
        return sum(call['path'].endswith(endpoint) for call in self.calls)


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
            if path.startswith('/api/plugins/hermes-paseo/'):
                fixture.calls.append(dict(path=path, method='GET'))
                if fixture.missing_api:
                    return self.send({'detail': 'PRIVATE_BACKEND_BODY'}, status=404)
                if path.endswith('/status'):
                    return self.send(fixture.status())
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
            return self.send(b'''<!doctype html><html lang="zh-Hant"><meta charset="utf-8">
              <meta name="viewport" content="width=device-width,initial-scale=1">
              <link rel="stylesheet" href="/style.css"><style>body{margin:0;font-family:system-ui}</style>
              <div id="root"></div><script src="/react.js"></script><script src="/harness.js"></script>
              <script src="/plugin.js"></script><script>mountShell()</script></html>''', 'text/html')

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            fixture.calls.append(dict(path=self.path, method='POST', body=body.decode(),
                                      content_type=self.headers.get('Content-Type'),
                                      origin=self.headers.get('Origin'), site=self.headers.get('Sec-Fetch-Site')))
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
            posts = [call for call in fixture.calls if call['method'] == 'POST']
            assert all(call['body'] == '{}' and call['content_type'] == 'application/json' and
                       call['origin'] == origin and call['site'] == 'same-origin' for call in posts)
            context.close()
            fixture = Fixture()
            fixture.missing_api = True
            context = browser.new_context(viewport=dict(width=390, height=844))
            context.route('**/*', route)
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(origin + '/paseo')
            expect(page.get_by_role('alert')).to_contain_text('重新啟動 hermes dashboard')
            expect(page.get_by_role('alert')).to_contain_text('不需要升級映像')
            expect(page.get_by_role('button', name='產生配對連結')).to_be_disabled()
            assert fixture.count('/start') == 0
            assert 'PRIVATE_BACKEND_BODY' not in page.inner_text('body')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            context.close()
            browser.close()
        assert not errors, f'Browser React errors: {errors}'
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
