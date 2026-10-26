"""Profile-scoped Hermes/Paseo bridge. Import and registration are inert.

Hermes 0.19 exposes no native PluginContext conversation-creation method (nor a
REST session-create route). ONBOARDING is a durable plugin checkpoint, not a
fabricated Hermes conversation. A real native session observed by the hook can
be attached. Newly installed backend routes require restarting the 0.19 web
server; its dashboard rescan only refreshes the catalog.

Hermes 0.19 has no public plugin-unload/shutdown callback. Disable/remove can
close the API gate while its detached Paseo daemon remains alive. Run /paseo stop
before disabling/removing and verify /paseo status has daemon.running=false.
Newer Hermes exposes ctx.on_unload, but automatic cleanup is not implemented
here and is not promised on any host. Session-end hooks are not plugin unload.
"""
from __future__ import annotations

import contextvars
import copy
import fcntl
import json
import os
import re
import selectors
import datetime
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
MAX_INPUT = 16 * 1024
MAX_OUTPUT = 256 * 1024  # combined stdout/stderr, before decoding
PROVIDERS = frozenset({'hermes', 'claude', 'codex', 'pi'})
TIMEOUTS = {'status': 20, 'start': 480, 'stop': 60, 'models': 165,
            'pair': 40, 'acceptance': 480, 'chat': 240, 'continue': 240}
FIELDS = {'status': (), 'start': (), 'stop': (), 'models': ('provider',),
          'pair': (), 'acceptance': ('providers',),
          'chat': ('provider', 'model', 'mode', 'thinking', 'message'),
          'continue': ('agentId', 'message')}
CODES = frozenset('''INVALID_REQUEST INVALID_PROVIDER INVALID_MESSAGE INVALID_AGENT_ID
INVALID_MODEL INVALID_PAIR_URL INVALID_COMMAND_OUTPUT REQUEST_TOO_LARGE OUTPUT_LIMIT
PROCESS_TIMEOUT PROCESS_FAILED NODE_UNAVAILABLE HERMES_UNAVAILABLE RUNTIME_UNAVAILABLE
RUNTIME_FAILED OPERATION_FAILED STATE_UNAVAILABLE STATE_CORRUPT STATE_BUSY
DAEMON_UNREACHABLE DAEMON_NOT_OWNED DAEMON_REQUEST_TIMEOUT DAEMON_FAILED RUNTIME_BUSY
PAIRING_UNAVAILABLE PAIRING_ORIGIN_INVALID PROVIDER_AUTH_REQUIRED PROVIDER_UNAVAILABLE
PROVIDER_MODELS_UNAVAILABLE NO_AVAILABLE_MODEL RESTART_REQUIRED NODE_VERSION_UNSUPPORTED
NPM_UNAVAILABLE VERSION_MISMATCH WEB_UI_MISSING RUNTIME_NOT_OWNED INVALID_PORT
UNSAFE_SYMLINK UNSAFE_LOCK LOCK_GUARD_UNAVAILABLE LOCK_GUARD_FAILED LOCK_GUARD_TIMEOUT
INVALID_MODE CHAT_TIMEOUT NO_ASSISTANT_REPLY ACCEPTANCE_FAILED RELAY_UNVERIFIED
PROVIDER_LOGIN_REQUIRED PROVIDER_ERROR START_FAILED STOP_FAILED ACCEPTANCE_CLEANUP_FAILED INVALID_DASHBOARD_ORIGIN
WORKSPACE_CREATE_FAILED PERMISSION_REQUIRED PROVIDER_TIMEOUT PROVIDER_TURN_FAILED
EMPTY_OR_UNEXPECTED_REPLY'''.split())
CODES = CODES | {'ACCEPTANCE_INTERRUPTED', 'PROVIDER_QUOTA_EXHAUSTED'}
PUBLIC_KEYS = frozenset('''ok code installed version enabled phase diagnosticCode daemon running
reachable relayEnabled relayVerified relayVerifiedAt providers provider label status modes id
isDefault defaultModeId models defaultThinkingOptionId thinkingOptions chatVerified chatVerifiedAt
checkedAt passed firstReply followup model modeId thinking agentId message reply errorCode
available authentication loginHint chatErrorCode cleanup archived workspaceArchived'''.split())
PAIR_TEXT = re.compile(r'https?://(?:[^\s/]*@)?app\.paseo\.sh[^\s<>\"\']*', re.I)
SECRET_TEXT = re.compile(r'(?i)(?:bearer\s+[a-z0-9._~+/-]+|(?:sk|ghp|github_pat|xoxb|xoxp)[-_][a-z0-9_-]{8,}|(?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*[^\s,;]+)')


