#!/usr/bin/env python3
"""Report fresh connector liveness without reading credentials, chat messages or owner ids."""
import argparse
import json
import os
from pathlib import Path
from connection_settings import PRIVATE_ROOT
import time


def main():
    """Require a live process and a recent heartbeat before reporting an online connection."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=PRIVATE_ROOT)
    parser.add_argument('--require-online', action='store_true')
    args = parser.parse_args()
    try:
        health = json.loads((args.root / 'health.json').read_text())
        os.kill(health['pid'], 0)
        age = int(time.time() * 1000) - health['heartbeatAtMs']
        online = 0 <= age <= 35000 and health.get('connected') is True and health.get('ownerPaired') is True
        result = {'online': online, 'pid': health['pid'], 'heartbeatAgeMs': age,
                  'connected': health.get('connected'), 'serviceMode': health.get('serviceMode')}
    except (OSError, ValueError, KeyError, TypeError):
        online = False
        result = {'online': False, 'reason': 'health_missing_stale_or_process_stopped'}
    print(json.dumps(result))
    return 1 if args.require_online and not online else 0


if __name__ == '__main__':
    raise SystemExit(main())
