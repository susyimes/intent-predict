#!/usr/bin/env python3
"""Reference evaluator: an executable reading of SPEC.md for eval/golden.jsonl.

This is a TEST ORACLE, not the product. It favours being short and literal over
being fast or robust: no settle delay, no real sampler, no transport, no
persistence. Where it disagrees with SPEC.md, SPEC.md governs and the
difference is a bug here.

Section numbers in comments refer to SPEC.md.

Usage:
    python tools/reference.py                 # run every golden case
    python tools/reference.py <case-id> ...   # run some, dumping what happened

Requires: pip install pyyaml jsonschema
"""
import json
import math
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

from build_pack import parse_intents  # noqa: E402

DEFAULT_POLICY = {"minConfidence": 0.60, "sideEffectMinConfidence": 0.80}
DEFAULT_OPTIONS = {
    "enabled": True,
    "blockedModes": ["plan"],
    "samplerMode": "compact",
    "cooldownTurnsAfterDismiss": 3,
    "altMinConfidence": 0.15,
    "redact": "default",
    "optionSets": True,
}
KNOWN_EVENTS = {
    "turn.started", "message.user", "message.agent", "tool.call",
    "tool.result", "artifact", "state", "turn.completed",
}
SESSION_BUSY, TURN_MISMATCH = -32001, -32002


# --------------------------------------------------------------------------
# Regular expressions (2.2, 4.7, 7.1). SPEC patterns are ECMA-262; `_ecma`
# maps the two places where Python's defaults differ: \d and \b are
# ASCII-only in ECMAScript.
# --------------------------------------------------------------------------
def _ecma(pattern: str, flags: int = 0):
    out, i = [], 0
    while i < len(pattern):
        two = pattern[i:i + 2]
        if two == r"\d":
            out.append("[0-9]")
            i += 2
        elif two == r"\b":
            nxt = pattern[i + 2:i + 3]
            leading = nxt.isalpha() or nxt == "("
            out.append("(?<![A-Za-z0-9_])" if leading else "(?![A-Za-z0-9_])")
            i += 2
        elif pattern[i] == "\\":
            out.append(two)
            i += 2
        else:
            out.append(pattern[i])
            i += 1
    return re.compile("".join(out), flags)


# Pattern sources exactly as printed in SPEC.md; tools/validate.py checks that
# each of them occurs verbatim in the specification.
PATTERNS = {
    "check": (
        r"(?:^|[\s;&|(/])(?:pytest|py\.test|unittest|tox|nox|jest|vitest|mocha|ava|playwright\s+test"
        r"|cypress\s+run|node\s+--test|deno\s+(?:test|check|lint)|go\s+(?:test|vet|build)|cargo\s+(?:test|check|clippy|build)"
        r"|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check)|tsc|eslint|ruff|mypy"
        r"|pyright|flake8|make\s+(?:test|check|build|lint)|(?:\./)?gradlew?\s+(?:test|build|check)"
        r"|mvn\s+(?:test|verify|package|compile)|dotnet\s+(?:test|build)|ctest|phpunit|rspec|rake\s+test"
        r"|swift\s+(?:test|build)|bazel\s+(?:test|build))\b"
    ),
    "question": r"(?:吗|呢|好吗|可以吗|对吗|是吗|如何|怎样|哪一个|哪个)\s*[。！!.]?$",
    "numbered": r"^\s*(?:(\d{1,2})[.)、]|[(（](\d{1,2})[)）])\s+(.+)$",
    "recommended": r"[(（]\s*(?:recommended|推荐)\s*[)）]",
    "slash": r'''(?:^|[`"'“「『])(/[a-z][a-z0-9_-]{1,30})(?=$|[`"'”」』\s])''',
    "literal": r'''(?:type|run|enter|reply with|输入|发送|回复)\s*["'“「『]([^"'”」』\n]{1,40})["'”」』]''',
    "destructive": (
        r"(?:\brm\s+-[a-z]*[rf][a-z]*\b|\bgit\s+push\b[^\n]*\s(?:--force\S*|-f)\b|\bgit\s+reset\s+--hard\b"
        r"|\bgit\s+clean\s+-[a-z]*[fd]|\bdrop\s+(?:table|database|schema)\b|\btruncate\s+table\b"
        r"|\bdelete\s+from\b|\bkubectl\s+delete\b|\bterraform\s+destroy\b|\bformat\s+[a-z]:"
        r"|\bchmod\s+(?:-R\s+)?777\b|\bcurl\b[^\n]*\|\s*(?:sh|bash)\b|删库|强制推送|清空数据|不可恢复|永久删除)"
    ),
    "external": (
        r"(?:\bgit\s+push\b|\bgh\s+pr\s+(?:create|merge)\b|\b(?:npm|cargo)\s+publish\b|\bdeploy\b"
        r"|\b(?:kubectl|terraform)\s+apply\b|\bdocker\s+push\b|推送到远端|推到生产|发布到|部署到|合并\s*PR|发送邮件)"
    ),
}
CHECK_RE = _ecma(PATTERNS["check"], re.I)
Q_TRAIL = "\"'”’)）]】」』"
Q_RE = _ecma(PATTERNS["question"])
N_RE = _ecma(PATTERNS["numbered"])
MARK_RE = _ecma(PATTERNS["recommended"], re.I)
SLASH_RE = _ecma(PATTERNS["slash"], re.I)
LITERAL_RE = _ecma(PATTERNS["literal"], re.I)
DESTRUCTIVE_RE = _ecma(PATTERNS["destructive"], re.I)
EXTERNAL_RE = _ecma(PATTERNS["external"], re.I)

KIND_TABLE = {
    "read": "read_file read view cat head tail open_file",
    "search": "search_files grep rg find glob ls list_files web_search websearch session_search",
    "edit": "patch write_file write edit multiedit apply_patch create_file str_replace_editor "
            "str_replace_based_edit_tool notebook_edit notebookedit",
    "delete": "remove_file delete_file rm",
    "execute": "terminal bash shell powershell exec_command execute_code run_command run_terminal_cmd",
    "fetch": "web_extract web_fetch webfetch fetch curl browser_exec",
    "ask_user": "clarify ask_user askuserquestion request_user_input",
}
KIND_BY_NAME = {name: kind for kind, names in KIND_TABLE.items() for name in names.split()}

