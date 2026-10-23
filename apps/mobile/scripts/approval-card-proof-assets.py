"""Serve the asking agent's saved avatar for the disposable Android proof."""
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
avatar = Path(__file__).resolve().parents[1] / 'evidence/approval-card-anatomy/asking-agent.webp'
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        data = avatar.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', 'image/webp')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
HTTPServer(('127.0.0.1', 18740), Handler).serve_forever()
