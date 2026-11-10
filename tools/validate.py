#!/usr/bin/env python3
"""Repository consistency checks for the intent-predict contract.

All must pass:
  1. spec/*.schema.json are valid Draft 2020-12 schemas (cross-file refs resolved offline).
  2. Every pack (INTENTS.md, examples/, eval/fixtures/) validates and passes the load-time rules.
  3. packages/pack-coding/pack.json is exactly what tools/build_pack.py emits.
  4. Templates of the shipped packs pass the authoring lint.
  5. eval/golden.jsonl is well formed, exercises every SuppressedReason, passes on the reference
     evaluator, and everything the evaluator emits validates against the schemas.
  6. The specification and the reference evaluator have not drifted apart (patterns, default
     prompt, signal allowlist, reason table).
  7. JSON examples in the Markdown documents validate against the schemas.

Requires: pip install jsonschema pyyaml
Usage:    python tools/validate.py
"""
import json
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

from jsonschema import Draft202012Validator  # noqa: E402
from referencing import Registry, Resource  # noqa: E402

import reference  # noqa: E402
from build_pack import build, parse_intents  # noqa: E402

failures = []


def check(name: str, ok: bool, detail: str = ""):
    print(("PASS " if ok else "FAIL ") + name + (f" -- {detail}" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


# Authoring lint: suggestion templates are written in the user's voice, one short line.
LINT = [
    ("meta text", r"^(?:none|null|n/a|nothing|无|没有建议|无需回复|\(.*\)|\[.*\]|<.*>)$"),
    ("label prefix", r"^(?:suggestion|next\s*step|user|prompt|reply|建议|下一步|用户输入|回复)\s*[:：]"),
    ("assistant voice", r"^(?:I\s+will|I'll|Let\s+me|Here\s+is|Here's|Sure[,!]|Certainly|我来|我将|让我|好的，我|当然，|需要我帮你)"),
    ("pure acknowledgement", r"^(?:thanks|thank\s+you|looks\s+good|lgtm|great|awesome|nice\s+work|谢谢|多谢|太好了|不错|辛苦了)[.!！。]?$"),
    ("more than one sentence", r"[。！？!?].|\.\s+[A-Z]"),
    ("formatting", r"[\r\n]|```|^#+\s|^[-*]\s"),
]


def main() -> int:
    schemas = {p.name: json.loads(p.read_text(encoding="utf-8")) for p in sorted((ROOT / "spec").glob("*.schema.json"))}

    # 1. schemas
    for name, schema in schemas.items():
        try:
            Draft202012Validator.check_schema(schema)
            check(f"schema {name}", any(k in schema for k in ("$ref", "oneOf", "required")), "root accepts anything")
        except Exception as exc:  # noqa: BLE001
            check(f"schema {name}", False, str(exc)[:200])
    resources = []
    for name, schema in schemas.items():
        resources += [(name, Resource.from_contents(schema)), (schema["$id"], Resource.from_contents(schema))]
    registry = Registry().with_resources(resources)

    def validator(ref: str):
        name, _, pointer = ref.partition("#")
        return Draft202012Validator({"$ref": schemas[name]["$id"] + ("#" + pointer if pointer else "")}, registry=registry)

    def errors(instance, ref: str) -> list:
        return [f"{'/'.join(map(str, e.absolute_path))}: {e.message[:110]}" for e in validator(ref).iter_errors(instance)]

    # 2. packs
    pack_files = ["INTENTS.md"] + sorted(str(p.relative_to(ROOT)).replace("\\", "/")
                                         for d in ("examples", "eval/fixtures") for p in (ROOT / d).glob("*.intents.md"))
    packs = {}
    for rel in pack_files:
        fm, _ = parse_intents(read(rel))
        packs[rel] = reference.load_pack(ROOT / rel)
        errs = errors(fm, "scenario-pack.schema.json") + reference.pack_errors(fm)
        check(f"pack {rel}", not errs, "; ".join(errs[:4]))

    # 3. generated pack
    on_disk = json.loads(read("packages/pack-coding/pack.json"))
    check("pack.json equals build_pack output", build() == on_disk, "run: python tools/build_pack.py")

    # 4. authoring lint (fixtures are exempt: they exist to be odd)
    lint_errs = []
    for rel in [p for p in pack_files if not p.startswith("eval/")]:
        for scn in packs[rel]["scenarios"]:
            for it in scn["intents"]:
                render = it["render"]
                for text in (render.values() if isinstance(render, dict) else [render]):
                    bare = re.sub(r"[。！？!?.]+$", "", text)
                    for label, rx in LINT:
                        if re.search(rx, bare if label == "more than one sentence" else text, re.I):
                            lint_errs.append(f"{scn['id']}#{it['id']} {text!r}: {label}")
                    if reference.DESTRUCTIVE_RE.search(text) or len(text) > 100:
                        lint_errs.append(f"{scn['id']}#{it['id']} {text!r}: dangerous or longer than 100")
    check("pack templates pass the authoring lint", not lint_errs, "; ".join(lint_errs[:3]))

    # 5. golden cases
    cases = reference.load_cases()
    ids = [c.get("id") for c in cases]
    check("golden ids unique", all(ids) and len(ids) == len(set(ids)))
    reasons = set(schemas["prediction.schema.json"]["$defs"]["SuppressedReason"]["enum"])
    used, shape_errs, run_errs, emit_errs = set(), [], [], []

    def expects(case):
        return [case["expect"]] if case["kind"] == "pipeline" else [s.get("expect", {}) for s in case["steps"]]

    for case in cases:
        for exp in expects(case):
            if "suppressedReason" in exp:
                used.add(exp["suppressedReason"])
        events = case.get("events", []) + [e for s in case.get("steps", []) for e in s.get("observe", [])]
        for ev in events:
            shape_errs += [f"{case['id']}: event {m}" for m in errors(ev, "events.schema.json")]
        for step in case.get("steps", []):
            if "act" in step:
                params = {k: v for k, v in step["act"].items() if k != "hostReply"}
                shape_errs += [f"{case['id']}: act {m}" for m in errors({**params, "predictionId": "p"}, "rpc.schema.json#/$defs/PredictionActParams")]
        if case.get("pack", "INTENTS.md") not in packs:
            shape_errs.append(f"{case['id']}: unknown pack {case.get('pack')}")
        cfg = case.get("config", {})
        if "policy" in cfg:
            shape_errs += [f"{case['id']}: policy {m}" for m in errors(cfg["policy"], "scenario-pack.schema.json#/$defs/GatePolicyPartial")]
        if "options" in cfg:
            shape_errs += [f"{case['id']}: options {m}" for m in errors(cfg["options"], "rpc.schema.json#/$defs/Options")]

        def on_emit(emissions, dispatch, cid=case["id"]):
            for kind, payload in emissions:
                if kind == "updated":
                    emit_errs.extend(f"{cid}: {m}" for m in errors(payload, "rpc.schema.json#/$defs/PredictionUpdatedParams"))
                elif kind == "invalidated":
                    emit_errs.extend(f"{cid}: {m}" for m in errors(payload, "rpc.schema.json#/$defs/PredictionInvalidatedParams"))
                elif kind == "outcome":
                    emit_errs.extend(f"{cid}: {m}" for m in errors(payload, "feedback.schema.json"))
            if dispatch:
                params = {k: v for k, v in dispatch.items() if k != "method"}
                name = "DispatchCommandParams" if dispatch["method"] == "dispatch/command" else "DispatchMessageParams"
                emit_errs.extend(f"{cid}: {m}" for m in errors(params, f"rpc.schema.json#/$defs/{name}"))

        run_errs += [f"{case['id']}: {e}" for e in reference.run_case(case, on_emit=on_emit)]

    check("golden cases are well formed", not shape_errs, "; ".join(shape_errs[:3]))
    check("golden exercises every SuppressedReason", used == reasons,
          f"unused: {sorted(reasons - used)} unknown: {sorted(used - reasons)}")
    check(f"golden cases pass on the reference evaluator ({len(cases)})", not run_errs, "; ".join(run_errs[:3]))
    check("everything the evaluator emits validates", not emit_errs, "; ".join(emit_errs[:3]))

    # 6. specification <-> reference evaluator
    spec = read("SPEC.md")
    missing = [name for name, src in reference.PATTERNS.items() if src not in spec]
    check("SPEC.md prints every pattern the evaluator uses", not missing, f"differs: {missing}")
    check("SPEC.md default prompt equals the evaluator's", reference.DEFAULT_PROMPT.strip() in spec)
    listed = re.search(r"\*\*`signals_json`\.\*\*(.*)", spec)
    keys = re.findall(r"`([A-Za-z]+\.[A-Za-z.]+)`", listed.group(1)) if listed else []
    check("SPEC.md signals_json keys equal the evaluator's", keys == reference.SIGNAL_KEYS, f"spec lists {keys}")
    appendix = spec.split("## Appendix A")[1].split("## Appendix B")[0]
    check("SPEC.md Appendix A lists exactly the SuppressedReason enum",
          set(re.findall(r"`([a-z_]+)`", appendix)) == reasons)
    count = re.search(r"(\d+)\s*种\s*`SuppressedReason`", read("README.md"))
    check("README SuppressedReason count", bool(count) and int(count.group(1)) == len(reasons),
          f"enum has {len(reasons)}")

    stale = [f"{p.name} says {n}" for p in [ROOT / "README.md", ROOT / "ROADMAP.md"] + sorted((ROOT / "docs").glob("*.md"))
             for n in re.findall(r"(\d+)\s*条(?:黄金)?用例", p.read_text(encoding="utf-8")) if int(n) not in (len(cases), 20)]
    check("documents quote the current number of golden cases", not stale, "; ".join(stale))

    # 7. JSON examples in documents
    doc_errs, checked = [], 0
    for path in [ROOT / "README.md", ROOT / "SPEC.md", ROOT / "ROADMAP.md"] + sorted((ROOT / "docs").glob("*.md")):
        text = path.read_text(encoding="utf-8")
        for marker, body in re.findall(r"<!--\s*validate:\s*(\S+)\s*-->\s*```json[^\n]*\n(.*?)```", text, re.S):
            checked += 1
            doc_errs += [f"{path.name}: {m}" for m in errors(json.loads(body), marker)]
        for block in re.findall(r"```jsonc?[^\n]*\n(.*?)```", text, re.S):
            for line in block.splitlines():
                if line.startswith('{"jsonrpc"'):
                    checked += 1
                    doc_errs += [f"{path.name}: {m}" for m in errors(json.loads(line), "rpc.schema.json")]
    check(f"JSON examples in documents validate ({checked})", checked > 0 and not doc_errs, "; ".join(doc_errs[:3]))

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
