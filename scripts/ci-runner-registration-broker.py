"""Relay short-lived registration tokens from this corner's gh to host root."""
import os
import socket
import struct
import subprocess

import json

path = '/run/beeline-ci-registration/relay.sock'
if os.path.lexists(path):
    raise SystemExit('Socket already exists; inspect its owner before reuse')
server = socket.socket(socket.AF_UNIX)
server.bind(path)
os.chmod(path, 0o600)
server.listen(1)
try:
    while True:
        client, _ = server.accept()
        with client:
            _, uid, _ = struct.unpack('3i', client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != 0:
                continue
            policy = subprocess.run(['gh', 'api',
                'repos/Beeline-Work/beeline/actions/permissions/fork-pr-contributor-approval'],
                capture_output=True, timeout=20)
            if policy.returncode or json.loads(policy.stdout).get('approval_policy') != 'all_external_contributors':
                print('Registration denied: external-contributor approval policy is not ready.', flush=True)
                continue
            result = subprocess.run(['gh', 'api', '--method', 'POST',
                'repos/Beeline-Work/beeline/actions/runners/registration-token', '--jq', '.token'],
                capture_output=True, timeout=20)
            if result.returncode == 0:
                client.sendall(result.stdout)
finally:
    server.close()
    os.unlink(path)
