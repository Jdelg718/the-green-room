#!/usr/bin/env python3
"""Validate the issue #47 original-archetype design fixture."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
FIXTURE = ROOT / "library-v0.1.json"
EXPECTED_ROLES = {
    "AGENTS.md",
    "BACKGROUND.md",
    "VOICE.md",
    "RELATIONSHIPS.md",
    "SCENARIOS.md",
    "PROVENANCE.md",
    "SOURCES.md",
}
REQUIRED = {
    "id",
    "name",
    "room_role",
    "publication_tier",
    "one_line",
    "distinctive_virtue",
    "consequential_flaw",
    "core_drive",
    "core_fear",
    "trigger",
    "temptation",
    "escalation",
    "tell",
    "consequence",
    "recovery",
    "worldview",
    "epistemic_habits",
    "pressure_behavior",
    "risk_appetite",
    "ensemble",
    "boundaries",
    "voice_fingerprint",
    "anti_mimicry",
    "sample_lines",
    "rehearsal_use",
    "research_basis",
}
FORBIDDEN_MIMICRY_TERMS = {
    "sherlock holmes",
    "columbo",
    "saul goodman",
    "ted lasso",
    "spock",
    "tony stark",
    "dr. house",
    "tyrion",
}


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def nonempty_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def main() -> int:
    errors: list[str] = []
    try:
        data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"FAIL: cannot load {FIXTURE}: {exc}", file=sys.stderr)
        return 1

    require(data.get("library_schema_version") == "0.1", "schema must be 0.1", errors)
    require(data.get("status") == "design_fixture_not_loadable_pack", "fixture must not claim loadable-pack status", errors)
    require(set(data.get("pack_projection", {})) == EXPECTED_ROLES, "pack projection must use only current canonical content/metadata roles", errors)

    sources = data.get("research_sources", [])
    source_ids = [source.get("id") for source in sources if isinstance(source, dict)]
    require(len(source_ids) == len(set(source_ids)), "research source IDs must be unique", errors)
    for source in sources:
        if not isinstance(source, dict):
            errors.append("every research source must be an object")
            continue
        parsed = urlparse(str(source.get("url", "")))
        require(parsed.scheme == "https" and bool(parsed.netloc), f"source {source.get('id')} must use an absolute HTTPS URL", errors)
        require(all(nonempty_string(source.get(key)) for key in ("id", "title", "publisher")), f"source {source.get('id')} has an empty identity field", errors)

    archetypes = data.get("archetypes", [])
    require(isinstance(archetypes, list) and len(archetypes) == 8, "fixture must contain exactly eight archetypes", errors)
    ids = [item.get("id") for item in archetypes if isinstance(item, dict)]
    names = [item.get("name") for item in archetypes if isinstance(item, dict)]
    require(len(ids) == len(set(ids)), "archetype IDs must be unique", errors)
    require(len(names) == len(set(names)), "archetype names must be unique", errors)
    require("The Reluctant Counsel" in names, "The Reluctant Counsel is required", errors)

    policy = data.get("publication_policy", {})
    public = set(policy.get("public_candidate_ids", []))
    private = set(policy.get("private_template_ids", []))
    require(public.isdisjoint(private), "public and private policy sets must be disjoint", errors)
    require(public | private == set(ids), "publication policy must classify every archetype exactly once", errors)
    require(private == {"org.greenroom.archetype.reluctant-counsel"}, "only Reluctant Counsel should be private in v0.1", errors)

    all_lines: list[str] = []
    for item in archetypes:
        if not isinstance(item, dict):
            errors.append("every archetype must be an object")
            continue
        label = item.get("name", "<unnamed>")
        missing = REQUIRED - set(item)
        require(not missing, f"{label}: missing fields {sorted(missing)}", errors)
        for key in REQUIRED - {"escalation", "recovery", "epistemic_habits", "risk_appetite", "ensemble", "boundaries", "sample_lines", "rehearsal_use", "research_basis"}:
            require(nonempty_string(item.get(key)), f"{label}: {key} must be a nonempty string", errors)
        require(re.fullmatch(r"org\.greenroom\.archetype\.[a-z0-9-]+", str(item.get("id", ""))) is not None, f"{label}: invalid archetype ID", errors)
        require(item.get("publication_tier") in {"public_candidate", "private_template"}, f"{label}: invalid publication tier", errors)
        require(len(item.get("escalation", [])) == 4 and all(nonempty_string(x) for x in item.get("escalation", [])), f"{label}: escalation must have four nonempty stages", errors)
        require(len(item.get("recovery", [])) >= 3 and all(nonempty_string(x) for x in item.get("recovery", [])), f"{label}: recovery must have at least three steps", errors)
        require(len(item.get("epistemic_habits", [])) >= 3, f"{label}: needs at least three epistemic habits", errors)
        require(len(item.get("boundaries", [])) >= 5, f"{label}: needs at least five boundaries", errors)

        risk = item.get("risk_appetite", {})
        require(set(risk) == {"low", "medium", "high"}, f"{label}: risk appetite must define low, medium, and high", errors)
        require(all(isinstance(risk.get(level), list) and risk[level] for level in ("low", "medium", "high")), f"{label}: each risk band must be nonempty", errors)

        ensemble = item.get("ensemble", {})
        require(all(nonempty_string(ensemble.get(key)) for key in ("offers", "needs")), f"{label}: ensemble offers/needs are required", errors)
        hooks = ensemble.get("chemistry_hooks", [])
        require(len(hooks) >= 3, f"{label}: needs at least three chemistry hooks", errors)
        for hook in hooks:
            require(hook.get("with") in set(ids) - {item.get("id")}, f"{label}: chemistry target must be another fixture archetype", errors)
            require(nonempty_string(hook.get("dynamic")), f"{label}: chemistry dynamic must be nonempty", errors)

        lines = item.get("sample_lines", [])
        require(len(lines) >= 5, f"{label}: needs at least five original sample lines", errors)
        for line in lines:
            require(nonempty_string(line.get("situation")) and nonempty_string(line.get("line")), f"{label}: malformed sample line", errors)
            if nonempty_string(line.get("line")):
                all_lines.append(line["line"])

        scenes = item.get("rehearsal_use", [])
        require(len(scenes) >= 2, f"{label}: needs at least two rehearsal scenes", errors)
        for scene in scenes:
            require(all(nonempty_string(scene.get(key)) for key in ("title", "setup", "success", "failure", "correction")), f"{label}: rehearsal scene is incomplete", errors)

        basis = item.get("research_basis", [])
        require(len(basis) >= 3 and set(basis) <= set(source_ids), f"{label}: research basis must contain at least three known sources", errors)

        text = json.dumps(item, ensure_ascii=False).lower()
        found = sorted(term for term in FORBIDDEN_MIMICRY_TERMS if term in text)
        require(not found, f"{label}: recognizable imitation references found: {found}", errors)
        require("no external" in text or "no tools" in text, f"{label}: must deny external capabilities", errors)

    require(len(all_lines) == len(set(all_lines)), "sample lines must be unique across archetypes", errors)
    voices = [item.get("voice_fingerprint") for item in archetypes if isinstance(item, dict)]
    require(len(voices) == len(set(voices)), "voice fingerprints must be unique", errors)

    if errors:
        print(f"FAIL: {len(errors)} validation error(s)", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print(f"PASS: 8 archetypes, {len(all_lines)} unique sample lines, {len(sources)} grounded sources")
    print(f"PASS: {len(public)} public candidates; {len(private)} private template")
    print("PASS: canonical pack-role projection and ensemble references validated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
