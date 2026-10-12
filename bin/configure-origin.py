#!/usr/bin/env python3
"""Operator-only public Origin configuration; no credentials or network calls."""
import argparse
import importlib.util
from pathlib import Path

parser = argparse.ArgumentParser(description='Configure the exact public Hermes Dashboard origin for this profile.')
parser.add_argument('origin', help='http(s) origin, without credentials, path, query, or fragment')
args = parser.parse_args()
path = Path(__file__).resolve().parent.parent / 'hermes_paseo.py'
spec = importlib.util.spec_from_file_location('_hermes_paseo_origin_cli', path)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
try:
    bridge.get_bridge().set_dashboard_origin(args.origin)
except bridge.BridgeError as error:
    parser.exit(1, 'Origin configuration failed: ' + error.code + '\n')
print('Dashboard Origin configured for the active Hermes profile.')
