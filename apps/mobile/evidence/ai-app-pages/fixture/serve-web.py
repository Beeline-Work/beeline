# Serves a web export on 127.0.0.1:18764 with single-page fallback.
# usage: python3 -I serve-web.py <web-after|web-before>
import http.server, os, sys
root = sys.argv[1]
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(s, *a, **k): super().__init__(*a, directory=root, **k)
    def send_head(s):
        p = s.translate_path(s.path.split('?')[0])
        if not os.path.exists(p): s.path = '/index.html'
        return super().send_head()
    def log_message(s, *a): pass
http.server.ThreadingHTTPServer(('127.0.0.1', 18764), H).serve_forever()
