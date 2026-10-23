from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import os
os.chdir('/tmp/jellybean-appearance/site')
class Handler(SimpleHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length'])).decode()
        with open('/tmp/jellybean-appearance/receipts.jsonl','a') as f:
            f.write(body+'\n')
        print('RECEIPT '+body,flush=True)
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin','*')
        self.end_headers()
ThreadingHTTPServer(('127.0.0.1',4199),Handler).serve_forever()
