#!/usr/bin/env python3
"""Build the coding packs from INTENTS.md (the single source).

INTENTS.md front matter is parsed as YAML (JSON-compatible subset), the
Markdown body becomes `promptTemplate`, and the result is written as JSON.
The eager pack is a generated variant with lower confidence floors, a less
none-biased prompt, and a broader fallback catalog.

Requires: pip install pyyaml
Usage:    python tools/build_pack.py [--check]
"""
import copy
import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "INTENTS.md"
DST = ROOT / "packages" / "pack-coding" / "pack.json"
EAGER_DST = ROOT / "packages" / "pack-coding-eager" / "pack.json"

EAGER_FALLBACK_INTENTS = [
    {
        "id": "continue_task",
        "description": "Ask the agent to continue with the next logical step.",
        "examples": ["继续", "继续下一步", "continue"],
        "render": {"zh-CN": "继续下一步", "en": "continue with the next step"},
        "risk": "reversible",
        "passThrough": True,
    },
    {
        "id": "explain_more",
        "description": "Ask the agent to explain its last answer or finding in more detail.",
        "examples": ["详细说说", "explain that in more detail"],
        "render": {"zh-CN": "再详细解释一下", "en": "explain that in more detail"},
        "risk": "none",
    },
    {
        "id": "summarize_progress",
        "description": "Ask the agent to summarise the current status and remaining work.",
        "examples": ["总结一下进展", "summarise where things stand"],
        "render": {"zh-CN": "总结一下目前进展", "en": "summarise where things stand"},
        "risk": "read_only",
    },
]


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


def build_eager() -> dict:
    pack = copy.deepcopy(build())
    pack["id"] = "builtin/coding-eager"
    pack["description"] = "Eager variant of the built-in coding scenarios: lower floors and a less none-biased prompt."
    pack["policy"] = {"minConfidence": 0.10, "sideEffectMinConfidence": 0.50}
    replacements = [
        ("- `none`: nothing above is likely to be the user's next message.", "- `none`: nothing above plausibly fits."),
        (
            '4. **Honest probabilities**: when you hesitate between intents, pick the most likely one and list the others in `"runnerUps"`. Do not hide a guess behind `"none"` and do not round it up: whether anything is shown is decided from your probabilities.',
            "4. **Prefer the best fit**: when a catalog intent plausibly matches the user's likely next message, choose it even under uncertainty; use `none` only when no intent plausibly fits.",
        ),
    ]
    prompt = pack["promptTemplate"]
    for old, new in replacements:
        if old not in prompt:
            raise ValueError(f"eager prompt replacement is stale: {old!r}")
        prompt = prompt.replace(old, new)
    pack["promptTemplate"] = prompt
    for scenario in pack["scenarios"]:
        policy = scenario.get("policy") or {}
        if "minConfidence" in policy:
            policy["minConfidence"] = min(policy["minConfidence"], 0.20)
        if "sideEffectMinConfidence" in policy:
            policy["sideEffectMinConfidence"] = min(policy["sideEffectMinConfidence"], 0.50)
        if scenario["id"] == "coding.general_followup":
            scenario["description"] = "Fallback when a turn completes normally and no specialised scenario matches."
            existing = {intent["id"] for intent in scenario["intents"]}
            scenario["intents"] += [copy.deepcopy(intent) for intent in EAGER_FALLBACK_INTENTS if intent["id"] not in existing]
    return pack


def outputs() -> list[tuple[Path, dict]]:
    return [(DST, build()), (EAGER_DST, build_eager())]


def main() -> int:
    rendered = [(dst, json.dumps(pack, ensure_ascii=False, indent=2) + "\n") for dst, pack in outputs()]
    if "--check" in sys.argv:
        stale = [dst for dst, text in rendered if not dst.exists() or dst.read_text(encoding="utf-8") != text]
        if stale:
            names = ", ".join(str(dst.relative_to(ROOT)) for dst in stale)
            print(f"out of sync with INTENTS.md: {names}; run: python tools/build_pack.py")
            return 1
        print("pack.json files are in sync with INTENTS.md")
        return 0
    for dst, text in rendered:
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(text, encoding="utf-8", newline="\n")
        print(f"wrote {dst.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
