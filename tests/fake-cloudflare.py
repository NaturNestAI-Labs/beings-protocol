#!/usr/bin/env python3
"""Minimal Cloudflare API stand-in for tests/tunnel.test.sh: fake-cloudflare.py <port file> <call log>."""
import json, re, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT_FILE, LOG = sys.argv[1], sys.argv[2]
CONNECTOR = "eyJhIjoiZmFrZSIsInQiOiJmYWtlIn0FAKECONNECTORTOKEN0123456789"
S = {"tunnels": {}, "apps": {}, "dns": {}, "config": {}, "tokens": {}, "n": 0, "secret_rotations": 0}


def nid(prefix):
    S["n"] += 1
    return f"{prefix}{S['n']:04d}"


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, result, code=200):
        body = json.dumps({"success": code < 400, "errors": [] if code < 400 else [{"message": "nope"}], "result": result}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_any(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n)) if n else None
        path = self.path.split("?")[0]
        q = self.path.partition("?")[2]
        with open(LOG, "a") as f:
            f.write(f"{self.command} {path}\n")
        if path == "/__state":   # test inspection only
            return self.reply({k: (list(v.keys()) if isinstance(v, dict) else v) for k, v in S.items()} | {"config": S["config"]})
        if self.headers.get("Authorization") != "Bearer test-api-token":
            return self.reply(None, 403)
        m, p = self.command, path
        if m == "GET" and p.endswith("/cfd_tunnel"):
            name = re.search(r"name=([^&]+)", q)
            return self.reply([t for t in S["tunnels"].values() if name and t["name"] == name.group(1)])
        if m == "POST" and p.endswith("/cfd_tunnel"):
            t = {"id": nid("tun"), "name": body["name"], "status": "inactive", "connections": []}
            S["tunnels"][t["id"]] = t
            return self.reply(t)
        mt = re.search(r"/cfd_tunnel/([^/]+)(/.*)?$", p)
        if mt:
            tid, rest = mt.group(1), mt.group(2) or ""
            if tid not in S["tunnels"]:
                return self.reply(None, 404)
            if rest == "/token":
                return self.reply(CONNECTOR)
            if rest == "/configurations":
                if m == "PUT":
                    S["config"][tid] = body["config"]
                return self.reply({"config": S["config"].get(tid, {"ingress": [{"service": "http_status:404"}]})})
            if rest == "/connections":
                return self.reply(None)
            if m == "PATCH":
                S["secret_rotations"] += 1
                return self.reply(S["tunnels"][tid])
            if m == "DELETE":
                S["tunnels"].pop(tid)
                return self.reply(None)
            return self.reply(S["tunnels"][tid])
        if m == "POST" and p.endswith("/access/apps"):
            app = dict(body, id=nid("app"), policies=[dict(x, id=nid("pol")) for x in body.get("policies", [])])
            S["apps"][app["id"]] = app
            return self.reply(app)
        ma = re.search(r"/access/apps/([^/]+)(/policies(/[^/]+)?)?$", p)
        if ma:
            aid = ma.group(1)
            if aid not in S["apps"]:
                return self.reply(None, 404)
            if ma.group(2):
                if m == "POST":
                    pol = dict(body, id=nid("pol"))
                    S["apps"][aid]["policies"].append(pol)
                    return self.reply(pol)
                return self.reply({"id": (ma.group(3) or "/")[1:]})
            if m == "DELETE":
                S["apps"].pop(aid)
                return self.reply(None)
            return self.reply(S["apps"][aid])
        if p.endswith("/access/service_tokens") and m == "POST":
            t = {"id": nid("st"), "client_id": "fakeclientid.access", "client_secret": "FAKESERVICESECRET" * 4,
                 "expires_at": "2099-01-01T00:00:00Z"}
            S["tokens"][t["id"]] = t
            return self.reply(t)
        if "/access/service_tokens/" in p and m == "DELETE":
            S["tokens"].pop(p.rsplit("/", 1)[1], None)
            return self.reply(None)
        if p.endswith("/dns_records"):
            if m == "GET":
                name = re.search(r"name=([^&]+)", q)
                return self.reply([d for d in S["dns"].values() if name and d["name"] == name.group(1)])
            d = dict(body, id=nid("dns"))
            S["dns"][d["id"]] = d
            return self.reply(d)
        if "/dns_records/" in p and m == "DELETE":
            S["dns"].pop(p.rsplit("/", 1)[1], None)
            return self.reply(None)
        return self.reply(None, 404)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = handle_any


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
open(PORT_FILE, "w").write(str(srv.server_address[1]))
srv.serve_forever()