class BridgeError(Exception):
    def __init__(self, code):
        self.code = code if code in CODES else 'OPERATION_FAILED'
        super().__init__(self.code)


def get_hermes_home():
    # Public, context-local profile resolution. Never import config/auth loaders.
    try:
        from hermes_constants import get_hermes_home as resolve_home
    except ImportError:
        return Path(os.environ.get('HERMES_HOME') or Path.home() / '.hermes').expanduser().absolute()
    return Path(resolve_home()).expanduser().absolute()


def validate_input(action, value=None):
    value = {} if value is None else value
    if action not in FIELDS or not isinstance(value, dict) or any(k not in FIELDS[action] for k in value):
        raise BridgeError('INVALID_REQUEST')
    if action in ('models', 'chat') and (not isinstance(value.get('provider'), str) or value['provider'] not in PROVIDERS):
        raise BridgeError('INVALID_PROVIDER')
    if 'providers' in value:
        providers = value['providers']
        if not isinstance(providers, list) or not 1 <= len(providers) <= 4 or any(not isinstance(p, str) or p not in PROVIDERS for p in providers) or len(set(providers)) != len(providers):
            raise BridgeError('INVALID_PROVIDER')
    for key in ('model', 'mode', 'thinking'):
        if key in value and (not isinstance(value[key], str) or not value[key] or len(value[key]) > 256 or re.search(r'[\x00-\x1f\x7f]', value[key])):
            raise BridgeError('INVALID_REQUEST')
    if action in ('chat', 'continue'):
        message = value.get('message')
        if not isinstance(message, str) or not message.strip() or len(message) > 12000 or '\x00' in message:
            raise BridgeError('INVALID_MESSAGE')
    if action == 'continue' and (not isinstance(value.get('agentId'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', value['agentId'])):
        raise BridgeError('INVALID_AGENT_ID')
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')
    except (ValueError, TypeError, UnicodeError):
        raise BridgeError('INVALID_REQUEST') from None
    if len(encoded) > MAX_INPUT:
        raise BridgeError('REQUEST_TOO_LARGE')
    return copy.deepcopy(value)


def redact(value, depth=0):
    """Project public output, including chat text; never expose arbitrary diagnostics."""
    if depth > 12:
        return None
    if isinstance(value, dict):
        return {k: (v if isinstance(v, str) and v in CODES else 'OPERATION_FAILED') if k in ('code', 'diagnosticCode', 'errorCode', 'chatErrorCode') and v is not None else redact(v, depth + 1)
                for k, v in value.items() if k in PUBLIC_KEYS}
    if isinstance(value, list):
        return [redact(v, depth + 1) for v in value[:1024]]
    if isinstance(value, str):
        return SECRET_TEXT.sub('[redacted]', PAIR_TEXT.sub('[pairing hidden]', value))
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return None


def public_pair(value):
    url = value.get('url')
    if not isinstance(url, str) or len(url) > 8192 or re.search(r'[\s\x00-\x1f\x7f\\]', url):
        raise BridgeError('INVALID_PAIR_URL')
    try:
        parsed = urlsplit(url)
        valid = parsed.scheme == 'https' and parsed.hostname == 'app.paseo.sh' and parsed.netloc in ('app.paseo.sh', 'app.paseo.sh:443') and parsed.username is None and parsed.password is None and parsed.port in (None, 443)
    except ValueError:
        valid = False
    if not valid:
        raise BridgeError('INVALID_PAIR_URL')
    return {'url': url}


def _safe_path(path):
    for part in (path, *path.parents):
        if part.is_symlink():
            raise BridgeError('STATE_UNAVAILABLE')


def _private_dir(path):
    _safe_path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not path.is_dir():
        raise BridgeError('STATE_UNAVAILABLE')
    path.chmod(0o700)


def _read_json(path, private=False):
    _safe_path(path)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > MAX_INPUT:
            raise BridgeError('STATE_CORRUPT')
        if private and (info.st_uid != os.geteuid() or info.st_mode & 0o077):
            raise BridgeError('STATE_UNAVAILABLE')
        data = os.read(fd, MAX_INPUT + 1)
        value = json.loads(data)
        if not isinstance(value, dict):
            raise BridgeError('STATE_CORRUPT')
        return value
    except (ValueError, UnicodeError):
        raise BridgeError('STATE_CORRUPT') from None
    finally:
        os.close(fd)


def _write_json(path, value):
    _safe_path(path)
    tmp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


@contextmanager
def _state_lock(home):
    _private_dir(home)
    file = home / 'onboarding.lock'
    _safe_path(file)
    fd = os.open(file, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise BridgeError('STATE_UNAVAILABLE')
        os.fchmod(fd, 0o600)
        deadline = time.monotonic() + 3
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise BridgeError('STATE_BUSY')
                time.sleep(0.01)
        yield
    finally:
        os.close(fd)


def resolve_executable(command, env):
    if not isinstance(command, str) or not command or '\x00' in command:
        return None
    candidate = shutil.which(command, path=env.get('PATH'))
    return str(Path(candidate).resolve()) if candidate else None


def run_process(argv, payload, env, timeout, output_limit=MAX_OUTPUT):
    """Non-shell child, bounded combined pipes, hard deadline including inherited pipes.

    Killing the process group also terminates descendants on timeout/overflow.
    Successful detached daemon processes have their own sessions and survive.
    """
    try:
        process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, env=env, cwd=str(ROOT),
                                   shell=False, start_new_session=True, close_fds=True)
    except (OSError, ValueError):
        raise BridgeError('PROCESS_FAILED') from None
    selector = selectors.DefaultSelector()
    stdout = bytearray()
    total = 0
    deadline = time.monotonic() + timeout
    failed = True
    try:
        for pipe in (process.stdout, process.stderr, process.stdin):
            os.set_blocking(pipe.fileno(), False)
        selector.register(process.stdout, selectors.EVENT_READ, 'out')
        selector.register(process.stderr, selectors.EVENT_READ, 'err')
        selector.register(process.stdin, selectors.EVENT_WRITE, 'in')
        remaining = memoryview(payload)
        while selector.get_map():
            left = deadline - time.monotonic()
            if left <= 0:
                raise BridgeError('PROCESS_TIMEOUT')
            for key, _ in selector.select(min(left, 0.1)):
                if key.data == 'in':
                    try:
                        written = os.write(key.fd, remaining)
                        remaining = remaining[written:]
                    except BlockingIOError:
                        continue
                    except BrokenPipeError:
                        remaining = memoryview(b'')
                    if not remaining:
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                    continue
                try:
                    chunk = os.read(key.fd, 8192)
                except BlockingIOError:
                    continue
                if not chunk:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                total += len(chunk)
                if total > output_limit:
                    raise BridgeError('OUTPUT_LIMIT')
                if key.data == 'out':
                    stdout.extend(chunk)
                # stderr is deliberately discarded, never decoded or logged.
        try:
            code = process.wait(timeout=max(0.001, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            raise BridgeError('PROCESS_TIMEOUT') from None
        try:
            result = json.loads(stdout, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (ValueError, UnicodeError, RecursionError):
            raise BridgeError('INVALID_COMMAND_OUTPUT') from None
        if not isinstance(result, dict):
            raise BridgeError('INVALID_COMMAND_OUTPUT')
        if code or result.get('ok') is False:
            raise BridgeError(result.get('code', 'PROCESS_FAILED'))
        failed = False
        return result
    finally:
        if failed:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        selector.close()
        for pipe in (process.stdin, process.stdout, process.stderr):
            if not pipe.closed:
                pipe.close()
        if process.poll() is None:
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass


def validate_dashboard_origin(value):
    # Keep this syntax in sync with the independently installed host adapter.
    # urlsplit alone accepts empty credentials, delimiters and invalid hosts.
    if not isinstance(value, str) or not value or len(value) > 2048 or re.search(r'[\s\x00-\x1f\x7f\\?#]', value):
        raise BridgeError('INVALID_DASHBOARD_ORIGIN')
    try:
        parsed = urlsplit(value)
        label = r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
        authority = rf'(?:{label}(?:\.{label})*\.?|\[[0-9A-Fa-f:.]+\])(?::[0-9]+)?'
        if (parsed.scheme not in ('http', 'https') or not parsed.hostname
                or not re.fullmatch(authority, parsed.netloc)
                or parsed.username is not None or parsed.password is not None
                or parsed.path or parsed.query or parsed.fragment
                or (parsed.port is not None and not 1 <= parsed.port <= 65535)):
            raise ValueError()
    except ValueError:
        raise BridgeError('INVALID_DASHBOARD_ORIGIN') from None
    return value


class Bridge:
    def __init__(self, root=ROOT, home=None):
        self.root = Path(root).absolute()
        self.home = Path(home).absolute() if home is not None else get_hermes_home()
        self.state_dir = self.home / 'plugin-data' / 'hermes-paseo'
        self._condition = threading.Condition(threading.RLock())
        self._cache = None
        self._cached_at = 0
        self._generation = 0
        self._checking = False
        self._worker = None
        self._stop_worker = None
        self._pause_requested = False
        self._phase = None
        self._error = None
        self._operation_lock = threading.Lock()

    def dashboard_origin(self):
        record = _read_json(self.state_dir / 'dashboard-origin.json', private=True)
        if record is None:
            return None
        if set(record) != {'origin'}:
            raise BridgeError('STATE_CORRUPT')
        try:
            return validate_dashboard_origin(record['origin'])
        except BridgeError:
            raise BridgeError('STATE_CORRUPT') from None

    def set_dashboard_origin(self, value):
        value = validate_dashboard_origin(value)
        with _state_lock(self.state_dir):
            _write_json(self.state_dir / 'dashboard-origin.json', {'origin': value})

    def dashboard_origins(self, fallback):
        """At most two operator origins; never persist Ingress over the primary."""
        primary = self.dashboard_origin() or validate_dashboard_origin(fallback)
        ingress = os.environ.get('HERMES_PASEO_INGRESS_ORIGIN')
        if ingress is None:
            return (primary,)
        # An explicitly empty or malformed setting is a configuration failure,
        # including on requests without Origin. Never silently drop the setting.
        return (primary, validate_dashboard_origin(ingress))


    def environment(self):
        env = os.environ.copy()  # preserve active credentials without opening their files
        env['HERMES_HOME'] = str(self.home)
        env['HERMES_PASEO_STATE_DIR'] = str(self.state_dir)
        # Runtime must also be isolated even if the parent carries another profile's override.
        env.pop('HERMES_PASEO_RUNTIME_DIR', None)
        command = resolve_executable(env.get('HERMES_PASEO_HERMES_COMMAND', 'hermes'), env)
        if command:
            env['HERMES_PASEO_HERMES_COMMAND'] = command
        else:
            env.pop('HERMES_PASEO_HERMES_COMMAND', None)
        return env

    def onboarding(self, create=False, session_id=None, completed=False):
        path = self.state_dir / 'onboarding.json'
        try:
            if create or completed or session_id:
                with _state_lock(self.state_dir):
                    record = _read_json(path)
                    if record is None:
                        record = {'id': 'ONBOARDING-' + str(uuid.uuid4()), 'sessionId': None,
                                  'completed': False, 'guidanceSent': False,
                                  'limitation': 'NATIVE_SESSION_CREATION_UNAVAILABLE'}
                    if session_id and not record.get('sessionId'):
                        record['sessionId'] = session_id
                    if completed:
                        record['completed'] = True
                    _write_json(path, record)
            else:
                record = _read_json(path)
            if record is None:
                return {'required': True, 'id': None, 'sessionId': None, 'completed': False,
                        'limitation': 'NATIVE_SESSION_CREATION_UNAVAILABLE'}
            if not isinstance(record.get('id'), str) or not re.fullmatch(r'ONBOARDING-[a-f0-9-]{36}', record['id']) or not isinstance(record.get('completed'), bool):
                raise BridgeError('STATE_CORRUPT')
            sid = record.get('sessionId')
            if sid is not None and (not isinstance(sid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', sid)):
                raise BridgeError('STATE_CORRUPT')
            return {'required': not record['completed'], 'id': record['id'],
                    'sessionId': sid, 'completed': record['completed'],
                    'limitation': 'NATIVE_SESSION_CREATION_UNAVAILABLE'}
        except OSError:
            raise BridgeError('STATE_UNAVAILABLE') from None

    def invalidate(self):
        with self._condition:
            self._generation += 1
            self._cache = None
            self._condition.notify_all()

    def _acceptance_record(self):
        path = self.state_dir / 'acceptance-job.json'
        record = _read_json(path)
        if record is None:
            return None
        if path.stat().st_uid != os.geteuid():
            raise BridgeError('STATE_UNAVAILABLE')
        if (record.get('version') != 1 or not re.fullmatch(r'[a-f0-9]{32}', str(record.get('id', '')))
                or record.get('phase') not in ('running', 'completed', 'error', 'interrupted')):
            raise BridgeError('STATE_CORRUPT')
        return record

    @staticmethod
    def _job_process_identity(pid):
        try:
            if type(pid) is not int or pid <= 0:
                return None
            path = Path('/proc') / str(pid)
            if path.stat().st_uid != os.geteuid():
                return None
            fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
            boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
            container = Path('/proc/1/stat').read_text().rsplit(')', 1)[1].split()[19]
            return ':'.join((boot, container, fields[19])) if fields[0] != 'Z' else None
        except (OSError, IndexError):
            return None

    @staticmethod
    def _public_job(record):
        if record is None:
            return {'jobId': None, 'phase': 'idle', 'pending': False, 'result': None, 'code': None}
        return {'jobId': record['id'], 'phase': record['phase'], 'pending': record['phase'] == 'running',
                'result': redact(record.get('result')), 'code': record.get('code') if record.get('code') in CODES else None}

    def acceptance_status(self):
        path = self.state_dir / 'acceptance-job.json'
        if not path.exists() and not path.is_symlink():
            return self._public_job(None)
        with _state_lock(self.state_dir):
            record = self._acceptance_record()
            if record and record['phase'] == 'running' and (
                    not record.get('identity') or self._job_process_identity(record.get('pid')) != record['identity']):
                record.update(phase='interrupted', code='ACCEPTANCE_INTERRUPTED', result=None)
                _write_json(path, record)
            return self._public_job(record)

    def start_acceptance(self, value=None):
        value = validate_input('acceptance', value)
        if not (self.root / 'bin/acceptance-worker.py').is_file():
            raise BridgeError('RUNTIME_UNAVAILABLE')
        self.onboarding(create=True)
        with _state_lock(self.state_dir):
            record = self._acceptance_record()
            if (record and record['phase'] == 'running' and record.get('identity')
                    and self._job_process_identity(record.get('pid')) == record['identity']):
                return self._public_job(record)
            record = {'version': 1, 'id': uuid.uuid4().hex, 'phase': 'running', 'pid': None, 'identity': None,
                      'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      'providers': value.get('providers', ['hermes']), 'result': None, 'code': None}
            path = self.state_dir / 'acceptance-job.json'
            _write_json(path, record)
            try:
                process = subprocess.Popen(
                    [sys.executable, '-P', str(self.root / 'bin/acceptance-worker.py'), str(self.home), record['id']],
                    env=self.environment(), cwd=self.root, stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True)
                record.update(pid=process.pid, identity=self._job_process_identity(process.pid))
                if not record['identity']:
                    raise BridgeError('PROCESS_FAILED')
                _write_json(path, record)
                threading.Thread(target=process.wait, name='hermes-paseo-acceptance-reaper', daemon=True).start()
            except (OSError, BridgeError):
                record.update(phase='error', code='PROCESS_FAILED')
                _write_json(path, record)
        self.invalidate()
        return self._public_job(record)

    def run_acceptance_job(self, job_id):
        path = self.state_dir / 'acceptance-job.json'
        with _state_lock(self.state_dir):
            record = self._acceptance_record()
            if (not record or record['id'] != job_id or record['phase'] != 'running'
                    or record.get('pid') != os.getpid()
                    or record.get('identity') != self._job_process_identity(os.getpid())):
                raise BridgeError('INVALID_REQUEST')
            providers = record['providers']
        try:
            result = self.call('acceptance', {'providers': providers})
            if type(result.get('passed')) is not bool or not isinstance(result.get('providers'), list):
                raise BridgeError('INVALID_COMMAND_OUTPUT')
            phase, code = 'completed', None
        except Exception as error:
            result, phase = None, 'error'
            code = error.code if isinstance(error, BridgeError) else 'OPERATION_FAILED'
        with _state_lock(self.state_dir):
            record = self._acceptance_record()
            if record and record['id'] == job_id:
                record.update(phase=phase, code=code, result=result)
                _write_json(path, record)

    def _invoke(self, action, value=None):
        value = validate_input(action, value)
        env = self.environment()
        node = resolve_executable('node', env)
        if not node:
            raise BridgeError('NODE_UNAVAILABLE')
        if not (self.root / 'bin' / 'control.mjs').is_file():
            raise BridgeError('RUNTIME_UNAVAILABLE')
        if action == 'start' and not env.get('HERMES_PASEO_HERMES_COMMAND'):
            raise BridgeError('HERMES_UNAVAILABLE')
        result = run_process([node, str(self.root / 'bin' / 'control.mjs'), action],
                             json.dumps(value, ensure_ascii=False).encode('utf-8'), env,
                             TIMEOUTS[action])
        return public_pair(result) if action == 'pair' else redact(result)

    def _decorate(self, result):
        result = copy.deepcopy(result)
        result.setdefault('installed', False)
        result.setdefault('version', None)
        result.setdefault('diagnosticCode', None)
        result.setdefault('chatVerified', False)
        result.setdefault('chatVerifiedAt', None)
        result.setdefault('enabled', False)
        result.setdefault('phase', 'not_installed')
        result.setdefault('daemon', {})
        for key, default in {'running': False, 'reachable': False, 'relayEnabled': False,
                             'relayVerified': False, 'relayVerifiedAt': None}.items():
            result['daemon'].setdefault(key, default)
        result['providers'] = [row for row in result.get('providers', [])
                               if isinstance(row, dict) and row.get('provider') in PROVIDERS]
        result['onboarding'] = self.onboarding()
        result['acceptanceJob'] = self.acceptance_status()
        with self._condition:
            if self._phase:
                result['phase'] = self._phase
                if self._phase == 'installing':
                    result['enabled'] = True
            if self._pause_requested or (_read_json(self.state_dir / 'onboarding.json') or {}).get('paused'):
                result['enabled'] = False
            if self._error:
                result['diagnosticCode'] = self._error
        return result

    def status(self, fresh=False):
        with self._condition:
            deadline = time.monotonic() + TIMEOUTS['status'] + 2
            while self._checking:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise BridgeError('PROCESS_TIMEOUT')
                self._condition.wait(left)
            if not fresh and self._cache is not None and time.monotonic() - self._cached_at < 3:
                return self._decorate(self._cache)
            self._checking = True
            generation = self._generation
        try:
            try:
                result = self._invoke('status')
            except BridgeError as error:
                # Onboarding remains visible even when Node is absent or broken.
                # Failed reads are never cached.
                return self._decorate({'enabled': False, 'phase': 'error',
                                       'diagnosticCode': error.code,
                                       'daemon': {'running': False, 'reachable': False},
                                       'providers': []})
            with self._condition:
                if generation == self._generation and not result.get('diagnosticCode'):
                    self._cache = copy.deepcopy(result)
                    self._cached_at = time.monotonic()
            return self._decorate(result)
        finally:
            with self._condition:
                self._checking = False
                self._condition.notify_all()

    def _initialize(self):
        try:
            with self._operation_lock:
                with self._condition:
                    if self._pause_requested:
                        return
                snapshot = self._invoke('status')
                with self._condition:
                    if self._pause_requested:
                        return
                result = snapshot if snapshot.get('enabled') and snapshot.get('daemon', {}).get('reachable') and snapshot.get('phase') == 'running' else self._invoke('start')
                with self._condition:
                    self._phase = 'stopping' if self._pause_requested else None
                    self._error = result.get('diagnosticCode')
                    if not self._pause_requested:
                        self._cache = copy.deepcopy(result)
                        self._cached_at = time.monotonic()
        except Exception as error:
            with self._condition:
                self._phase = 'error'
                self._error = error.code if isinstance(error, BridgeError) else 'START_FAILED'
        finally:
            self.invalidate()

    def start(self):
        # This synchronous write happens before any executable lookup or process creation.
        self.onboarding(create=True)
        with self._condition:
            if self._stop_worker is not None and self._stop_worker.is_alive():
                return self._decorate({'enabled': False, 'phase': 'stopping'})
            if self._cache and self._cache.get('enabled') and self._cache.get('phase') == 'running' and time.monotonic() - self._cached_at < 3:
                return self._decorate(self._cache)
            if self._worker is None or not self._worker.is_alive():
                self._pause_requested = False
                with _state_lock(self.state_dir):
                    record = _read_json(self.state_dir / 'onboarding.json')
                    record['paused'] = False
                    _write_json(self.state_dir / 'onboarding.json', record)
                self._phase, self._error = 'installing', None
                self.invalidate()
                context = contextvars.copy_context()
                self._worker = threading.Thread(target=lambda: context.run(self._initialize),
                                                name='hermes-paseo-start', daemon=True)
                self._worker.start()
            cached = self._cache or {'enabled': True, 'phase': 'installing', 'daemon': {'running': False, 'reachable': False}, 'providers': []}
        return self._decorate(cached)

    def _background_stop(self):
        try:
            self._finish_stop()
        except Exception:
            pass  # the safe error code is already visible in status

    def _finish_stop(self):
        try:
            with self._operation_lock:
                result = self._invoke('stop')
                with self._condition:
                    self._phase = self._error = None
                return result
        except Exception as error:
            with self._condition:
                self._phase = 'error'
                self._error = error.code if isinstance(error, BridgeError) else 'STOP_FAILED'
            raise
        finally:
            self.invalidate()

    def call(self, action, value=None, allow_pair=False):
        value = validate_input(action, value)
        if action == 'pair' and not allow_pair:
            raise BridgeError('INVALID_REQUEST')
        if action == 'status':
            return self.status()
        if action == 'start':
            return self.start()
        if action != 'models':
            self.invalidate()
        try:
            if action == 'stop':
                with self._condition:
                    self._pause_requested = True
                    self._phase = 'stopping'
                    # Persist pause before waiting for npm/daemon startup. Explicit
                    # /start is the only operation that can resume it.
                    with _state_lock(self.state_dir):
                        record = _read_json(self.state_dir / 'onboarding.json')
                        if record is not None:
                            record['paused'] = True
                            _write_json(self.state_dir / 'onboarding.json', record)
                    if self._worker is not None and self._worker.is_alive():
                        if self._stop_worker is None or not self._stop_worker.is_alive():
                            context = contextvars.copy_context()
                            self._stop_worker = threading.Thread(target=lambda: context.run(self._background_stop),
                                                                 name='hermes-paseo-stop', daemon=True)
                            self._stop_worker.start()
                        return self._decorate({'enabled': False, 'phase': 'stopping'})
                result = self._finish_stop()
                return self._decorate(result)
            result = self._invoke(action, value)
            if action == 'acceptance' and result.get('passed') is True:
                self.onboarding(create=True, completed=True)
            return result
        finally:
            if action != 'models':
                self.invalidate()


_BRIDGES = {}
_BRIDGES_LOCK = threading.Lock()


def get_bridge():
    home = get_hermes_home()
    key = str(home)
    with _BRIDGES_LOCK:
        if key not in _BRIDGES:
            _BRIDGES[key] = Bridge(home=home)
        return _BRIDGES[key]
