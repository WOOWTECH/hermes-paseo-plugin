"""Public Hermes native registration; no installation, network or child processes."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sys
from pathlib import Path


def _load_bridge():
    path = Path(__file__).resolve().with_name('hermes_paseo.py')
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
    return sys.modules[name]


bridge = _load_bridge()
SETUP_GUIDANCE = ('Paseo setup is available in the Hermes dashboard at /paseo. '
                  'Open that page to start the profile runtime and pair securely. '
                  'The /paseo command shows setup guidance. Pairing links stay on that page. '
                  'Before disabling or removing this plugin, run /paseo stop and wait until '
                  '/paseo status reports daemon.running=false. Hermes 0.19 cannot automatically '
                  'stop the detached daemon when the plugin is disabled or removed.')


def _handler(action):
    def handle(args=None, **kwargs):
        try:
            # ACP children can inspect status but may not recursively launch agents/daemons.
            if action in ('start', 'chat', 'continue') and _is_acp(kwargs):
                raise bridge.BridgeError('INVALID_REQUEST')
            result = bridge.get_bridge().call(action, args)
            return json.dumps(result, ensure_ascii=False, allow_nan=False)
        except Exception as error:
            code = error.code if isinstance(error, bridge.BridgeError) else 'OPERATION_FAILED'
            return json.dumps({'ok': False, 'code': code})
    return handle


def _is_acp(info):
    return (str(info.get('platform', '')).lower() == 'acp'
            or bool(os.environ.get('PASEO_AGENT_ID'))
            or os.environ.get('HERMES_PASEO_ACP_CHILD') == '1'
            or os.environ.get('HERMES_ACP') == '1')


def _session_start(ctx, session_id=None, platform=None, **kwargs):
    # Observer hook: never starts Node or injects a turn. In 0.19 inject_message
    # queues/interrupts a turn, so returning guidance and /paseo are the safe fallback.
    if _is_acp({'platform': platform, **kwargs}):
        return None
    try:
        runtime = bridge.get_bridge()
        current = runtime.onboarding()
        if current['completed']:
            return None
        safe_id = session_id if isinstance(session_id, str) and bridge.re.fullmatch(r'[A-Za-z0-9_-]{1,128}', session_id) else None
        runtime.onboarding(create=True, session_id=safe_id)
        return SETUP_GUIDANCE
    except Exception:
        return None


def _setup_command(raw_args=''):
    action = raw_args.strip().lower() if isinstance(raw_args, str) else ''
    if action in ('status', 'stop'):
        return _handler(action)({})
    return SETUP_GUIDANCE


def _prompt_guidance(info):
    return '' if _is_acp(info) else SETUP_GUIDANCE


def register(ctx):
    schemas = {
        'status': ({}, []), 'start': ({}, []), 'stop': ({}, []),
        'models': ({'provider': {'type': 'string', 'enum': sorted(bridge.PROVIDERS)}}, ['provider']),
        'chat': ({'provider': {'type': 'string', 'enum': sorted(bridge.PROVIDERS)},
                  'model': {'type': 'string', 'maxLength': 256},
                  'mode': {'type': 'string', 'maxLength': 256},
                  'thinking': {'type': 'string', 'maxLength': 256},
                  'message': {'type': 'string', 'minLength': 1, 'maxLength': 12000}}, ['provider', 'message']),
        'continue': ({'agentId': {'type': 'string', 'pattern': '^[A-Za-z0-9_-]{8,100}$'},
                      'message': {'type': 'string', 'minLength': 1, 'maxLength': 12000}}, ['agentId', 'message']),
    }
    descriptions = {'status': 'Inspect this profile’s Paseo runtime and onboarding.',
                    'start': 'Start this profile’s Paseo runtime in the background.',
                    'stop': 'Pause this profile’s Paseo runtime; preserve its state.',
                    'models': 'List a provider’s available models.',
                    'chat': 'Create a Paseo conversation using an available provider.',
                    'continue': 'Continue a Paseo conversation owned by this profile.'}
    for action, (properties, required) in schemas.items():
        name = 'paseo_' + action
        ctx.register_tool(name=name, toolset='hermes_paseo', description=descriptions[action],
                          schema={'name': name, 'description': descriptions[action],
                                  'parameters': {'type': 'object', 'properties': properties,
                                                 'required': required, 'additionalProperties': False}},
                          handler=_handler(action))
    ctx.register_hook('on_session_start', lambda **kwargs: _session_start(ctx, **kwargs))
    command = getattr(ctx, 'register_command', None)
    if callable(command):
        command('paseo', _setup_command, description='Paseo setup; stop before disabling or removing this plugin.',
                args_hint='[status|stop]')
    prompt = getattr(ctx, 'register_system_prompt_section', None)
    if callable(prompt):
        prompt('hermes-paseo.setup', _prompt_guidance, max_chars=768)
