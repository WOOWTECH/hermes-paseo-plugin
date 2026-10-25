#!/usr/bin/env python3
"""One explicitly requested profile-scoped acceptance job; survives Web reloads."""
import importlib.util
from pathlib import Path
import sys

def main():
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location('_hermes_paseo_acceptance_bridge', root / 'hermes_paseo.py')
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    bridge.Bridge(root=root, home=sys.argv[1]).run_acceptance_job(sys.argv[2])


if __name__ == '__main__':
    main()
