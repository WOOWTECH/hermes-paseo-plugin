"""Host mounts this router at /api/plugins/hermes-paseo behind its auth gate.

0.19 imports backend files as standalone modules, not Python packages. Load the
bridge by its own absolute file identity without adding plugin code to sys.path.
The host's authenticated user remains the authority; this router adds origin,
fetch metadata and request-size checks, not a second authentication mechanism.
"""
from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

path = Path(__file__).resolve().parent.parent / 'hermes_paseo.py'
name = '_hermes_paseo_bridge_' + hashlib.sha256(str(path).encode()).hexdigest()[:16]
if name not in sys.modules:
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
bridge = sys.modules[name]
HEADERS = {'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
           'X-Content-Type-Options': 'nosniff'}


class RequestError(Exception):
    def __init__(self, code, status=400):
        self.code, self.status = code, status


def _origin(value):
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username
                or parsed.password or parsed.path or parsed.query or parsed.fragment):
            return None
        return parsed.scheme, parsed.hostname.lower(), parsed.port or (443 if parsed.scheme == 'https' else 80)
    except ValueError:
        return None


def check_origin(request):
    # Duplicate security headers are ambiguous; do not silently use the first.
    for header in ('origin', 'sec-fetch-site', 'content-type', 'content-length', 'host'):
        if len(request.headers.getlist(header)) > 1:
            raise RequestError('INVALID_REQUEST', 400)
    if request.headers.get('sec-fetch-site') not in (None, 'same-origin', 'none'):
        raise RequestError('ORIGIN_DENIED', 403)
    if request.headers.get('sec-fetch-mode') in ('navigate', 'no-cors'):
        raise RequestError('ORIGIN_DENIED', 403)
    origin = request.headers.get('origin')
    if origin:
        actual = _origin(origin)
        configured = bridge.get_bridge().dashboard_origin()
        expected = _origin(configured or str(request.base_url).rstrip('/'))
        if actual is None or actual != expected:
            raise RequestError('ORIGIN_DENIED', 403)
    elif request.method not in ('GET', 'HEAD', 'OPTIONS'):
        if request.headers.get('sec-fetch-site') != 'same-origin':
            raise RequestError('ORIGIN_REQUIRED', 403)
    # Never trust client-supplied Forwarded/X-Forwarded-Host here. Operators may
    # configure one exact public Origin in a private, profile-scoped local file
    # when an HTTP proxy loses the original scheme/host. Browser requests cannot
    # create or update this file. Fetch Metadata remains enforced above.


async def read_json(request):
    if request.headers.get('content-encoding', 'identity').lower() != 'identity':
        raise RequestError('UNSUPPORTED_ENCODING', 415)
    content_type = request.headers.get('content-type', '').split(';')[0].strip().lower()
    if content_type != 'application/json':
        raise RequestError('JSON_REQUIRED', 415)
    length = request.headers.get('content-length')
    if length is not None:
        if not length.isdecimal():
            raise RequestError('INVALID_REQUEST')
        if int(length) > bridge.MAX_INPUT:
            raise RequestError('REQUEST_TOO_LARGE', 413)
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > bridge.MAX_INPUT:
            raise RequestError('REQUEST_TOO_LARGE', 413)
        data.extend(chunk)
    try:
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError()
                result[key] = value
            return result
        value = json.loads(data, object_pairs_hook=unique,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeError, RecursionError):
        raise RequestError('INVALID_JSON') from None
    if not isinstance(value, dict):
        raise RequestError('INVALID_REQUEST')
    return value


class ProtectedRoute(APIRoute):
    def get_route_handler(self):
        endpoint = super().get_route_handler()
        async def handle(request):
            try:
                check_origin(request)
                # 0.22's SDK adds the launch-profile selector even for the
                # default profile. Support that one alias only; this router
                # never switches homes based on untrusted query parameters.
                if list(request.query_params.multi_items()) not in ([], [('profile', 'default')]):
                    raise RequestError('INVALID_REQUEST')
                if request.method == 'GET':
                    count = 0
                    async for chunk in request.stream():
                        count += len(chunk)
                        if count > bridge.MAX_INPUT:
                            raise RequestError('REQUEST_TOO_LARGE', 413)
                    if count:
                        raise RequestError('INVALID_REQUEST')
                response = await endpoint(request)
            except RequestError as error:
                response = JSONResponse({'ok': False, 'code': error.code}, status_code=error.status)
            except bridge.BridgeError as error:
                status = 413 if error.code == 'REQUEST_TOO_LARGE' else 400 if error.code.startswith('INVALID_') else 503
                response = JSONResponse({'ok': False, 'code': error.code}, status_code=status)
            except Exception:
                response = JSONResponse({'ok': False, 'code': 'OPERATION_FAILED'}, status_code=503)
            response.headers.update(HEADERS)
            return response
        return handle


router = APIRouter(route_class=ProtectedRoute)


@router.get('/status')
async def status():
    return await asyncio.to_thread(bridge.get_bridge().status)


@router.post('/start')
async def start(request: Request):
    body = await read_json(request)
    bridge.validate_input('start', body)
    result = await asyncio.to_thread(bridge.get_bridge().start)
    return JSONResponse(result, status_code=202 if result.get('phase') == 'installing' else 200)


@router.post('/stop')
async def stop(request: Request):
    body = await read_json(request)
    return await asyncio.to_thread(bridge.get_bridge().call, 'stop', body)


@router.post('/pair')
async def pair(request: Request):
    body = await read_json(request)
    return await asyncio.to_thread(bridge.get_bridge().call, 'pair', body, allow_pair=True)


@router.post('/acceptance')
async def acceptance(request: Request):
    body = await read_json(request)
    result = await asyncio.to_thread(bridge.get_bridge().start_acceptance, body)
    return JSONResponse(result, status_code=202 if result['pending'] else 200)


@router.get('/acceptance')
async def acceptance_status():
    return await asyncio.to_thread(bridge.get_bridge().acceptance_status)


@router.get('/models/{provider}')
async def models(provider: str):
    return await asyncio.to_thread(bridge.get_bridge().call, 'models', {'provider': provider})


# Include 404/405 responses within the plugin namespace in the privacy policy.
# Registered exact routes win; this fallback catches wrong methods and paths.
@router.api_route('/{remainder:path}', methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
async def unavailable(remainder: str):
    return JSONResponse({'ok': False, 'code': 'ROUTE_UNAVAILABLE'}, status_code=404)
