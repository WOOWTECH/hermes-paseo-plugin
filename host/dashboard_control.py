"""Host-level Dashboard control, available before any plugin API is loaded.

Installed by the operator beside the native CLI; does not open a listener or
grant shell/Kubernetes access. Every request uses Hermes's existing auth gate.
"""
from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import threading
import uuid
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.background import BackgroundTask

PREFIX = '/api/hermes-paseo-host'
HEADERS = {'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
           'X-Content-Type-Options': 'nosniff'}


def origin(value):
    try:
        p = urlsplit(value)
        if (p.scheme not in ('http', 'https') or not p.hostname or p.username
                or p.password or p.path not in ('', '/') or p.query or p.fragment):
            return None
        return p.scheme, p.hostname.lower(), p.port or (443 if p.scheme == 'https' else 80)
    except (ValueError, TypeError):
        return None


def supervised_pid():
    try:
        result = subprocess.run(
            ['/command/s6-svstat', '-o', 'pid', '/run/service/dashboard'],
            capture_output=True, text=True, timeout=2, check=True,
        )
        return int(result.stdout.strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


class Control:
    def __init__(self, pid_reader=supervised_pid, signaler=os.kill, delay=0.8):
        self.generation = uuid.uuid4().hex
        self.pid_reader, self.signaler, self.delay = pid_reader, signaler, delay
        self.pending = False
        self.lock = threading.Lock()

    def supported(self):
        return self.pid_reader() == os.getpid()

    def reserve(self):
        with self.lock:
            if self.pending:
                raise HTTPException(409, detail='RELOAD_PENDING')
            if not self.supported():
                raise HTTPException(503, detail='SUPERVISOR_UNAVAILABLE')
            self.pending = True

    async def restart(self):
        await asyncio.sleep(self.delay)
        try:
            # Recheck immediately before signalling. Never accept a PID from a client.
            if not self.supported():
                raise RuntimeError('Supervisor changed')
            self.signaler(os.getpid(), signal.SIGTERM)
        except Exception:
            with self.lock:
                self.pending = False


def make_router(require_auth, public_origin, enabled, control=None):
    control = control or Control()
    router = APIRouter(prefix=PREFIX)

    def check(request):
        require_auth(request)
        for name in ('origin', 'sec-fetch-site', 'sec-fetch-mode', 'content-type',
                     'content-length', 'content-encoding', 'host'):
            if len(request.headers.getlist(name)) > 1:
                raise HTTPException(400, detail='INVALID_REQUEST')
        if request.query_params:
            raise HTTPException(400, detail='INVALID_REQUEST')
        if request.headers.get('sec-fetch-site') not in (None, 'same-origin', 'none'):
            raise HTTPException(403, detail='ORIGIN_DENIED')
        if request.headers.get('sec-fetch-mode') in ('navigate', 'no-cors'):
            raise HTTPException(403, detail='ORIGIN_DENIED')
        expected = origin(public_origin())
        actual = origin(request.headers.get('origin'))
        if request.headers.get('origin'):
            if not expected or actual != expected:
                raise HTTPException(403, detail='ORIGIN_DENIED')
        elif request.method == 'POST':
            if request.headers.get('sec-fetch-site') != 'same-origin' or not expected:
                raise HTTPException(403, detail='ORIGIN_REQUIRED')
        if not enabled():
            raise HTTPException(403, detail='PLUGIN_DISABLED')

    @router.get('/capabilities')
    def capabilities(request: Request):
        check(request)
        return JSONResponse({'supported': control.supported() and origin(public_origin()) is not None,
                             'generation': control.generation, 'pending': control.pending},
                            headers=HEADERS)

    @router.post('/reload')
    async def reload(request: Request):
        check(request)
        if request.headers.get('content-encoding', 'identity').lower() != 'identity':
            raise HTTPException(415, detail='UNSUPPORTED_ENCODING')
        if request.headers.get('content-type', '').split(';')[0].lower().strip() != 'application/json':
            raise HTTPException(415, detail='JSON_REQUIRED')
        length = request.headers.get('content-length')
        if length is not None and (not length.isdecimal() or int(length) > 128):
            raise HTTPException(413, detail='REQUEST_TOO_LARGE')
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > 128:
                raise HTTPException(413, detail='REQUEST_TOO_LARGE')
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError('Duplicate key')
                result[key] = value
            return result
        try:
            body = json.loads(data, object_pairs_hook=unique)
        except (ValueError, UnicodeError, RecursionError):
            raise HTTPException(400, detail='INVALID_REQUEST') from None
        if not isinstance(body, dict) or set(body) != {'confirm'} or body['confirm'] is not True:
            raise HTTPException(400, detail='CONFIRMATION_REQUIRED')
        control.reserve()
        return JSONResponse({'ok': True, 'generation': control.generation}, status_code=202,
                            headers=HEADERS, background=BackgroundTask(control.restart))

    return router


def install(server):
    if getattr(server.app.state, 'hermes_paseo_host_installed', False):
        return
    from hermes_cli.plugins_cmd import _get_enabled_set, _get_disabled_set
    server.app.include_router(make_router(
        server._require_token,
        lambda: os.environ.get('HERMES_DASHBOARD_PUBLIC_URL', ''),
        lambda: 'hermes-paseo' in _get_enabled_set() and 'hermes-paseo' not in _get_disabled_set(),
    ))
    server.app.state.hermes_paseo_host_installed = True
