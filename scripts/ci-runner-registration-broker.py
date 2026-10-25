"""Relay short-lived registration tokens from this corner's gh to host root."""
import os
from pathlib import Path
import socket
import struct
import subprocess

path = str(Path(__file__).resolve().parent.parent / '.ci-reg.sock')
if os.path.lexists(path):
    raise SystemExit('Socket already exists; inspect its owner before reuse')
server = socket.socket(socket.AF_UNIX)
server.bind(path)
os.chmod(path, 0o600)
server.listen(1)
server.settimeout(600)
try:
    for _ in range(4):
        client, _ = server.accept()
        with client:
            _, uid, _ = struct.unpack('3i', client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != 0:
                raise SystemExit('Only host root may request registration')
            result = subprocess.run(['gh', 'api', '--method', 'POST',
                'repos/Beeline-Work/beeline/actions/runners/registration-token', '--jq', '.token'],
                capture_output=True, check=True)
            client.sendall(result.stdout)
finally:
    server.close()
    os.unlink(path)
