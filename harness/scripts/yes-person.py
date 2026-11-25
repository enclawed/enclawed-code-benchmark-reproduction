#!/usr/bin/env python3
# The C1A stand-in PERSON: a bot at a real terminal that approves every question
# codenclawed (or Claude Code) puts to the person, and nothing else.
#
# It runs one interactive codenclawed session on a real pseudo-terminal, exactly
# as a person at a shell does (`codenclawed --model M --permission-mode P`, no -p),
# types the benchmark task as the first prompt, and answers:
#   - codenclawed's own approval prompt ("codenclawed: approval needed ... Type
#     <code> and Enter to approve"): it types the code shown and Enter. It answers
#     only while a process of the session is stopped (codenclawed pauses claude
#     with SIGSTOP before it prompts), so text an agent prints that looks like the
#     prompt is never answered;
#   - Claude Code's own select dialogs (permission dialog, MCP server approval,
#     folder trust): the plain "Yes" option (never "Yes, and don't ask again" when
#     a plain "Yes" exists), or "Use this MCP server"; an AskUserQuestion question
#     from the model: its first option;
#   - the libfido2 test double's PIN prompt at activation (as scripts/pty-run.py).
# Once the model's turn has ended (Claude Code's own transcript: the last
# main-chain assistant message ended without a tool call) and the screen is
# quiet, it ends the session with Ctrl-C twice, like a person would.
# A screen it does not recognize leaves the session waiting: after STALL_S
# without any output it stops the session and reports "stall" (a harness error,
# never a result).
#
#   yes-person.py --out DIR --timeout S --task-file F --transcripts DIR [--forget FILE] -- argv...
# Writes DIR/pty.log (everything drawn), DIR/person.jsonl (one line per event),
# DIR/person.json (summary), DIR/live-transcripts/ (a mirror of Claude Code's
# transcript, for the harness's live account-content guard). Exit code: the
# session's; 124 on timeout, 125 on a stall.
import codecs, fcntl, glob, hashlib, json, os, pty, re, select, shutil, signal, struct, sys, termios, time, unicodedata

ROWS, COLS = 50, 200
STALL_S = float(os.environ.get("YES_PERSON_STALL_S", "60"))
LAUNCH_STALL_S = float(os.environ.get("YES_PERSON_LAUNCH_STALL_S", "120"))
END_QUIET_S = float(os.environ.get("YES_PERSON_END_QUIET_S", "4"))
END_STOP_REASONS = {"end_turn", "stop_sequence", "max_tokens", "refusal"}

# ------------------------------------------------------------------ a minimal terminal screen


