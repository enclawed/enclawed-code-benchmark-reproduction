#!/usr/bin/env python3
# The stand-in person at codenclawed's person-only commands, on a real pseudo-terminal: everything the
# command prints goes to the person's terminal and to LOG. The stand-in types only what the benchmark's
# software "person" holds; the factors the Enclaweder verifies are the REAL person's.
#   --mode accept (default; c2-accept.mjs, `codenclawed audit accept`):
#     stand-in: the device's serial (from the command's own report "... the Enclaweder <serial> anchored:"),
#               ACCEPT, a PIN line for the libfido2 test double (it ignores it);
#     person:   "Authenticator code (checked by the Enclaweder): ".
#   --mode recover (c2-recover.mjs, `codenclawed codenclawed recover-root`):
#     stand-in: the serial (from the report "  device: <ENCLW-|ECPRO-><24 hex>"), the PIN line;
#     person:   "Authenticator code (6 digits): " (read without echo) and
#               "Recovery code (dashes optional, shown while you type): ".
# A line the person types on this process's stdin is passed through and scrubbed from LOG and from the
# echo. Any other prompt stops the command (fail closed). Exit: the command's status; 124 timeout;
# 125 an unexpected prompt; 126 no (well-formed) serial in the report.
#   accept-pty.py [--mode accept|recover] LOG TIMEOUT_S -- argv...
import os, pty, re, select, signal, sys, termios, time

args = sys.argv[1:]
mode = "accept"
if args[:1] == ["--mode"]:
    mode = args[1]
    args = args[2:]
if mode not in ("accept", "recover"):
    sys.stderr.write("accept-pty: --mode accept|recover\n")
    sys.exit(2)
log_path, timeout_s = args[0], float(args[1])
argv = args[args.index("--") + 1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)

# (rule, prompt, echo of the person's own typing on this terminal)
if mode == "accept":
    SERIAL_RE = re.compile(rb"the Enclaweder (\S+) anchored:")
    SERIAL_OK = re.compile(rb"^\S+$")
    RULES = [
        ("serial", re.compile(rb"Type the device's serial[^\n]*:\s*$"), None),
        ("accept", re.compile(rb"Type ACCEPT[^\n]*:\s*$"), None),
        ("pin", re.compile(rb"PIN[^\n]*:\s*$"), None),
        ("person", re.compile(rb"Authenticator code \(checked by the Enclaweder\):\s*$"), True),
    ]
else:
    SERIAL_RE = re.compile(rb"\n\s*device: (\S+)")
    SERIAL_OK = re.compile(rb"^(ENCLW|ECPRO)-[0-9A-Fa-f]{24}$")
    RULES = [
        ("serial", re.compile(rb"Type the serial printed on it[^\n]*:\s*$"), None),
        ("pin", re.compile(rb"PIN[^\n]*:\s*$"), None),
        ("person", re.compile(rb"Authenticator code \(6 digits\):\s*$"), False),
        ("person", re.compile(rb"Recovery code \(dashes optional, shown while you type\):\s*$"), True),
    ]
PROMPT_RE = re.compile(rb"[:?]\s*$")
# Cursor and line controls a line editor writes after a prompt (node readline: ESC[<n>G, ESC[0J ...).
ANSI_RE = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]")
QUIET_S = 5.0


def read_person(echo):
    """One line from the person (this process's stdin); without echo on a terminal when asked."""
    tty = sys.stdin.isatty()
    old = termios.tcgetattr(sys.stdin.fileno()) if tty and not echo else None
    if old is not None:
        new = termios.tcgetattr(sys.stdin.fileno())
        new[3] &= ~termios.ECHO
        termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, new)
    try:
        return sys.stdin.buffer.readline().strip()
    finally:
        if old is not None:
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, old)
            sys.stdout.write("\n")
            sys.stdout.flush()


deadline = time.time() + timeout_s
buf = b""
seen = b""
serial = None
secrets = []
last_data = time.time()


def stop(code):
    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except OSError:
        pass
    sys.exit(code)


carry = b""


def scrub_stream(b, final=False):
    """Scrub every secret from the stream, even one split across reads: the last few bytes wait."""
    global carry
    b = carry + b
    for s in secrets:
        b = b.replace(s, b"*" * len(s))
    keep = 0 if final or not secrets else max(len(s) for s in secrets) - 1
    if keep <= 0:
        carry = b""
        return b
    if len(b) <= keep:
        carry = b
        return b""
    carry = b[len(b) - keep:]
    return b[: len(b) - keep]


def emit(log, b):
    log.write(b)
    log.flush()
    sys.stdout.buffer.write(b)
    sys.stdout.flush()


with open(log_path, "wb") as log:
    while True:
        if time.time() > deadline:
            stop(124)
        r, _, _ = select.select([fd], [], [], 0.5)
        if not r:
            # A prompt no rule answers, and nothing more comes: never guess an answer.
            if buf and PROMPT_RE.search(ANSI_RE.sub(b"", buf).split(b"\n")[-1]) and time.time() - last_data > QUIET_S:
                sys.stdout.write("\naccept-pty: an unexpected prompt; nothing typed, stopping\n")
                sys.stdout.flush()
                stop(125)
            continue
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if not data:
            break
        last_data = time.time()
        emit(log, scrub_stream(data))
        seen = (seen + data)[-65536:]
        m = SERIAL_RE.search(seen)
        if m:
            serial = m.group(1)
        buf = (buf + data)[-4096:]
        clean = ANSI_RE.sub(b"", buf)
        for name, rx, echo in RULES:
            if not rx.search(clean):
                continue
            if name == "serial":
                if not serial or not SERIAL_OK.match(serial):
                    sys.stdout.write("\naccept-pty: the command named no device serial; stopping\n")
                    sys.stdout.flush()
                    stop(126)
                os.write(fd, serial + b"\r")
            elif name == "accept":
                os.write(fd, b"ACCEPT\r")
            elif name == "pin":
                os.write(fd, b"0000\r")
            else:
                line = read_person(echo)
                if line:
                    secrets.append(line)
                os.write(fd, line + b"\r")
            buf = b""
            break
    emit(log, scrub_stream(b"", final=True))
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8))
