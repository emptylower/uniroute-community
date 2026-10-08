"""POSIX fixture: paste immediately after the real CLI prompt, then inspect termios."""
import json
import os
import pty
import select
import signal
import subprocess
import sys
import termios
import time

node, cli, base_url, mode = sys.argv[1:]
master, slave = pty.openpty()
original = termios.tcgetattr(slave)
env = {key: value for key, value in os.environ.items() if key not in ('UNIROUTE_API_KEY',)}
process = subprocess.Popen([node, cli, 'models', '--base-url', base_url],
                           stdin=slave, stdout=slave, stderr=slave, env=env)
output = b''
sent = False
ready_no_echo = False
try:
    deadline = time.time() + 15
    while time.time() < deadline:
        readable, _, _ = select.select([master], [], [], 0.05)
        if readable:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            output += chunk
            if not sent and b'API key (hidden):' in output:
                flags = termios.tcgetattr(slave)[3]
                ready_no_echo = not (flags & termios.ECHO) and not (flags & termios.ICANON)
                if mode == 'paste':
                    os.write(master, b'test-private-key-never-print\n')
                elif mode == 'cancel':
                    os.write(master, b'\x03')
                elif mode == 'signal':
                    process.send_signal(signal.SIGTERM)
                sent = True
        elif process.poll() is not None:
            break
    try:
        code = process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        code = process.wait()
    restored = termios.tcgetattr(slave) == original
    text = output.decode(errors='replace')
    print(json.dumps({'mode': mode, 'exit_code': code, 'prompt_seen': sent,
                      'no_echo_at_prompt': ready_no_echo,
                      'key_not_echoed': 'test-private-key-never-print' not in text,
                      'terminal_restored': restored, 'catalog_returned': 'claude-sonnet-test' in text,
                      'cancelled': 'Setup cancelled.' in text}))
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    os.close(master)
    os.close(slave)