class Screen:
    """Enough of a VT100/xterm screen to read what Claude Code's renderer drew."""

    def __init__(self, rows, cols):
        self.rows, self.cols = rows, cols
        self.clear()
        self.saved = (0, 0)
        self.dec = codecs.getincrementaldecoder("utf-8")("replace")
        self.pending = ""

    def clear(self):
        self.grid = [[" "] * self.cols for _ in range(self.rows)]
        self.r = self.c = 0

    def _scroll(self):
        self.grid.pop(0)
        self.grid.append([" "] * self.cols)

    def _lf(self):
        if self.r == self.rows - 1:
            self._scroll()
        else:
            self.r += 1

    def _put(self, ch):
        w = 2 if unicodedata.east_asian_width(ch) in ("W", "F") else (0 if unicodedata.combining(ch) else 1)
        if w == 0:
            return
        if self.c + w > self.cols:
            self.c = 0
            self._lf()
        self.grid[self.r][self.c] = ch
        if w == 2 and self.c + 1 < self.cols:
            self.grid[self.r][self.c + 1] = ""
        self.c += w

    def _csi(self, params, final):
        priv = params.startswith("?")
        nums = [int(x) if x.isdigit() else 0 for x in params.lstrip("?>=").split(";")] if params.lstrip("?>=") else []
        n = (nums[0] if nums and nums[0] else 1)
        if final == "A":
            self.r = max(0, self.r - n)
        elif final == "B" or final == "e":
            self.r = min(self.rows - 1, self.r + n)
        elif final == "C" or final == "a":
            self.c = min(self.cols - 1, self.c + n)
        elif final == "D":
            self.c = max(0, self.c - n)
        elif final == "E":
            self.r, self.c = min(self.rows - 1, self.r + n), 0
        elif final == "F":
            self.r, self.c = max(0, self.r - n), 0
        elif final == "G" or final == "`":
            self.c = min(self.cols - 1, n - 1)
        elif final == "d":
            self.r = min(self.rows - 1, n - 1)
        elif final in "Hf":
            row = nums[0] if len(nums) > 0 and nums[0] else 1
            col = nums[1] if len(nums) > 1 and nums[1] else 1
            self.r, self.c = min(self.rows - 1, row - 1), min(self.cols - 1, col - 1)
        elif final == "J":
            m = nums[0] if nums else 0
            if m == 0:
                self.grid[self.r][self.c:] = [" "] * (self.cols - self.c)
                for i in range(self.r + 1, self.rows):
                    self.grid[i] = [" "] * self.cols
            elif m == 1:
                for i in range(0, self.r):
                    self.grid[i] = [" "] * self.cols
                self.grid[self.r][: self.c + 1] = [" "] * (self.c + 1)
            else:
                self.grid = [[" "] * self.cols for _ in range(self.rows)]
        elif final == "K":
            m = nums[0] if nums else 0
            if m == 0:
                self.grid[self.r][self.c:] = [" "] * (self.cols - self.c)
            elif m == 1:
                self.grid[self.r][: self.c + 1] = [" "] * (self.c + 1)
            else:
                self.grid[self.r] = [" "] * self.cols
        elif final == "X":
            for i in range(self.c, min(self.cols, self.c + n)):
                self.grid[self.r][i] = " "
        elif final == "P":
            row = self.grid[self.r]
            del row[self.c : self.c + n]
            row.extend([" "] * (self.cols - len(row)))
        elif final == "@":
            row = self.grid[self.r]
            for _ in range(n):
                row.insert(self.c, " ")
            del row[self.cols :]
        elif final == "L":
            for _ in range(n):
                self.grid.insert(self.r, [" "] * self.cols)
                self.grid.pop()
        elif final == "M":
            for _ in range(n):
                self.grid.pop(self.r)
                self.grid.append([" "] * self.cols)
        elif final == "S":
            for _ in range(n):
                self._scroll()
        elif final == "T":
            for _ in range(n):
                self.grid.pop()
                self.grid.insert(0, [" "] * self.cols)
        elif final == "s":
            self.saved = (self.r, self.c)
        elif final == "u":
            self.r, self.c = self.saved
        elif final in "hl" and priv and any(x in (47, 1047, 1049) for x in nums):
            self.clear()

    def feed(self, data):
        s = self.pending + self.dec.decode(data)
        self.pending = ""
        i, n = 0, len(s)
        while i < n:
            ch = s[i]
            if ch == "\x1b":
                if i + 1 >= n:
                    self.pending = s[i:]
                    return
                nx = s[i + 1]
                if nx == "[":
                    j = i + 2
                    while j < n and not ("\x40" <= s[j] <= "\x7e"):
                        j += 1
                    if j >= n:
                        self.pending = s[i:]
                        return
                    self._csi(s[i + 2 : j], s[j])
                    i = j + 1
                    continue
                if nx in "]PX^_":
                    j = i + 2
                    while j < n and s[j] != "\x07" and not (s[j] == "\x1b" and j + 1 < n and s[j + 1] == "\\"):
                        j += 1
                    if j >= n:
                        self.pending = s[i:]
                        return
                    i = j + (1 if s[j] == "\x07" else 2)
                    continue
                if nx == "7":
                    self.saved = (self.r, self.c)
                elif nx == "8":
                    self.r, self.c = self.saved
                elif nx == "M":
                    if self.r == 0:
                        self.grid.pop()
                        self.grid.insert(0, [" "] * self.cols)
                    else:
                        self.r -= 1
                elif nx in "()#%":
                    i += 3
                    continue
                i += 2
                continue
            if ch == "\r":
                self.c = 0
            elif ch == "\n" or ch == "\x0b" or ch == "\x0c":
                self._lf()
            elif ch == "\b":
                self.c = max(0, self.c - 1)
            elif ch == "\t":
                self.c = min(self.cols - 1, (self.c // 8 + 1) * 8)
            elif ch < " " or ch == "\x7f":
                pass
            else:
                self._put(ch)
            i += 1

    def lines(self):
        return ["".join(r).rstrip() for r in self.grid]

    def text(self):
        return "\n".join(self.lines()).rstrip()


# ------------------------------------------------------------------ what is on the screen

ANSI_RE = re.compile(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()#%].|\x1b[@-_]")
# codenclawed's prompt (src/approval.mjs): the code is drawn bold; only the code + Enter approves.
CC_PROMPT_RE = re.compile(rb"codenclawed: approval needed(?P<body>.*?)Type \x1b\[1m(?P<code>[a-z]{3})\x1b\[0m and Enter to approve[^:]*: ", re.S)
CC_RESULT_RE = re.compile(rb"codenclawed: (approved|denied(?: \(([^)\r\n]*)\))?)")
PIN_RE = re.compile(rb"PIN[^\n]*:\s*$")
OPT_RE = re.compile(r"^[\s│|]*(❯|›|>)?\s*(\d{1,2})\.\s+(.*?)[\s│|]*$")
READY_RE = re.compile(r"\? for shortcuts")
RULE_RE = re.compile(r"^─{20,}$")


def input_ready(lines):
    """Claude Code's input box: a "❯" line between two horizontal rules (the hint under it depends on the mode)."""
    if READY_RE.search("\n".join(lines)):
        return True
    for i in range(1, len(lines) - 1):
        if lines[i].lstrip().startswith("❯") and RULE_RE.match(lines[i - 1].strip()) and RULE_RE.match(lines[i + 1].strip()):
            return True
    return False


def plain(b):
    return ANSI_RE.sub("", b.decode("utf-8", "replace")).replace("\r", "")


def dialog_on(screen_lines):
    """The last block of numbered options with a selected one (❯), and the text above it."""
    idx = [(i, OPT_RE.match(l)) for i, l in enumerate(screen_lines)]
    idx = [(i, m) for i, m in idx if m]
    if not idx:
        return None
    blocks, cur = [], [idx[0]]
    for a, b in zip(idx, idx[1:]):
        if b[0] - a[0] <= 2 and int(b[1].group(2)) == int(a[1].group(2)) + 1:
            cur.append(b)
        else:
            blocks.append(cur)
            cur = [b]
    blocks.append(cur)
    blocks = [bl for bl in blocks if int(bl[0][1].group(2)) == 1 and len(bl) >= 2 and any(m.group(1) for _, m in bl)]
    if not blocks:
        return None
    bl = blocks[-1]
    opts = [{"n": int(m.group(2)), "label": m.group(3).strip(), "selected": bool(m.group(1))} for _, m in bl]
    first = bl[0][0]
    above = []
    for l in reversed(screen_lines[max(0, first - 30) : first]):
        t = l.strip(" │|╭╮╰╯")
        if re.fullmatch(r"[─━═\-\s]{20,}", l.strip()) and above:
            break
        if t:
            above.append(t)
    text = "\n".join(reversed(above))
    return {"options": opts, "text": text[-3000:], "key": hashlib.sha256((text + "|" + "|".join(o["label"] for o in opts)).encode()).hexdigest()[:16]}


def choose(dialog, pending_tool):
    """Which option a person who approves everything picks, or None (not recognized)."""
    opts = dialog["options"]
    lab = lambda o: re.sub(r"\s*\(esc\)\s*$", "", o["label"]).strip()
    for o in opts:
        if re.fullmatch(r"Yes[.!]?", lab(o)):
            return o, "yes"
    for o in opts:
        if lab(o).startswith("Use this MCP server"):
            return o, "use-this-mcp-server"
    for o in opts:
        if re.match(r"Yes\b", lab(o)) and not re.search(r"don.t ask again|always|all future|for this session|allow all", lab(o), re.I):
            return o, "yes"
    if pending_tool == "AskUserQuestion":
        return opts[0], "first-option (the model's question)"
    for o in opts:
        if re.match(r"Yes\b", lab(o)):
            return o, "yes-only-persistent-option"
    return None


# ------------------------------------------------------------------ Claude Code's transcript


def read_transcript(tdir):
    """Main-chain user/assistant entries of the newest session file (Claude Code writes one per session)."""
    files = sorted(glob.glob(os.path.join(tdir, "*.jsonl")), key=lambda f: os.path.getmtime(f))
    entries = []
    for f in files:
        try:
            with open(f, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    try:
                        m = json.loads(line)
                    except ValueError:
                        continue
                    if m.get("type") in ("user", "assistant") and not m.get("isSidechain"):
                        entries.append(m)
        except OSError:
            pass
    return entries


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
    return ""


def turn_state(entries, task):
    delivered = any(e.get("type") == "user" and text_of((e.get("message") or {}).get("content")).strip() == task.strip() for e in entries)
    # The last entry that is part of the conversation (tool results are user entries).
    last = entries[-1] if entries else None
    ended = False
    pending_tool = None
    if last and last.get("type") == "assistant":
        msg = last.get("message") or {}
        uses = [c for c in (msg.get("content") or []) if isinstance(c, dict) and c.get("type") == "tool_use"]
        if uses:
            pending_tool = uses[-1].get("name")
        elif msg.get("stop_reason") in END_STOP_REASONS or last.get("isApiErrorMessage"):
            ended = True
    return {"delivered": delivered, "ended": ended, "pendingTool": pending_tool, "entries": len(entries)}


def mirror(tdir, dest):
    os.makedirs(dest, exist_ok=True)
    for f in glob.glob(os.path.join(tdir, "**", "*.jsonl"), recursive=True):
        rel = os.path.relpath(f, tdir).replace(os.sep, "__")
        d = os.path.join(dest, rel)
        try:
            if not os.path.exists(d) or os.path.getsize(d) != os.path.getsize(f):
                shutil.copyfile(f, d)
        except OSError:
            pass


# ------------------------------------------------------------------ processes


def descendants(root):
    kids = {}
    for p in os.listdir("/proc"):
        if not p.isdigit():
            continue
        try:
            with open(f"/proc/{p}/stat") as fh:
                st = fh.read()
            rest = st[st.rindex(")") + 2 :].split()
            kids.setdefault(int(rest[1]), []).append((int(p), rest[0]))
        except (OSError, ValueError):
            pass
    out, todo = [], [root]
    while todo:
        x = todo.pop()
        for pid, state in kids.get(x, []):
            out.append((pid, state))
            todo.append(pid)
    return out


def session_paused(root):
    """codenclawed stops claude (SIGSTOP) before it prompts (src/approval.mjs pauser)."""
    return any(state in ("T", "t") for _, state in descendants(root))


# ------------------------------------------------------------------ main


def main():
    a = sys.argv[1:]
    sep = a.index("--")
    opts, argv = a[:sep], a[sep + 1 :]
    o = {opts[i].lstrip("-"): opts[i + 1] for i in range(0, len(opts), 2)}
    out, timeout = o["out"], float(o["timeout"])
    task = open(o["task-file"], encoding="utf-8").read()
    tdir, forget = o["transcripts"], o.get("forget")
    os.makedirs(out, exist_ok=True)
    events_f = open(os.path.join(out, "person.jsonl"), "w")
    t0 = time.time()
    summary = {"version": 1, "status": None, "endedBy": None, "taskTyped": False, "taskDelivered": False, "approvals": [], "activation": [], "unrecognized": None, "exit": None, "wallS": None}

    def ev(kind, **kw):
        e = {"t": round(time.time() - t0, 2), "kind": kind, **kw}
        events_f.write(json.dumps(e) + "\n")
        events_f.flush()
        return e

    pid, fd = pty.fork()
    if pid == 0:
        try:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
        except OSError:
            pass
        os.execvp(argv[0], argv)
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    except OSError:
        pass
    log = open(os.path.join(out, "pty.log"), "wb")
    scr = Screen(ROWS, COLS)
    raw = b""  # everything since the last codenclawed prompt was answered (bounded)
    last_out = time.time()
    last_mirror = 0
    typed_at = None
    retyped = False
    end_sent = None
    term_sent = None
    answered = {}  # dialog key -> time answered
    pending_cc = None  # the approval event waiting for codenclawed's result line
    st = {"delivered": False, "ended": False, "pendingTool": None, "entries": 0}
    status = None
    exit_code = None

    def write(b):
        os.write(fd, b)

    while True:
        now = time.time()
        if now - t0 > timeout:
            status = "timeout"
            ev("timeout", screen=scr.text()[-4000:])
            break
        r, _, _ = select.select([fd], [], [], 0.25)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if not data:
                status = "exited"
                break
            log.write(data)
            log.flush()
            scr.feed(data)
            raw = (raw + data)[-200000:]
            last_out = time.time()
            # Activation (the person's two-factor step, before claude starts): the test double's PIN.
            if typed_at is None and PIN_RE.search(raw[-400:]):
                write(b"0000\r")
                summary["activation"].append(ev("activation-pin", typed="0000 (the libfido2 test double ignores it)"))
                raw = b""
            m = CC_PROMPT_RE.search(raw)
            if m and session_paused(pid):
                body = plain(m.group("body"))
                tool = (re.search(r"tool:\s*(.*)", body) or [None, None])[1]
                time.sleep(0.6)  # after codenclawed's 150 ms drain of queued keys
                code = m.group("code").decode()
                write(code.encode() + b"\r")
                e = {"n": len(summary["approvals"]) + 1, "source": "codenclawed", "tool": tool.strip() if tool else None, "text": ("codenclawed: approval needed" + body).strip()[:4000], "choice": f"typed the code {code} and Enter (approve)", "result": None}
                summary["approvals"].append(e)
                ev("approval", **e)
                pending_cc = e
                raw = raw[m.end() :]
            if pending_cc is not None:
                rm = CC_RESULT_RE.search(raw)
                if rm:
                    pending_cc["result"] = plain(rm.group(0))
                    ev("approval-result", n=pending_cc["n"], result=pending_cc["result"])
                    pending_cc = None
        try:
            wpid, wst = os.waitpid(pid, os.WNOHANG)
            if wpid:
                exit_code = os.waitstatus_to_exitcode(wst)
                status = "exited"
                break
        except ChildProcessError:
            status = "exited"
            break
        if now - last_mirror > 1.0:
            last_mirror = now
            mirror(tdir, os.path.join(out, "live-transcripts"))
            st = turn_state(read_transcript(tdir), task)
            if st["delivered"] and not summary["taskDelivered"]:
                summary["taskDelivered"] = True
                ev("task-delivered")
        quiet = now - last_out
        lines = scr.lines()
        ready = input_ready(lines)
        # Claude Code's select dialogs: before the task (startup) or while the model's turn is running.
        if quiet >= 1.2 and end_sent is None and not (summary["taskDelivered"] and st["ended"]):
            d = dialog_on(lines)
            if d and (d["key"] not in answered or now - answered[d["key"]] > 10):
                pick = choose(d, st["pendingTool"])
                if pick is None:
                    if summary["unrecognized"] is None:
                        summary["unrecognized"] = ev("unrecognized-dialog", text=d["text"], options=d["options"])
                else:
                    opt, why = pick
                    cur = next((x["n"] for x in d["options"] if x["selected"]), 1)
                    keys = (b"\x1b[B" if opt["n"] > cur else b"\x1b[A") * abs(opt["n"] - cur)
                    for k in [keys[i : i + 3] for i in range(0, len(keys), 3)]:
                        write(k)
                        time.sleep(0.15)
                    time.sleep(0.2)
                    write(b"\r")
                    e = {"n": len(summary["approvals"]) + 1, "source": "claude-code", "tool": st["pendingTool"], "text": d["text"], "options": [x["label"] for x in d["options"]], "choice": f"{opt['n']}. {opt['label']}", "rule": why, "repeat": d["key"] in answered, "result": None}
                    summary["approvals"].append(e)
                    ev("approval", **e)
                    answered[d["key"]] = now
                    last_out = time.time()
                    continue
        # The task, typed as the first prompt once Claude Code's input is up.
        if typed_at is None and ready and quiet >= 1.5:
            if forget:
                # The test credential's private key never stays where the session could read it.
                try:
                    os.remove(forget)
                except FileNotFoundError:
                    pass
            write(b"\x1b[200~" + task.encode() + b"\x1b[201~")
            time.sleep(0.6)
            write(b"\r")
            typed_at = now
            summary["taskTyped"] = True
            ev("task-typed", task=task)
            continue
        if typed_at is not None and not summary["taskDelivered"] and not retyped and now - typed_at > 15 and quiet >= 2:
            # The Enter may have landed before the paste was taken in: press it once more.
            write(b"\r")
            retyped = True
            ev("task-enter-again")
        if summary["taskDelivered"] and st["ended"] and end_sent is None and quiet >= END_QUIET_S:
            write(b"\x03")
            time.sleep(0.6)
            write(b"\x03")
            end_sent = now
            summary["endedBy"] = "turn-ended (Ctrl-C twice)"
            ev("end", reason="the model's turn ended")
        if end_sent and term_sent is None and now - end_sent > 30:
            os.kill(pid, signal.SIGTERM)
            term_sent = now
            ev("end-sigterm")
        if term_sent and now - term_sent > 15:
            os.kill(pid, signal.SIGKILL)
            term_sent = now + 10**6
        limit = LAUNCH_STALL_S if typed_at is None else STALL_S
        if end_sent is None and quiet > limit:
            status = "stall"
            ev("stall", quietS=round(quiet, 1), screen=scr.text()[-6000:], transcript=st)
            break
    if status in ("timeout", "stall"):
        try:
            os.kill(pid, signal.SIGTERM)
            for _ in range(40):
                if os.waitpid(pid, os.WNOHANG)[0]:
                    break
                time.sleep(0.25)
            else:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
        except ChildProcessError:
            pass
    else:
        try:
            while True:
                d = os.read(fd, 65536)
                if not d:
                    break
                log.write(d)
        except OSError:
            pass
        if exit_code is None:
            try:
                _, wst = os.waitpid(pid, 0)
                exit_code = os.waitstatus_to_exitcode(wst)
            except ChildProcessError:
                exit_code = -1
    log.close()
    mirror(tdir, os.path.join(out, "live-transcripts"))
    st = turn_state(read_transcript(tdir), task)
    summary["taskDelivered"] = summary["taskDelivered"] or st["delivered"]
    if status == "exited" and summary["endedBy"] is None:
        summary["endedBy"] = "the session exited by itself" if summary["taskTyped"] else "the session exited before Claude Code's input appeared"
    summary.update(status=status, exit=exit_code, wallS=round(time.time() - t0, 1), lastScreen=scr.text()[-4000:])
    with open(os.path.join(out, "person.json"), "w") as fh:
        json.dump(summary, fh, indent=2)
    ev("done", status=status, exit=exit_code)
    if status == "stall":
        sys.stderr.write(f"yes-person: STALL: no output for {STALL_S:.0f} s and the session is not over: a prompt the stand-in person did not recognize (see {out}/person.json lastScreen)\n")
        sys.exit(125)
    if status == "timeout":
        sys.exit(124)
    sys.exit(exit_code if isinstance(exit_code, int) and exit_code >= 0 else 1)


if __name__ == "__main__":
    main()
