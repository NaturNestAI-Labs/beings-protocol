#!/usr/bin/env node
// model-relay <unix socket> <port> -- <command...>: inside a no-network sandbox, 127.0.0.1:<port> → model-proxy's socket.
// Starts the command once listening and exits with its code (isolation/README.md).
import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';

const [sock, port, sep, ...cmd] = process.argv.slice(2);
if (!sock || !/^[0-9]+$/.test(port || '') || sep !== '--' || !cmd.length) {
  console.error('usage: model-relay.mjs <unix socket> <port> -- <command...>'); process.exit(2);
}
const srv = net.createServer((c) => {
  const u = net.createConnection(sock);
  const end = () => { c.destroy(); u.destroy(); };
  c.on('error', end); u.on('error', end); c.on('close', end); u.on('close', end);
  c.pipe(u); u.pipe(c);
});
srv.on('error', (e) => { console.error(`model-relay: ${e.code || e.message}`); process.exit(5); });
srv.listen(Number(port), '127.0.0.1', () => {
  const ch = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  ch.on('error', (e) => { console.error(`model-relay: ${cmd[0]}: ${e.code || e.message}`); process.exit(127); });
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => ch.kill(s));
  ch.on('exit', (code, sig) => process.exit(code ?? 128 + (os.constants.signals[sig] || 1)));
});
