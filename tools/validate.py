#!/usr/bin/env python3
"""Repository conformance checks for the intent-predict spec documents.

Checks (all must pass):
  1. spec/*.schema.json are valid Draft 2020-12 schemas with resolvable roots.
  2. INTENTS.md front matter validates against spec/scenario-pack.schema.json.
  3. packages/pack-coding/pack.json is exactly what tools/build_pack.py emits.
  4. examples/*.intents.md front matter validates the same way.
  5. eval/golden.jsonl parses; ids are unique; referenced suppressedReasons exist.

Requires: pip install jsonschema pyyaml
Usage:    python tools/validate.py
"""
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

failures = []


def check(name: str, ok: bool, detail: str = ""):
    print(("PASS " if ok else "FAIL ") + name + (f" -- {detail}" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    spec_dir = ROOT / "spec"
    schemas = {p.name: load_json(p) for p in sorted(spec_dir.glob("*.schema.json"))}

    # 1. meta-validation + root must do something
    for name, schema in schemas.items():
        try:
            Draft202012Validator.check_schema(schema)
            rooted = any(k in schema for k in ("$ref", "oneOf", "anyOf", "required", "properties"))
            check(f"schema meta {name}", rooted, "root has no $ref/oneOf/required/properties")
        except Exception as exc:  # noqa: BLE001
            check(f"schema meta {name}", False, str(exc)[:200])

    # offline cross-file $ref resolution: register every schema under its
    # file name and its $id so relative refs never hit the network.
    resources = []
    for name, schema in schemas.items():
        resources.append((name, Resource.from_contents(schema)))
        if schema.get("$id"):
            resources.append((schema["$id"], Resource.from_contents(schema)))
    registry = Registry().with_resources(resources)

    def validate(instance, schema, label):
        errors = list(Draft202012Validator(schema, registry=registry).iter_errors(instance))
        detail = "; ".join(
            f"{'/'.join(map(str, e.absolute_path))}: {e.message[:120]}" for e in errors[:5]
        )
        check(label, not errors, detail)

    pack_schema = schemas["scenario-pack.schema.json"]

    from build_pack import build, parse_intents  # noqa: E402

    # 2. INTENTS.md
    fm, _body = parse_intents((ROOT / "INTENTS.md").read_text(encoding="utf-8"))
    validate(fm, pack_schema, "INTENTS.md front matter validates")

    # 3. pack.json sync + validity of generated form
    built = build()
    on_disk = load_json(ROOT / "packages" / "pack-coding" / "pack.json")
    check("pack.json equals build_pack output", built == on_disk)
    validate(on_disk, pack_schema, "pack.json validates")

    # 4. examples
    for ex in sorted((ROOT / "examples").glob("*.intents.md")) if (ROOT / "examples").exists() else []:
        efm, _ = parse_intents(ex.read_text(encoding="utf-8"))
        validate(efm, pack_schema, f"{ex.name} front matter validates")

    # 5. golden cases
    golden = ROOT / "eval" / "golden.jsonl"
    if golden.exists():
        reasons = set(schemas["prediction.schema.json"]["$defs"]["SuppressedReason"]["enum"])
        ids, ok, detail = set(), True, ""
        for lineno, line in enumerate(golden.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                case = json.loads(line)
            except json.JSONDecodeError as exc:
                ok, detail = False, f"line {lineno}: {exc}"
                break
            if case.get("id") in ids or not case.get("id"):
                ok, detail = False, f"line {lineno}: missing/duplicate id"
                break
            ids.add(case["id"])
            reason = case.get("expect", {}).get("suppressedReason")
            if reason and reason not in reasons:
                ok, detail = False, f"line {lineno}: unknown suppressedReason {reason}"
                break
            if "events" not in case and "text" not in case:
                ok, detail = False, f"line {lineno}: neither events nor text"
                break
            event_errors = []
            validator = Draft202012Validator(schemas["events.schema.json"], registry=registry)
            for ev in case.get("events", []):
                event_errors.extend(validator.iter_errors(ev))
            if event_errors:
                ok, detail = False, f"line {lineno}: invalid event: {event_errors[0].message[:140]}"
                break
        check("eval/golden.jsonl well-formed", ok, detail)
        print(f"      golden cases: {len(ids)}")
    else:
        check("eval/golden.jsonl exists", False)

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
