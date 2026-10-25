#!/usr/bin/env python3
"""Operator setup for one s6 Hermes StatefulSet; dry-run unless --apply.

This adds read-only native CLI/host-code mounts. It never reads Secrets,
changes authentication, adds a listener, or edits another workload.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--context', required=True)
    parser.add_argument('--kubectl', default='kubectl')
    parser.add_argument('--namespace', required=True)
    parser.add_argument('--workload', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--preserve-private-profile', action='store_true',
                        help='Verify the existing service-owned profile; retain fsGroup and repair private Origin at startup.')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    data = {name: (root / 'host' / name).read_text() for name in ('hermes', 'dashboard_control.py', 'profile_lifecycle.py', 'resource_limits.py')}
    digest = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()[:12]
    volume = 'hermes-paseo-dashboard-control'
    config_name = f'hermes-paseo-dashboard-control-{digest}'
    kube = [args.kubectl, '--context', args.context, '-n', args.namespace]
    result = subprocess.run(kube + ['get', 'statefulset', args.workload, '-o', 'json'],
                            check=True, capture_output=True, text=True)
    workload = json.loads(result.stdout)
    spec = workload['spec']['template']['spec']
    container = next((c for c in spec['containers'] if c['name'] == 'hermes-agent'), None)
    if not container:
        raise SystemExit('Expected hermes-agent container was not found.')
    for mount in container.get('volumeMounts', []):
        if mount['mountPath'] in ('/opt/hermes/.venv/bin/hermes', '/opt/hermes-paseo-dashboard-control') and mount['name'] != volume:
            raise SystemExit('A different mount already owns a control path; review it first.')
    for existing in spec.get('volumes', []):
        if existing['name'] == volume and not existing.get('configMap', {}).get('name', '').startswith('hermes-paseo-dashboard-control-'):
            raise SystemExit('The control volume name is already in use; review it first.')
    config = {'apiVersion': 'v1', 'kind': 'ConfigMap', 'immutable': True,
              'metadata': {'name': config_name, 'namespace': args.namespace,
                           'labels': {'app.kubernetes.io/part-of': 'hermes-paseo-dashboard-control'}},
              'data': data}
    patch = {'metadata': {'resourceVersion': workload['metadata']['resourceVersion']},
             'spec': {'template': {'spec': {
                 'volumes': [{'name': volume, 'configMap': {'name': config_name, 'defaultMode': 0o555}}],
                 'containers': [{'name': 'hermes-agent', 'volumeMounts': [
                     {'name': volume, 'mountPath': '/opt/hermes-paseo-dashboard-control', 'readOnly': True},
                     {'name': volume, 'mountPath': '/opt/hermes/.venv/bin/hermes', 'subPath': 'hermes', 'readOnly': True},
                 ]}],
             }}}}
    if args.preserve_private_profile:
        selector = ','.join(f'{k}={v}' for k, v in workload['spec']['selector']['matchLabels'].items())
        pods = json.loads(subprocess.run(kube + ['get', 'pods', '-l', selector, '-o', 'json'],
                                        check=True, capture_output=True, text=True).stdout)['items']
        pod = next((p for p in pods if p.get('status', {}).get('phase') == 'Running' and
                    any(o.get('uid') == workload['metadata']['uid'] for o in p['metadata'].get('ownerReferences', []))), None)
        if not pod:
            raise SystemExit('Verify a running owned Hermes pod before changing fsGroup.')
        uid = subprocess.run(kube + ['exec', pod['metadata']['name'], '-c', 'hermes-agent',
                                     '--', 'stat', '-c', '%u', '/opt/data'],
                             check=True, capture_output=True, text=True).stdout.strip()
        if uid != '10000':
            raise SystemExit('The existing profile is not owned by the expected service UID; keep fsGroup and review ownership.')
        # Keep fsGroup. Repair only the owned private Origin file after mount.
    if not args.apply:
        print(json.dumps({'dry_run': True, 'config_map': config_name,
                          'workload': args.workload, 'patch': patch}, indent=2))
        return
    subprocess.run(kube + ['apply', '-f', '-'], input=json.dumps(config), text=True,
                   check=True, capture_output=True)
    subprocess.run(kube + ['patch', 'statefulset', args.workload, '--type=strategic',
                           '--patch-file=/dev/stdin'], input=json.dumps(patch), text=True,
                   check=True, capture_output=True)
    print(json.dumps({'installed': True, 'config_map': config_name,
                      'workload': args.workload, 'rollout_pending': True}))


if __name__ == '__main__':
    main()
