#!/usr/bin/env python3
"""ChoreoTrainer lokal starten.

Liefert diesen Ordner unter http://localhost:8417 aus und reicht Fingerabdrücke
für die Songerkennung an Shazam durch (POST /api/shazam). Der Browser darf Shazam
wegen CORS nicht direkt fragen, deshalb dieser Umweg. Nur Python-Standardbibliothek.
"""
import http.server
import json
import os
import random
import sys
import time
import urllib.request
import uuid

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8417
ROOT = os.path.dirname(os.path.abspath(__file__))
SHAZAM = ("https://amp.shazam.com/discovery/v5/de/DE/android/-/tag/{}/{}"
          "?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&video=v3")
USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # Nach Code-Änderungen immer frische Dateien laden
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_POST(self):
        if self.path != "/api/shazam":
            self.send_error(404)
            return
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            now = int(time.time() * 1000)
            body = json.dumps({
                "geolocation": {"altitude": 300, "latitude": 51.0, "longitude": 10.0},  # grob Deutschland, kein echter Ort
                "signature": {"uri": req["uri"], "samplems": int(req["samplems"]), "timestamp": now},
                "timestamp": now,
                "timezone": "Europe/Berlin",
            }).encode()
            upstream = urllib.request.Request(
                SHAZAM.format(str(uuid.uuid4()).upper(), str(uuid.uuid4())),
                data=body, method="POST",
                headers={"Content-Type": "application/json", "User-Agent": random.choice(USER_AGENTS),
                         "Content-Language": "de_DE"})
            with urllib.request.urlopen(upstream, timeout=15) as res:
                self.reply(200, res.read())
        except Exception as e:  # Shazam nicht erreichbar oder Schnittstelle geändert
            self.reply(502, json.dumps({"error": str(e)}).encode())

    def reply(self, code, data):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_request(self, code="-", size="-"):
        # nur Fehler ins Terminal, kein Rauschen bei jedem Dateiabruf
        if str(code).isdigit() and int(code) >= 400:
            super().log_request(code, size)


if __name__ == "__main__":
    print(f"ChoreoTrainer läuft: http://localhost:{PORT}  (Beenden: ctrl+C)")
    try:
        http.server.ThreadingHTTPServer(("", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
