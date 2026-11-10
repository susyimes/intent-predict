#!/usr/bin/env python3
"""Build packages/pack-coding/pack.json from INTENTS.md (the single source).

INTENTS.md front matter is parsed as YAML (JSON-compatible subset), the
Markdown body becomes `promptTemplate`, and the result is written as JSON.

Requires: pip install pyyaml
Usage:    python tools/build_pack.py [--check]
"""
import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "INTENTS.md"
DST = ROOT / "packages" / "pack-coding" / "pack.json"


def parse_intents(text: str):
    lines = text.splitlines()
    closers = [i for i, l in enumerate(lines) if l.strip() == "---"]
    if len(closers) < 2 or closers[0] != 0:
        raise ValueError("INTENTS.md must start with '---' and have a closing '---' line")
    fm = yaml.safe_load("\n".join(lines[1 : closers[1]]))
    body = "\n".join(lines[closers[1] + 1 :]).strip("\n") + "\n"
    return fm, body


def build() -> dict:
    fm, body = parse_intents(SRC.read_text(encoding="utf-8"))
    pack = dict(fm)
    pack["promptTemplate"] = body
    # canonical top-level key order mirrors spec/scenario-pack.schema.json
    order = ["id", "version", "description", "policy", "promptTemplate", "scenarios"]
    return {k: pack[k] for k in order if k in pack}


def main() -> int:
    pack = json.dumps(build(), ensure_ascii=False, indent=2) + "\n"
    if "--check" in sys.argv:
        current = DST.read_text(encoding="utf-8") if DST.exists() else ""
        if current != pack:
            print("pack.json is out of sync with INTENTS.md; run: python tools/build_pack.py")
            return 1
        print("pack.json is in sync with INTENTS.md")
        return 0
    DST.write_text(pack, encoding="utf-8", newline="\n")
    print(f"wrote {DST.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
