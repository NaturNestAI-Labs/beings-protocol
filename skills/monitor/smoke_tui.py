"""Drive the monitor's terminal UI through a private pseudo-terminal against a throwaway fixture."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time


def fixture(root):
    jobs = root / 'state/jobs'
    jobs.mkdir(parents=True)
    (jobs / 'smoke.json').write_text(json.dumps({'id': 'smoke-job', 'name': 'smoke-monitor', 'kind': 'run', 'status': 'done',
                                                 'exit': 0, 'payload': ['echo ok']}))
    (jobs / 'smoke.log').write_text('ok\n')


def main():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        fixture(root)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 160, 0, 0))
        env = {'PATH': os.environ.get('PATH', ''), 'HOME': tmp, 'TERM': 'xterm-256color',
               'BEING_NAME': 'nova', 'BEING_WORKSPACE': tmp, 'BEING_STATE_DIR': str(root / 'state')}
        process = subprocess.Popen([sys.executable, str(Path(__file__).with_name('monitor.py'))],
                                   stdin=slave, stdout=slave, stderr=slave, env=env)
        os.close(slave)
        deadline = time.monotonic() + 30
        output = b''
        stage = 0
        next_at = 0
        try:
            while time.monotonic() < deadline and process.poll() is None:
                ready, _, _ = select.select([master], [], [], .2)
                if ready:
                    try:
                        output += os.read(master, 65536)
                    except OSError:
                        break
                if stage == 0 and b'nova monitor' in output:
                    os.write(master, b'a/smoke-monitor\n')
                    stage, next_at = 1, time.monotonic() + 1
                elif stage == 1 and time.monotonic() > next_at:
                    os.write(master, b'\n')
                    stage, next_at = 2, time.monotonic() + 1
                elif stage == 2 and b'LIVE FOLLOW' in output and time.monotonic() > next_at:
                    os.write(master, b'pq')
                    stage, next_at = 3, time.monotonic() + 1
                elif stage == 3 and time.monotonic() > next_at:
                    os.write(master, b'q')
                    stage = 4
            if process.poll() is None:
                raise RuntimeError('PTY smoke timed out')
            assert process.returncode == 0 and stage == 4, 'PTY navigation failed'
            print('PTY navigation: PASS (search, detail, prompt, back, quit)')
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait()
            os.close(master)


if __name__ == '__main__':
    main()
