from http.server import HTTPServer, SimpleHTTPRequestHandler
import webbrowser
import threading

PORT = 8000

def open_browser():
    webbrowser.open(
        f"http://localhost:{PORT}/#admin=brc-admin-2026"
    )

server = HTTPServer(
    ("", PORT),
    SimpleHTTPRequestHandler
)

print(f"サーバー起動中")
print(f"http://localhost:{PORT}")

threading.Timer(1, open_browser).start()

server.serve_forever()