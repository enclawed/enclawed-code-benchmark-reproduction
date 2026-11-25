#!/usr/bin/env python3
# Run one command on a real pseudo-terminal, the way a person runs it at a
# shell (codenclawed's sensitive commands, e.g. `mcp pin`, verify the person
# only at a terminal). Everything it prints goes to LOG; nothing is typed
# except a PIN line when a PIN prompt appears (the build's libfido2 test
# double ignores it). Exits with the command's exit code, 124 on timeout.
#   pty-run.py LOG TIMEOUT_S -- argv...
import os, pty, re, select, signal, sys, time

log_path, timeout_s = sys.argv[1], float(sys.argv[2])
argv = sys.argv[sys.argv.index("--") + 1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
deadline = time.time() + timeout_s
pin_re = re.compile(rb"PIN[^\n]*:\s*$")
buf = b""
with open(log_path, "wb") as log:
    while True:
        if time.time() > deadline:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            sys.exit(124)
        r, _, _ = select.select([fd], [], [], 0.5)
        if not r:
            continue
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if not data:
            break
        log.write(data)
        log.flush()
        buf = (buf + data)[-4096:]
        if pin_re.search(buf):
            os.write(fd, b"0000\r")
            buf = b""
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8))