REDACTIONS = [
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
     "[REDACTED_PRIVATE_KEY]"),
    (re.compile(r"(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}"
                r"|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{16,}|hf_[A-Za-z0-9]{16,})"),
     "[REDACTED_API_KEY]"),
    (re.compile(r"\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}"), r"\1 [REDACTED_TOKEN]"),
    (re.compile(r"([a-z][a-z0-9+.-]*://)[^/\s:@]+:[^/\s:@]+@", re.I), r"\1[REDACTED_AUTH]@"),
    (re.compile(r"((?:api[_-]?key|secret|token|password|access[_-]?key)\s*[:=]\s*)"
                r"['\"]?[A-Za-z0-9._~+/=-]{8,}['\"]?", re.I), r"\1[REDACTED_SECRET]"),
]
STRICT_REDACTIONS = [
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[REDACTED_PII]"),
    (re.compile(r"(?<![0-9])\+?[0-9][0-9 -]{8,14}[0-9](?![0-9])"), "[REDACTED_PII]"),
]


def redact(text: str, strict: bool = False) -> str:
    for rx, repl in REDACTIONS + (STRICT_REDACTIONS if strict else []):
        text = rx.sub(repl, text)
    return text


def is_num(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


# --------------------------------------------------------------------------
# Packs (3)
# --------------------------------------------------------------------------
def load_pack(path) -> dict:
    fm, body = parse_intents(Path(path).read_text(encoding="utf-8"))
    pack = dict(fm)
    if body.strip():
        pack["promptTemplate"] = body
    return pack


def placeholders(obj) -> set:
    if isinstance(obj, str):
        return set(re.findall(r"\{([A-Za-z_][A-Za-z0-9_]*)\}", obj))
    if isinstance(obj, dict):
        return set().union(*[placeholders(v) for v in obj.values()]) if obj else set()
    if isinstance(obj, list):
        return set().union(*[placeholders(v) for v in obj]) if obj else set()
    return set()


def pack_errors(pack: dict) -> list:
    """Load-time rules of 3.2 (schema validity is checked separately)."""
    errs, seen_scn = [], set()

    def regexes(pred):
        if "all" in pred or "any" in pred:
            return [r for p in pred.get("all", pred.get("any")) for r in regexes(p)]
        if "not" in pred:
            return regexes(pred["not"])
        return [pred["matches"]] if "matches" in pred else []

    for scn in pack["scenarios"]:
        if scn["id"] in seen_scn:
            errs.append(f"duplicate scenario id {scn['id']}")
        seen_scn.add(scn["id"])
        seen_int, rx = set(), regexes(scn["match"])
        for it in scn["intents"]:
            where = f"{scn['id']}#{it['id']}"
            if it["id"] in seen_int:
                errs.append(f"duplicate intent id {where}")
            seen_int.add(it["id"])
            slots = it.get("slots", {})
            if it.get("passThrough") and it["risk"] not in ("reversible", "side_effect"):
                errs.append(f"{where}: passThrough requires risk reversible or side_effect")
            if "enumerate" in it:
                slot = slots.get(it["enumerate"]["slot"])
                if not slot or slot["type"] != "number":
                    errs.append(f"{where}: enumerate.slot must name a number slot")
                if it["risk"] == "side_effect":
                    errs.append(f"{where}: enumerate intents cannot be side_effect")
                if "action" in it:
                    errs.append(f"{where}: enumerate intents cannot declare an action")
            for name in placeholders(it["render"]) | placeholders(it.get("action")):
                if name not in slots:
                    errs.append(f"{where}: placeholder {{{name}}} is not a declared slot")
            rx += regexes(it["when"]) if "when" in it else []
            rx += [s["pattern"] for s in slots.values() if "pattern" in s]
        for pattern in rx:
            try:
                if len(pattern) > 256:
                    raise re.error("longer than 256 characters")
                re.compile(pattern)
            except re.error as exc:
                errs.append(f"{scn['id']}: bad regex {pattern!r}: {exc}")
    return errs


# --------------------------------------------------------------------------
# Signals (2.2)
# --------------------------------------------------------------------------
def prose_lines(tail: str) -> list:
    lines = tail.split("\n")
    is_fence = lambda l: l.lstrip().startswith("```")  # noqa: E731
    in_code = sum(1 for l in lines if is_fence(l)) % 2 == 1
    out = []
    for line in lines:
        if is_fence(line):
            in_code = not in_code
        elif not in_code and line.strip():
            out.append(line.strip())
    return out


def is_question(line: str) -> bool:
    line = line.rstrip().rstrip(Q_TRAIL).rstrip()
    return line.endswith(("?", "？")) or bool(Q_RE.search(line))


def agent_message_signals(text: str) -> dict:
    tail = text[-1500:]
    prose = prose_lines(tail)
    sig = {"length": len(text), "tail": tail,
           "endsWithQuestion": bool(prose) and is_question(prose[-1])}

    q = 1 if prose and is_question(prose[-1]) and not N_RE.match(prose[-1]) else 0
    i, run = len(prose) - q, []
    while i > 0 and (m := N_RE.match(prose[i - 1])):
        run.insert(0, (int(m.group(1) or m.group(2)), m.group(3).strip()))
        i -= 1
    valid = 2 <= len(run) <= 9 and [n for n, _ in run] == list(range(1, len(run) + 1))
    sig["optionsCount"] = len(run) if valid else 0
    sig["optionsPrompted"] = False
    if valid:
        sig["options"] = [t for _, t in run]
        preferred = next((k + 1 for k, (_, t) in enumerate(run) if MARK_RE.search(t)), None)
        if preferred is not None:
            sig["preferredOptionIndex"] = preferred
        sig["optionsPrompted"] = bool(q == 1 or (i > 0 and is_question(prose[i - 1])) or preferred)

    hints = []
    for line in prose[-5:]:
        found = [(m.start(1), {"kind": "slash", "value": m.group(1).lower()})
                 for m in SLASH_RE.finditer(line)]
        found += [(m.start(1), {"kind": "type_literal", "value": m.group(1).strip()})
                  for m in LITERAL_RE.finditer(line)]
        hints += [h for _, h in sorted(found, key=lambda x: x[0])]
    sig["hints"] = hints

    scan = text[-8000:]
    sig["proposedRisk"] = ("irreversible" if DESTRUCTIVE_RE.search(scan)
                           else "side_effect" if EXTERNAL_RE.search(scan) else "reversible")
    return sig


def locale_of(user_texts: list) -> str:
    text = " ".join(user_texts[-3:])
    text = re.sub(r"```[\s\S]*?```", " ", text)
    text = re.sub(r"https?://\S+", " ", text)
    chars = [c for c in text if not c.isspace()]
    n = len(chars) or 1
    count = lambda lo, hi: sum(1 for c in chars if lo <= c <= hi)  # noqa: E731
    cjk = count("一", "鿿")
    if count("぀", "ヿ") / n > 0.05:
        return "ja"
    if count("가", "힯") / n > 0.05:
        return "ko"
    if cjk / n >= 0.10 or (cjk >= 2 and len(re.findall(r"[A-Za-z]+", text)) < 5):
        return "zh-CN"
    return "en"


def final_agent_text(turn_events: list) -> str:
    msgs = [e for e in turn_events if e["type"] == "message.agent"]
    finals = [m for m in msgs if m.get("final") is not False]
    return (finals or msgs)[-1]["text"] if msgs else ""


def tool_kind(call: dict) -> str:
    return call.get("kind") or KIND_BY_NAME.get(call["name"].lower(), "other")


def call_failed(result: dict) -> bool:
    return result["status"] == "error" or result.get("exitCode") not in (None, 0)


def extract_signals(session, turn_id: str) -> dict:
    evs = [e for e in session.events if e.get("turnId") == turn_id]
    status = next(e["status"] for e in evs if e["type"] == "turn.completed")
    calls = [e for e in evs if e["type"] == "tool.call"]
    results = {e["callId"]: e for e in evs if e["type"] == "tool.result"}

    def dedupe(items):
        return list(dict.fromkeys(items))

    refs = dedupe(e["ref"] for e in evs if e["type"] == "artifact"
                  and e["kind"] in ("file_changed", "file_created", "file_deleted"))
    edits_ok = sum(1 for c in calls if tool_kind(c) in ("edit", "delete")
                   and results.get(c["callId"], {}).get("status") == "ok")
    execs = [(c, results[c["callId"]]) for c in calls
             if tool_kind(c) == "execute" and c["callId"] in results]

    def is_check(call):
        if isinstance(call.get("check"), bool):
            return call["check"]
        return bool(call.get("command") and CHECK_RE.search(call["command"]))

    checks = [(c, r) for c, r in execs if is_check(c)]
    outputs = {}
    for c in calls:
        r = results.get(c["callId"])
        if r and "output" in r and len(json.dumps(r["output"], ensure_ascii=False, separators=(",", ":")).encode("utf-8")) <= 64 * 1024:
            outputs[c["name"]] = r["output"]

    last_turn = {
        "status": status,
        "toolKinds": dedupe(tool_kind(c) for c in calls),
        "toolNames": dedupe(c["name"] for c in calls),
        "filesChanged": len(refs) if refs else edits_ok,
        "changedPaths": refs,
        "failedExecs": sum(1 for _, r in execs if call_failed(r)),
        "checkRuns": len(checks),
        "toolOutputs": outputs,
    }
    if execs:
        last_turn["lastExecFailed"] = call_failed(execs[-1][1])
    if checks:
        last_turn["lastCheckFailed"] = call_failed(checks[-1][1])

    return {
        "session": {"turnCount": len(session.completed)},
        "lastTurn": last_turn,
        "lastAgentMessage": agent_message_signals(final_agent_text(evs)),
        "user": {"locale": locale_of([e["text"] for e in session.events if e["type"] == "message.user"])},
        "state": dict(session.state),
    }


# --------------------------------------------------------------------------
# Predicates (2.3)
# --------------------------------------------------------------------------
def resolve(signals: dict, path: str):
    if path.startswith("state."):
        return signals["state"].get(path[len("state."):])
    cur = signals
    for seg in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(seg)
        elif isinstance(cur, list) and seg.isdigit() and int(seg) < len(cur):
            cur = cur[int(seg)]
        else:
            return None
        if cur is None:
            return None
    return cur


def strict_eq(a, b) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if is_num(a) and is_num(b):
        return a == b
    return isinstance(a, str) and isinstance(b, str) and a == b


def holds(pred: dict, signals: dict) -> bool:
    if "all" in pred:
        return all(holds(p, signals) for p in pred["all"])
    if "any" in pred:
        return any(holds(p, signals) for p in pred["any"])
    if "not" in pred:
        return not holds(pred["not"], signals)
    value = resolve(signals, pred["signal"])
    ops = {k: v for k, v in pred.items() if k != "signal"}
    if value is None:
        return ops == {"exists": False}
    for op, arg in ops.items():
        ok = {
            "exists": lambda: arg is True,
            "eq": lambda: strict_eq(value, arg),
            "ne": lambda: not strict_eq(value, arg),
            "gt": lambda: is_num(value) and value > arg,
            "gte": lambda: is_num(value) and value >= arg,
            "lt": lambda: is_num(value) and value < arg,
            "lte": lambda: is_num(value) and value <= arg,
            "in": lambda: any(strict_eq(value, x) for x in arg),
            "contains": lambda: (any(strict_eq(x, arg) for x in value) if isinstance(value, list)
                                 else isinstance(value, str) and isinstance(arg, str) and arg in value),
            "matches": lambda: isinstance(value, str) and bool(re.search(arg, value)),
        }[op]()
        if not ok:
            return False
    return True


# --------------------------------------------------------------------------
# Slots, rendering, output checks (4.7)
# --------------------------------------------------------------------------
class Suppress(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def resolve_slots(intent: dict, signals: dict, model_slots: dict, convo: str, preset=None) -> dict:
    out = {}
    for name, spec in intent.get("slots", {}).items():
        value, from_model = (preset or {}).get(name), False
        if value is None and "from" in spec:
            value = resolve(signals, spec["from"])
        if value is None and model_slots.get(name) is not None:
            value, from_model = model_slots[name], True
        if value is None:
            value = spec.get("default")
        if value is None or value == "":
            if spec.get("required"):
                raise Suppress("slot_validation_failed")
            continue
        kind = spec["type"]
        if kind == "number":
            if isinstance(value, str) and re.fullmatch(r"-?[0-9]+(?:\.[0-9]+)?", value):
                value = float(value) if "." in value else int(value)
            if not is_num(value):
                raise Suppress("slot_validation_failed")
        elif not isinstance(value, str):
            raise Suppress("slot_validation_failed")
        elif kind == "enum":
            if value not in spec.get("enum", []):
                raise Suppress("slot_validation_failed")
        else:
            control = any(ord(c) < 32 or ord(c) == 127 for c in value)
            if from_model and value not in convo:
                raise Suppress("slot_validation_failed")
            if kind == "path" and (len(value) > 120 or ".." in value or control
                                   or re.search(r"[\s;|&$`><]", value)):
                raise Suppress("slot_validation_failed")
            if kind == "string" and (len(value) > spec.get("maxLength", 80) or control):
                raise Suppress("slot_validation_failed")
        if "pattern" in spec and not re.search(spec["pattern"], str(value)):
            raise Suppress("slot_validation_failed")
        out[name] = value
    return out


def interpolate(obj, slots: dict):
    if isinstance(obj, str):
        def sub(m):
            if m.group(1) not in slots:
                raise Suppress("slot_validation_failed")
            return str(slots[m.group(1)])
        return re.sub(r"\{([A-Za-z_][A-Za-z0-9_]*)\}", sub, obj)
    if isinstance(obj, dict):
        return {k: (v if k in ("type", "name", "command") else interpolate(v, slots)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [interpolate(v, slots) for v in obj]
    return obj


def render_item(intent: dict, slots: dict, locale: str) -> dict:
    render = intent["render"]
    if isinstance(render, dict):
        template = (render.get(locale) or render.get(locale.split("-")[0])
                    or render.get("en") or next(iter(render.values())))
    else:
        template = render
    text = interpolate(template, slots)
    action = interpolate(intent["action"], slots) if "action" in intent else None
    checked = [text]
    if action and action["type"] == "command":
        checked.append((action["command"] + " " + action.get("args", "")).strip())
    for s in checked:
        if not s.strip() or "\n" in s or "\r" in s or len(s) > 200:
            raise Suppress("output_invalid")
        if DESTRUCTIVE_RE.search(s):
            raise Suppress("output_dangerous")
    item = {"slots": slots, "text": text}
    if action:
        item["action"] = action
    return item


# --------------------------------------------------------------------------
# Prompt (4.5)
# --------------------------------------------------------------------------
DEFAULT_PROMPT = """[INTENT PREDICTION — do not continue the task. Do not call tools.]
Predict the user's NEXT message in this session by choosing from a fixed catalog.

Scenario: {{scenario.description}}
Catalog (pick one id):
{{#each intents}}
- {{id}}: {{description}}{{#if slots}} (slots: {{slots_spec}}){{/if}}{{#if examples}} e.g. {{examples}}{{/if}}
{{/each}}
- none: nothing above fits, or you are not confident.

Rules:
1. Predict what THE USER would type next, not what you think they should do.
2. Read the last lines of the assistant's message first; if it explicitly offers a next step, prefer the matching intent.
3. Prefer "none" over a guess. A wrong suggestion costs more than no suggestion.
4. Fill "slots" only with values that literally appear in the conversation.
5. "confidence" is your probability that the user's next message has this intent. You may list up to 2 runner-ups; all probabilities together must not exceed 1.

{{#if compact}}
Recent conversation (oldest first):
{{transcript}}
{{/if}}
Signals: {{signals_json}}

Reply with a single JSON object only:
{"intent":"<id>","confidence":0.0,"slots":{},"runnerUps":[{"intent":"<id2>","confidence":0.0}]}
"""

SIGNAL_KEYS = [
    "session.turnCount", "lastTurn.status", "lastTurn.toolKinds", "lastTurn.filesChanged",
    "lastTurn.failedExecs", "lastTurn.lastExecFailed", "lastTurn.checkRuns", "lastTurn.lastCheckFailed",
    "lastAgentMessage.endsWithQuestion", "lastAgentMessage.optionsCount",
    "lastAgentMessage.optionsPrompted", "lastAgentMessage.proposedRisk", "user.locale",
]


def signals_json(signals: dict) -> str:
    obj = {k: resolve(signals, k) for k in SIGNAL_KEYS}
    return json.dumps({k: v for k, v in obj.items() if v is not None}, ensure_ascii=False, separators=(",", ":"))


def transcript(session, turn_ids: list, strict: bool) -> str:
    def cut(s, n):
        return s if len(s) <= n else s[:n] + "…"

    lines = []
    for tid in turn_ids:
        evs = [e for e in session.events if e.get("turnId") == tid]
        results = {e["callId"]: e for e in evs if e["type"] == "tool.result"}
        for e in evs:
            if e["type"] == "message.user":
                lines.append("User: " + cut(redact(e["text"], strict), 500))
        tools = []
        for c in (e for e in evs if e["type"] == "tool.call"):
            r = results.get(c["callId"])
            if not r:
                continue
            line = f"Tool: {c['name']}({redact(c.get('command', ''), strict)[:60]}) -> {r['status']}"
            if "exitCode" in r:
                line += f" exit={r['exitCode']}"
            if r.get("summary"):
                line += ": " + redact(r["summary"], strict)
            tools.append(line[:200])
        if len(tools) > 6:
            tools = tools[:2] + [f"Tool: … ({len(tools) - 6} more)"] + tools[-4:]
        lines += tools
        final = redact(final_agent_text(evs), strict)
        if final:
            lines.append("Assistant: " + ("…" + final[-1500:] if len(final) > 1500 else final))
    return "\n".join(lines)


def render_prompt(template: str, scenario: dict, catalog: list, signals: dict, mode: str,
                  transcript_text: str, with_examples: bool) -> str:
    for tag in (r"\{\{#each intents\}\}", r"\{\{/each\}\}", r"\{\{#if compact\}\}", r"\{\{/if\}\}"):
        template = re.sub(rf"(?m)^[ \t]*{tag}[ \t]*\r?\n", lambda m: m.group(0).strip(), template)

    def each(m):
        rows = []
        for it in catalog:
            free = [f"{n}:{s['type']}" for n, s in it.get("slots", {}).items() if "from" not in s]
            examples = it.get("examples", [])[:2] if with_examples else []
            row = m.group(1)
            row = re.sub(r"\{\{#if slots\}\}(.*?)\{\{/if\}\}",
                         lambda mm: mm.group(1).replace("{{slots_spec}}", ", ".join(free)) if free else "",
                         row, flags=re.S)
            row = re.sub(r"\{\{#if examples\}\}(.*?)\{\{/if\}\}",
                         lambda mm: mm.group(1).replace("{{examples}}", " | ".join(examples)) if examples else "",
                         row, flags=re.S)
            rows.append(row.replace("{{id}}", it["id"]).replace("{{description}}", it["description"]))
        return "".join(rows)

    # The standalone-tag rule left the tags glued to the following line; the
    # block bodies therefore keep exactly the line breaks the author wrote.
    out = re.sub(r"\{\{#if compact\}\}(.*?)\{\{/if\}\}",
                 lambda m: m.group(1) if mode == "compact" else "", template, flags=re.S)
    out = re.sub(r"\{\{#each intents\}\}(.*?)\{\{/each\}\}", each, out, flags=re.S)
    scalars = {
        "scenario.id": scenario["id"], "scenario.description": scenario["description"],
        "user.locale": signals["user"]["locale"], "signals_json": signals_json(signals),
        "transcript": transcript_text,
    }
    return re.sub(r"\{\{\s*([^{}]*?)\s*\}\}", lambda m: scalars.get(m.group(1), ""), out)


# --------------------------------------------------------------------------
# Similarity (5.4)
# --------------------------------------------------------------------------
def similarity(a: str, b: str) -> float:
    a, b = " ".join(a.split()), " ".join(b.split())
    if len(a) >= 2 and len(b) >= 2 and (a in b or b in a):
        return 1.0
    ga, gb = [a[i:i + 2] for i in range(len(a) - 1)], [b[i:i + 2] for i in range(len(b) - 1)]
    if not ga or not gb:
        return 0.0
    inter = sum(min(ga.count(g), gb.count(g)) for g in set(ga))
    return 2 * inter / (len(ga) + len(gb))


# --------------------------------------------------------------------------
# Core
# --------------------------------------------------------------------------
class Session:
    def __init__(self, sid: str):
        self.id = sid
        self.events = []        # every known event, in arrival order
        self.completed = []     # turn ids, in completion order
        self.state = {}
        self.live = None        # the live prediction (5.1)
        self.open = None        # {"prediction", "copied"}: outcome not finalized yet (5.4)
        self.last_delivered = None
        self.delivered = 0
        self.cooldown = {}      # session key -> last turnCount in cooldown
        self.model_calls = []   # `at` of each model call
        self.pending = None     # turn id of an evaluation whose sample never returned
        self.clock = 0


class Core:
    def __init__(self, packs: list, config: dict = None):
        config = config or {}
        self.packs = packs
        self.policy = {**DEFAULT_POLICY, **config.get("policy", {})}
        self.options = {**DEFAULT_OPTIONS, **config.get("options", {})}
        self.interactive = config.get("interactive", True)
        self.dispatch_modes = config.get("dispatchModes", [])
        self.sampler = config.get("sampler", "none")
        self.replies = list(self.sampler.get("replies", [])) if isinstance(self.sampler, dict) else []
        self.sessions = {}
        self.seq = 0
        self.trace = {}          # what the last evaluation saw (signals, catalog, prompt)

    # -- events (4.1, 5.1, 5.4) -------------------------------------------
    def observe(self, sid: str, events: list) -> list:
        s = self.sessions.setdefault(sid, Session(sid))
        out = []
        for ev in events:
            kind = ev.get("type")
            if kind not in KNOWN_EVENTS:
                continue                                    # 1.2: accepted and ignored
            if kind == "turn.completed" and ev["turnId"] in s.completed:
                continue                                    # 4.1: duplicate
            s.events.append(ev)
            s.clock = ev.get("at", s.clock)
            turn_id = ev.get("turnId")
            if turn_id is not None:                         # 4.1 / 5.1: another turn is under way
                if s.pending not in (None, turn_id):
                    out += self._abort(s, "aborted")
                if s.live and s.live["sourceTurnId"] != turn_id:
                    out += self._invalidate(s, "turn_started")
            if kind == "state":
                s.state[ev["key"]] = ev["value"]
            elif kind == "message.user":
                if s.open and s.open["prediction"]["sourceTurnId"] != turn_id:
                    out.append(self._finalize(s, "passed", similarity=self._similarity(s.open, ev["text"])))
            elif kind == "turn.completed":
                if s.open:
                    out.append(self._finalize(s, "expired"))
                s.completed.append(ev["turnId"])
                out += self._evaluate(s, ev["turnId"], ev["at"])
        return out

    def cancel(self, sid: str) -> list:
        s = self.sessions.setdefault(sid, Session(sid))
        out = self._abort(s, "aborted") + self._invalidate(s, "cancelled")
        if s.open:
            out.append(self._finalize(s, "expired"))
        return out

    def _abort(self, s, reason):
        if s.pending is None:
            return []
        turn_id, s.pending = s.pending, None
        return [("sampler_cancel", {"sessionId": s.id}), self._updated(s, turn_id, None, reason)]

    def _invalidate(self, s, reason):
        if s.live is None:
            return []
        pid, s.live = s.live["id"], None
        return [("invalidated", {"sessionId": s.id, "predictionId": pid, "reason": reason})]

    def _finalize(self, s, outcome, **extra):
        opened, s.open = s.open, None
        p = opened["prediction"]
        record = {"record": "outcome", "timestamp": s.clock, "sessionId": s.id, "predictionId": p["id"],
                  "qualifiedIntentId": p["qualifiedIntentId"], "outcome": outcome,
                  "copied": opened["copied"], **extra}
        return ("outcome", record)

    @staticmethod
    def _similarity(opened, text):
        p = opened["prediction"]
        items = [p] + p.get("choices", []) + p["alternatives"]
        cands = [i["text"] for i in items]
        cands += [(i["action"]["command"] + " " + i["action"].get("args", "")).strip()
                  for i in [p] + p["alternatives"] if i.get("action", {}).get("type") == "command"]
        return round(max(similarity(c, text) for c in cands), 4)

    def _updated(self, s, turn_id, prediction, reason=None):
        result = {"type": "completed", "prediction": prediction}
        if prediction is None:
            result["suppressedReason"] = reason
        return ("updated", {"sessionId": s.id, "sourceTurnId": turn_id, "result": result})

    # -- pipeline (4.2 - 4.8) ---------------------------------------------
    def _evaluate(self, s, turn_id, at):
        self.trace = {}
        try:
            prediction = self._pipeline(s, turn_id, at)
        except Suppress as exc:
            out = [("sampler_cancel", {"sessionId": s.id})] if exc.reason == "timeout" else []
            return out + [self._updated(s, turn_id, None, exc.reason)]
        if prediction is None:                              # sample pending: nothing to report yet
            s.pending = turn_id
            return []
        s.live = s.last_delivered = prediction             # any older one was invalidated by this turn's events
        s.open = {"prediction": prediction, "copied": False}
        s.delivered += 1
        return [self._updated(s, turn_id, prediction)]

    def _pipeline(self, s, turn_id, at):
        sig = extract_signals(s, turn_id)
        self.trace["signals"] = sig
        status, opts = sig["lastTurn"]["status"], self.options
        turn_calls = [e for e in s.events if e.get("turnId") == turn_id and e["type"] == "tool.call"]
        answered = {e["callId"] for e in s.events if e["type"] == "tool.result"}
        scenarios = [(pack, scn) for pack in self.packs for scn in pack["scenarios"]]

        # 4.2 guards
        guards = [
            (opts["enabled"] is False, "disabled"),
            (self.interactive is False, "non_interactive"),
            (s.state.get("pendingApproval") is True or s.state.get("pendingInput") is True
             or bool(turn_calls and tool_kind(turn_calls[-1]) == "ask_user"
                     and turn_calls[-1]["callId"] not in answered), "pending_interaction"),
            (status == "interrupted", "interrupted_turn"),
            (status == "failed" and not any("failed" in scn.get("triggerOnTurnStatuses", ["completed"])
                                            for _, scn in scenarios), "failed_turn_unhandled"),
            (s.state.get("mode") in opts["blockedModes"], "mode_blocked"),
            (s.state.get("incognito") is True, "incognito"),
            ("maxPerSession" in opts and s.delivered >= opts["maxPerSession"], "max_per_session_reached"),
        ]
        for tripped, reason in guards:
            if tripped:
                raise Suppress(reason)

        # 4.3 routing and catalog
        eligible = [(pack, scn) for pack, scn in scenarios
                    if status in scn.get("triggerOnTurnStatuses", ["completed"]) and holds(scn["match"], sig)]
        pool = [x for x in eligible if not x[1].get("fallback")] or eligible
        if not pool:
            raise Suppress("no_scenario_matched")
        pack, scn = max(pool, key=lambda x: x[1].get("priority", 0))   # max keeps the earliest on ties
        final_text = final_agent_text([e for e in s.events if e.get("turnId") == turn_id])
        # a pass-through "yes" needs something to approve, and that something must look local
        risky = not final_text.strip() or sig["lastAgentMessage"]["proposedRisk"] in ("side_effect", "irreversible")

        def enumerable(it):
            over = resolve(sig, it["enumerate"]["over"])
            return isinstance(over, list) and 2 <= len(over) <= 9 and all(isinstance(x, str) for x in over)

        catalog = [it for it in scn["intents"]
                   if ("when" not in it or holds(it["when"], sig))
                   and not (it.get("passThrough") and risky)
                   and ("enumerate" not in it or enumerable(it))]
        self.trace.update(scenarioId=scn["id"], catalog=[it["id"] for it in catalog])
        if not catalog:
            raise Suppress("empty_catalog")

        locale = sig["user"]["locale"]
        strict = opts["redact"] == "strict"
        recent = [e for e in s.events if e.get("turnId") in s.completed[-3:]]
        convo = "\n".join([e["text"] for e in recent if e["type"] in ("message.user", "message.agent")]
                          + [e["summary"] for e in recent if e["type"] == "tool.result" and e.get("summary")])
        key = lambda it: f"{pack['id']}/{scn['id']}#{it['id']}"  # noqa: E731
        cooling = lambda it: s.cooldown.get(key(it), 0) >= sig["session"]["turnCount"]  # noqa: E731

        # 4.4 rules
        selected, source, confidence, model_slots, runner_ups, choices, preferred = None, "rule", None, {}, [], None, None
        for hint in reversed(sig["lastAgentMessage"]["hints"]):
            value = hint["value"].strip().lower()
            for it in catalog:
                if it["risk"] == "side_effect" or "enumerate" in it:
                    continue
                action = it.get("action", {})
                by_command = hint["kind"] == "slash" and action.get("type") == "command" \
                    and action["command"].lower() == value
                if by_command or value in [e.strip().lower() for e in it.get("examples", [])]:
                    try:
                        resolve_slots(it, sig, {}, convo)
                    except Suppress:
                        continue
                    selected = it
                    break
            if selected:
                break
        if not selected:
            selected = next((it for it in catalog if "enumerate" in it), None)
            if selected:
                enum = selected["enumerate"]
                items = resolve(sig, enum["over"])
                choices = []
                for k, label in enumerate(items, 1):
                    slots = resolve_slots(selected, sig, {}, convo, preset={enum["slot"]: k})
                    item = render_item(selected, slots, locale)
                    label = redact(label, strict)
                    choices.append({"slots": item["slots"], "text": item["text"],
                                    "label": label if len(label) <= 80 else label[:80] + "…"})
                pos = resolve(sig, enum["preferred"]) if "preferred" in enum else None
                if is_num(pos) and 1 <= pos <= len(choices):
                    preferred = int(pos) - 1

        # 4.5 model
        if not selected:
            source = "model"
            if self.sampler == "none":
                raise Suppress("no_sampler")
            budget = opts.get("modelBudget")
            if budget and sum(1 for t in s.model_calls if at - t < 3_600_000) >= budget["maxCallsPerHour"]:
                raise Suppress("budget_exhausted")
            mode = self.sampler.get("mode", "compact")
            template = pack.get("promptTemplate") or DEFAULT_PROMPT
            fits = lambda p: len(p.encode("utf-8")) <= 4000 if mode == "fork" else len(p) <= 8000  # noqa: E731
            prompt, turns = None, s.completed[-3:]
            for with_examples in (True, False):
                prompt = render_prompt(template, scn, catalog, sig, mode, transcript(s, turns, strict), with_examples)
                if fits(prompt):
                    break
            while not fits(prompt) and mode == "compact" and turns:
                turns = turns[1:]
                prompt = render_prompt(template, scn, catalog, sig, mode, transcript(s, turns, strict), False)
            self.trace["prompt"] = prompt
            if not fits(prompt):
                raise Suppress("prompt_too_large")

            s.model_calls.append(at)
            if self.sampler.get("pending"):
                return None
            if self.sampler.get("timeout"):
                raise Suppress("timeout")
            if "error" in self.sampler:
                raise Suppress("sampler_error")
            text = None if self.sampler.get("replyNull") else \
                (self.replies.pop(0) if self.replies else self.sampler.get("reply"))
            if not text:
                raise Suppress("invalid_model_output")

            body = text.strip()
            fenced = re.fullmatch(r"```(?:json)?[ \t]*\n([\s\S]*?)\n?```", body)
            try:
                reply = json.loads(fenced.group(1) if fenced else body)
            except ValueError:
                raise Suppress("invalid_model_output") from None
            valid_conf = lambda c: is_num(c) and 0 <= c <= 1  # noqa: E731
            if not isinstance(reply, dict) or not valid_conf(reply.get("confidence")) \
                    or not isinstance(reply.get("slots", {}), dict):
                raise Suppress("invalid_model_output")
            by_id = {it["id"]: it for it in catalog}
            if not isinstance(reply.get("intent"), str) or reply["intent"] not in {**by_id, "none": None}:
                raise Suppress("unknown_intent")
            if reply["intent"] == "none":
                raise Suppress("model_none")
            selected, confidence, model_slots = by_id[reply["intent"]], reply["confidence"], reply.get("slots", {})
            for ru in reply["runnerUps"] if isinstance(reply.get("runnerUps"), list) else []:
                if isinstance(ru, dict) and ru.get("intent") in by_id and ru["intent"] != selected["id"] \
                        and ru["intent"] not in [r["intent"] for r in runner_ups] and valid_conf(ru.get("confidence")):
                    runner_ups.append(ru)
            runner_ups = runner_ups[:2]

        def offerable(ru):
            """A runner-up that may be offered next to the primary (4.6 option sets, 4.8 alternatives)."""
            it = by_id[ru["intent"]]
            if ru["confidence"] < opts["altMinConfidence"] or it["risk"] == "side_effect" or cooling(it):
                return None
            try:
                alt = render_item(it, resolve_slots(it, sig, ru.get("slots") if isinstance(ru.get("slots"), dict) else {}, convo), locale)
            except Suppress:
                return None
            return {"intentId": it["id"], "confidence": ru["confidence"], **alt,
                    "risk": it["risk"], "passThrough": bool(it.get("passThrough"))}

        # 4.6 gate
        self.trace["selected"] = selected["id"]
        if cooling(selected):
            raise Suppress("in_cooldown")
        option_set = None
        if source == "model":
            name = "sideEffectMinConfidence" if selected["risk"] == "side_effect" else "minConfidence"
            threshold = max(self.policy[name], pack.get("policy", {}).get(name, 0), scn.get("policy", {}).get(name, 0))
            self.trace["threshold"] = threshold
            if confidence < threshold:
                # an option set: the first choice and as few runner-ups as it takes to reach the threshold together
                reached = lambda total: total >= threshold - 1e-9  # noqa: E731
                first, others, total = None, [], confidence
                if opts["optionSets"] and selected["risk"] != "side_effect" and confidence >= opts["altMinConfidence"]:
                    try:
                        first = render_item(selected, resolve_slots(selected, sig, model_slots, convo), locale)
                    except Suppress:
                        first = None
                    for ru in runner_ups if first else []:
                        if reached(total):
                            break
                        member = offerable(ru)
                        if member:
                            others.append(member)
                            total += member["confidence"]
                if not first or not others or not reached(total):
                    raise Suppress("below_min_confidence")
                option_set = (first, others)
                self.trace["optionSet"] = [selected["id"]] + [o["intentId"] for o in others]

        # 4.7 slots, rendering, output checks
        if option_set:
            primary = option_set[0]
        elif choices:
            primary = choices[preferred or 0]
            primary = {"slots": primary["slots"], "text": primary["text"]}
        else:
            primary = render_item(selected, resolve_slots(selected, sig, model_slots, convo), locale)

        # 4.8 assembly
        alternatives = option_set[1] if option_set else [a for a in map(offerable, runner_ups) if a]

        self.seq += 1
        prediction = {
            "id": f"p-{self.seq}", "sessionId": s.id, "sourceTurnId": turn_id,
            "packId": pack["id"], "packVersion": pack["version"], "scenarioId": scn["id"],
            "qualifiedIntentId": f"{pack['id']}@{pack['version']}/{scn['id']}#{selected['id']}",
            "intent": {"id": selected["id"], "confidence": confidence, "slots": primary["slots"]},
            "text": primary["text"], "locale": locale, "risk": selected["risk"],
            "passThrough": bool(selected.get("passThrough")),
            "confirmBeforeSend": selected["risk"] == "side_effect",
            "alternatives": alternatives, "source": source, "createdAt": at,
        }
        if "action" in primary:
            prediction["action"] = primary["action"]
        if option_set:
            prediction["optionSet"] = True
        if choices:
            prediction["choices"] = choices
            if preferred is not None:
                prediction["preferredChoice"] = preferred
        if prediction["passThrough"] or any(a["passThrough"] for a in alternatives):
            final = redact(final_text, strict)
            prediction["context"] = {"excerpt": "…" + final[-300:] if len(final) > 300 else final}
        return prediction

    # -- surface actions (5.2, 5.3) ---------------------------------------
    def act(self, sid: str, params: dict, host_reply: dict = None):
        """Returns (status, dispatch request or None, emissions). Raises ValueError for -32602."""
        s = self.sessions[sid]
        p = s.last_delivered
        live = p is not None and s.live is not None and s.live["id"] == p["id"]
        action = params["action"]
        if action == "copy":
            if s.open and p and s.open["prediction"]["id"] == p["id"]:
                s.open["copied"] = True
            return "recorded", None, []
        if not live:
            return "stale", None, []
        if action == "dismiss":
            # the user turned down every option of a set, not just the first
            for intent_id in [p["intent"]["id"]] + ([a["intentId"] for a in p["alternatives"]] if p.get("optionSet") else []):
                s.cooldown[f"{p['packId']}/{p['scenarioId']}#{intent_id}"] = \
                    len(s.completed) + self.options["cooldownTurnsAfterDismiss"]
            return "recorded", None, [self._finalize(s, "dismissed")] + self._invalidate(s, "resolved")

        item, selected, needs_confirm = p, {"kind": "primary"}, p["confirmBeforeSend"]
        if "choice" in params:
            if not 0 <= params["choice"] < len(p.get("choices", [])):
                raise ValueError("no such choice")
            item = {**p["choices"][params["choice"]], **({"action": p["action"]} if "action" in p else {})}
            selected = {"kind": "choice", "index": params["choice"]}
        elif "alternative" in params:
            item = next((a for a in p["alternatives"] if a["intentId"] == params["alternative"]), None)
            if item is None:
                raise ValueError("no such alternative")
            selected, needs_confirm = {"kind": "alternative", "intentId": item["intentId"]}, False
        if needs_confirm and params.get("confirmed") is not True:
            return "confirmation_required", None, []

        base = {"sessionId": sid, "expectedTurnId": p["sourceTurnId"], "predictionId": p["id"]}
        action_desc = item.get("action", {})
        if params["text"] == item["text"] and action_desc.get("type") == "command" and "command" in self.dispatch_modes:
            request = {"method": "dispatch/command", "command": action_desc["command"], **base}
            if action_desc.get("args"):
                request["args"] = action_desc["args"]
        elif "message" in self.dispatch_modes:
            request = {"method": "dispatch/message", "text": params["text"], **base}
        else:
            return "unsupported", None, []

        code = (host_reply or {}).get("error")
        if code == TURN_MISMATCH:
            return "stale", request, self._invalidate(s, "turn_started")
        if code == SESSION_BUSY:
            return "busy", request, []
        if code is not None:
            return "failed", request, []
        out = [self._finalize(s, "sent", edited=params["text"] != item["text"], selected=selected)]
        return "dispatched", request, out + self._invalidate(s, "resolved")


# --------------------------------------------------------------------------
# Golden runner (9.1)
# --------------------------------------------------------------------------
def subset(expected, actual) -> bool:
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(k in actual and subset(v, actual[k]) for k, v in expected.items())
    if is_num(expected) and is_num(actual):
        return abs(expected - actual) < 1e-6
    return expected == actual and type(expected) is type(actual)


def check_prediction(expected: dict, p) -> list:
    if p is None:
        return ["expected a prediction, none was delivered"]
    exp = dict(expected)
    probes = {
        "intentId": p["intent"]["id"],
        "alternativeIds": [a["intentId"] for a in p["alternatives"]],
        "choiceTexts": [c["text"] for c in p.get("choices", [])],
        "choiceLabels": [c["label"] for c in p.get("choices", [])],
    }
    errs = [f"prediction.{k}: expected {exp[k]!r}, got {v!r}" for k, v in probes.items() if k in exp and exp[k] != v]
    if "contextIncludes" in exp and exp["contextIncludes"] not in p.get("context", {}).get("excerpt", ""):
        errs.append(f"context.excerpt lacks {exp['contextIncludes']!r}: {p.get('context')!r}")
    for k in list(probes) + ["contextIncludes"]:
        exp.pop(k, None)
    for k, v in exp.items():
        if v is None:
            if k in p:
                errs.append(f"prediction.{k}: expected absent, got {p[k]!r}")
        elif k not in p or not subset(v, p[k]):
            errs.append(f"prediction.{k}: expected {v!r}, got {p.get(k)!r}")
    return errs


def check_step(expect: dict, core: Core, emissions: list, status=None, dispatch=None, error=None, addressed=None) -> list:
    errs = []
    updated = [e for k, e in emissions if k == "updated"]
    result = updated[-1]["result"] if updated else None
    if expect.get("noEvaluation") and updated:
        errs.append(f"expected no evaluation, got {result}")
    if "suppressedReason" in expect:
        got = result.get("suppressedReason") if result else None
        if result is None or result["prediction"] is not None or got != expect["suppressedReason"]:
            errs.append(f"expected suppression {expect['suppressedReason']}, got "
                        f"{got or (result and 'prediction ' + result['prediction']['intent']['id']) or 'no evaluation'}")
    if "prediction" in expect:
        if result is None or result["prediction"] is None:
            errs.append(f"expected a prediction, got {result and result.get('suppressedReason') or 'no evaluation'}")
        else:
            errs += check_prediction(expect["prediction"], result["prediction"])
    for path, want in expect.get("signals", {}).items():
        got = resolve(core.trace.get("signals", {"state": {}}), path)
        if got != want or (want is not None and type(got) is not type(want)):
            errs.append(f"signal {path}: expected {want!r}, got {got!r}")
    if "catalog" in expect:
        cat, got = expect["catalog"], core.trace.get("catalog", [])
        if "scenarioId" in cat and core.trace.get("scenarioId") != cat["scenarioId"]:
            errs.append(f"scenario: expected {cat['scenarioId']}, got {core.trace.get('scenarioId')}")
        errs += [f"catalog lacks {i} (has {got})" for i in cat.get("includes", []) if i not in got]
        errs += [f"catalog must not contain {i}" for i in cat.get("excludes", []) if i in got]
    if "prompt" in expect:
        prompt = core.trace.get("prompt")
        if prompt is None:
            errs.append("no prompt was rendered")
        else:
            pe = expect["prompt"]
            errs += [f"prompt lacks {x!r}" for x in pe.get("includes", []) if x not in prompt]
            errs += [f"prompt must not contain {x!r}" for x in pe.get("excludes", []) if x in prompt]
            if "maxBytes" in pe and len(prompt.encode("utf-8")) > pe["maxBytes"]:
                errs.append(f"prompt is {len(prompt.encode('utf-8'))} bytes > {pe['maxBytes']}")
    invalidations = [e for k, e in emissions if k == "invalidated"]
    if "invalidated" in expect and expect["invalidated"] not in [e["reason"] for e in invalidations]:
        errs.append(f"expected invalidated({expect['invalidated']}), got {invalidations}")
    if expect.get("noInvalidation") and invalidations:
        errs.append(f"expected no invalidation, got {invalidations}")
    if expect.get("noOutcome") and any(k == "outcome" for k, _ in emissions):
        errs.append(f"expected no outcome record, got {[e for k, e in emissions if k == 'outcome']}")
    if expect.get("samplerCancelled") and not any(k == "sampler_cancel" for k, _ in emissions):
        errs.append("expected sampler/cancel")
    if "status" in expect and status != expect["status"]:
        errs.append(f"act status: expected {expect['status']}, got {status}")
    if "error" in expect and error != expect["error"]:
        errs.append(f"act error: expected {expect['error']}, got {error}")
    if "dispatch" in expect:
        if expect["dispatch"] is None and dispatch is not None:
            errs.append(f"expected no dispatch, got {dispatch}")
        want = json.loads(json.dumps(expect["dispatch"]).replace("$predictionId", addressed or "?"))
        if want is not None and not subset(want, dispatch):
            errs.append(f"dispatch: expected {want}, got {dispatch}")
    if "outcome" in expect:
        outcomes = [e for k, e in emissions if k == "outcome"]
        if not any(subset(expect["outcome"], o) for o in outcomes):
            errs.append(f"expected outcome {expect['outcome']}, got {outcomes}")
    return errs


_PACKS = {}


def run_case(case: dict, verbose: bool = False, on_emit=None) -> list:
    path = case.get("pack", "INTENTS.md")
    if path not in _PACKS:
        _PACKS[path] = load_pack(ROOT / path)
    core = Core([_PACKS[path]], case.get("config"))
    sid = case.get("sessionId", "s1")

    def emit(emissions, dispatch=None):
        if verbose:
            for kind, payload in emissions:
                print("   ", kind, json.dumps(payload, ensure_ascii=False))
            if dispatch:
                print("    dispatch", json.dumps(dispatch, ensure_ascii=False))
        if on_emit:
            on_emit(emissions, dispatch)

    if case["kind"] == "pipeline":
        events = case["events"]
        state = [{"type": "state", "key": k, "value": v} for k, v in case.get("state", {}).items()]
        emissions = core.observe(sid, events[:-1] + state)
        emissions = core.observe(sid, events[-1:])
        emit(emissions)
        if verbose:
            print("    trace", json.dumps({k: v for k, v in core.trace.items() if k not in ("signals", "prompt")},
                                         ensure_ascii=False))
        return check_step(case["expect"], core, emissions)

    errs = []
    for n, step in enumerate(case["steps"], 1):
        status = dispatch = error = None
        last = core.sessions[sid].last_delivered if sid in core.sessions else None
        addressed = last["id"] if last else None
        if "observe" in step:
            emissions = core.observe(sid, step["observe"])
        elif "cancel" in step:
            emissions = core.cancel(sid)
        else:
            params = {k: v for k, v in step["act"].items() if k != "hostReply"}
            try:
                status, dispatch, emissions = core.act(sid, params, step["act"].get("hostReply"))
            except ValueError:
                status, emissions, error = None, [], -32602
        emit(emissions, dispatch)
        if verbose and status:
            print("    status", status)
        errs += [f"step {n}: {e}" for e in check_step(step.get("expect", {}), core, emissions, status, dispatch, error, addressed)]
    return errs


def load_cases() -> list:
    text = (ROOT / "eval" / "golden.jsonl").read_text(encoding="utf-8")
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def main() -> int:
    wanted = [a for a in sys.argv[1:] if not a.startswith("-")]
    failed = 0
    for case in load_cases():
        if wanted and case["id"] not in wanted:
            continue
        if wanted:
            print(case["id"])
        errs = run_case(case, verbose=bool(wanted))
        if errs:
            failed += 1
            print(f"FAIL {case['id']}")
            for e in errs:
                print("     " + e)
        elif wanted:
            print("  ok")
    print("golden: all cases pass" if not failed else f"golden: {failed} case(s) failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
