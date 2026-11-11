// Standby helper for the webhook fast path (being-teams fastpath): a pre-connected script opens its trigger FIFO read-write
// before signing in, so a trigger written while it is still connecting waits in the pipe, and the writer never blocks.
import { openSync, readSync, closeSync, writeFileSync } from 'node:fs';

// Open the FIFO, then write <fifo>.ready = our pid: the writer uses a standby only once that is there, because a line written
// to a FIFO nobody holds open is dropped.
export function openTrigger(fifo) {
  const fd = openSync(fifo, 'r+');
  writeFileSync(`${fifo}.ready`, String(process.pid));
  return fd;
}

// Block until one full line arrives on the trigger fd; returns it without the newline.
export function readLine(fd) {
  const chunks = [], buf = Buffer.alloc(65536);
  for (;;) {
    const n = readSync(fd, buf, 0, buf.length, null);
    if (n <= 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
    if (buf.subarray(0, n).includes(10)) break;
  }
  closeSync(fd);
  const s = Buffer.concat(chunks).toString('utf8');
  return s.slice(0, s.indexOf('\n') >= 0 ? s.indexOf('\n') : s.length);
}
