#!/usr/bin/env python3
"""Validate and project the Programmable Character Contract v0.1 golden fixture."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import unicodedata
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent
PROGRAM_PATH = ROOT / "golden" / "reluctant-counsel.program.json"
EXPECTED_PATH = ROOT / "golden" / "reluctant-counsel.projection.json"
SCHEMA_PATH = ROOT / "character-program.schema.json"
BUILDER_DRAFT_PATH = ROOT.parent / "persona-builder" / "golden" / "boundary-setter-input.json"

ROOT_KEYS = {
    "contract_version",
    "program_id",
    "core",
    "virtues",
    "flaw",
    "worldview",
    "epistemic_habits",
    "risk_appetite",
    "interaction",
    "uncertainty_posture",
    "pressure_behavior",
    "relationship_hooks",
    "chemistry",
    "rehearsal_scenarios",
    "immutable_safety_ref",
    "forbidden_effects",
}
FORBIDDEN_KEYS = {
    "grant_tools",
    "change_capabilities",
    "override_safety",
    "fabricate_facts",
    "fabricate_authority",
    "coach_concealment_or_obstruction",
    "coach_fraud_or_harm",
}
STATES = {"baseline", "tempted", "escalated", "consequence", "recovering", "cooldown"}


def markdown_block_marker(value: str) -> bool:
    """Match Persona Builder's single-line Markdown/HTML block grammar."""
    line = value.lstrip(" ")
    return bool(
        re.match(r"#{1,6}(?:\s|$)|[-*+](?:\s|$)|>(?:\s|$)", line)
        or re.match(r"(?:`{3,}|~{3,})", line)
        or re.fullmatch(r"(?:[-*_][ \t]*){3,}", line)
        or re.match(r"\d{1,9}[.)](?:\s|$)", line)
        or re.match(
            r"<(?:!--|!\[CDATA\[|!DOCTYPE|\?|/?[A-Za-z][^>]*>)",
            line,
            re.IGNORECASE,
        )
    )


def validate_authored_strings(value: Any, pointer: str = "") -> None:
    """Apply Persona Builder canonical single-line slot rules recursively."""
    if isinstance(value, str):
        location = pointer or "/"
        if unicodedata.normalize("NFC", value) != value:
            raise ValueError(f"string is not NFC at {location}")
        for character in value:
            codepoint = ord(character)
            if 0xD800 <= codepoint <= 0xDFFF:
                raise ValueError(f"invalid Unicode scalar at {location}")
            if 0xFDD0 <= codepoint <= 0xFDEF or codepoint & 0xFFFF in (
                0xFFFE,
                0xFFFF,
            ):
                raise ValueError(f"Unicode noncharacter at {location}")
            if codepoint < 0x20 or 0x7F <= codepoint <= 0x9F:
                raise ValueError(f"single-line field contains control character at {location}")
        if markdown_block_marker(value):
            raise ValueError(f"single-line Markdown block marker at {location}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            validate_authored_strings(item, f"{pointer}/{index}")
    elif isinstance(value, dict):
        for key, item in value.items():
            validate_authored_strings(item, f"{pointer}/{key}")


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )


def unique(items: list[dict[str, Any]], field: str, where: str) -> None:
    values = [item[field] for item in items]
    if len(values) != len(set(values)):
        raise ValueError(f"duplicate {where} {field}")


def reduce_signals(
    initial_state: dict[str, Any],
    signals: list[dict[str, Any]],
    policy: dict[str, int],
) -> tuple[list[str], dict[str, Any]]:
    """Reduce one ordered scene signal stream without model or host input."""
    record = dict(initial_state)
    observed: list[str] = []
    processed: dict[str, bytes] = {}
    next_sequence = 1
    for signal in signals:
        event_id = signal["event_id"]
        encoded_signal = canonical_bytes(signal)
        if event_id in processed:
            if processed[event_id] != encoded_signal:
                raise ValueError(f"event_id reused with different signal: {event_id}")
            observed.append(record["state"])
            continue
        if signal["sequence"] != next_sequence:
            raise ValueError(
                f"out-of-order signal: expected sequence {next_sequence}, "
                f"received {signal['sequence']}"
            )
        processed[event_id] = encoded_signal
        next_sequence += 1
        state = record["state"]
        event = signal["event"]
        if state == "baseline":
            qualifies = (
                event == "turn_open"
                and bool(signal["trigger_ids"])
                and signal["intensity"] >= policy["activation_threshold"]
                and record["activation_count"] < policy["max_activations_per_scene"]
            )
            if qualifies:
                record["state"] = "tempted"
                record["activation_count"] += 1
                record["influenced_turns"] = 0
                record["unreinforced_turns"] = 0
        elif state in {"tempted", "escalated"}:
            if event in {"candidate_committed", "candidate_blocked"}:
                if record["influenced_turns"] >= policy["max_consecutive_influenced_turns"]:
                    record["state"] = "recovering"
                else:
                    record["state"] = "consequence"
                    record["influenced_turns"] += 1
            elif (
                event == "turn_open"
                and signal["reinforcement"]
                and record["influenced_turns"] < policy["max_consecutive_influenced_turns"]
            ):
                record["state"] = "escalated"
                record["unreinforced_turns"] = 0
            elif event == "turn_close":
                record["unreinforced_turns"] += 1
                if record["unreinforced_turns"] >= policy["decay_after_unreinforced_turns"]:
                    record["state"] = "recovering"
        elif state == "consequence" and event == "turn_close":
            record["state"] = "recovering"
        elif state == "recovering" and event == "turn_close" and signal["recovery_completed"]:
            record["state"] = "cooldown"
            record["cooldown_remaining"] = policy["cooldown_turns"]
        elif state == "cooldown" and event == "turn_close":
            record["cooldown_remaining"] = max(0, record["cooldown_remaining"] - 1)
            if record["cooldown_remaining"] == 0:
                record["state"] = "baseline"
        observed.append(record["state"])
    return observed, record


def reduce_scenario(
    scenario: dict[str, Any], policy: dict[str, int]
) -> tuple[list[str], dict[str, Any]]:
    return reduce_signals(scenario["initial_state"], scenario["signals"], policy)


def validate(program: dict[str, Any]) -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    schema_errors = sorted(
        Draft202012Validator(schema).iter_errors(program),
        key=lambda error: tuple(str(part) for part in error.absolute_path),
    )
    if schema_errors:
        error = schema_errors[0]
        pointer = "/" + "/".join(str(part) for part in error.absolute_path)
        raise ValueError(f"schema violation at {pointer or '/'}: {error.message}")
    validate_authored_strings(program)
    if set(program) != ROOT_KEYS:
        raise ValueError(f"root keys differ: {sorted(set(program) ^ ROOT_KEYS)}")
    if program["contract_version"] != "0.1":
        raise ValueError("unsupported character contract")
    if program["immutable_safety_ref"] != "org.greenroom.immutable-safe-defaults/0.1.0":
        raise ValueError("immutable safety reference changed")
    if set(program["forbidden_effects"]) != FORBIDDEN_KEYS:
        raise ValueError("forbidden_effects keys differ")
    if any(value is not False for value in program["forbidden_effects"].values()):
        raise ValueError("every forbidden effect must be literal false")

    unique(program["virtues"], "id", "virtue")
    unique(program["flaw"]["trigger"], "id", "trigger")
    unique(program["risk_appetite"], "domain", "risk domain")
    unique(program["relationship_hooks"], "id", "relationship hook")
    unique(program["chemistry"], "target_id", "chemistry target")
    unique(program["rehearsal_scenarios"], "scenario_id", "scenario")

    levels = [item["level"] for item in program["flaw"]["escalation"]]
    if levels != list(range(1, len(levels) + 1)):
        raise ValueError("escalation levels must be contiguous and authored in order")
    steps = [item["step"] for item in program["flaw"]["recovery"]]
    if steps != list(range(1, len(steps) + 1)):
        raise ValueError("recovery steps must be contiguous and authored in order")

    policy = program["flaw"]["policy"]
    bounds = {
        "activation_threshold": (1, 3),
        "max_activations_per_scene": (1, 3),
        "max_consecutive_influenced_turns": (1, 2),
        "cooldown_turns": (1, 12),
        "decay_after_unreinforced_turns": (1, 3),
    }
    for key, (minimum, maximum) in bounds.items():
        value = policy[key]
        if type(value) is not int or not minimum <= value <= maximum:
            raise ValueError(f"invalid policy bound: {key}")

    controls = program["interaction"]
    for key in ("dissent", "directness", "warmth"):
        if type(controls[key]) is not int or not 0 <= controls[key] <= 4:
            raise ValueError(f"invalid interaction control: {key}")
    if type(controls["humor"]) is not int or not 0 <= controls["humor"] <= 2:
        raise ValueError("invalid interaction control: humor")

    trigger_ids = {item["id"] for item in program["flaw"]["trigger"]}
    for scenario in program["rehearsal_scenarios"]:
        if len(scenario["signals"]) != len(scenario["expected_states"]):
            raise ValueError(f"signal/state length mismatch: {scenario['scenario_id']}")
        if not set(scenario["expected_states"]) <= STATES:
            raise ValueError(f"unknown state: {scenario['scenario_id']}")
        initial = scenario["initial_state"]
        if initial["state"] not in STATES:
            raise ValueError(f"unknown initial state: {scenario['scenario_id']}")
        if initial["activation_count"] > policy["max_activations_per_scene"]:
            raise ValueError(f"initial activation count exceeds policy: {scenario['scenario_id']}")
        event_ids: set[str] = set()
        for sequence, signal in enumerate(scenario["signals"], start=1):
            if signal["sequence"] != sequence:
                raise ValueError(f"noncontiguous signal sequence: {scenario['scenario_id']}")
            if signal["event_id"] in event_ids:
                raise ValueError(f"duplicate event ID: {scenario['scenario_id']}")
            event_ids.add(signal["event_id"])
            if len(signal["trigger_ids"]) != len(set(signal["trigger_ids"])):
                raise ValueError(f"duplicate trigger reference: {scenario['scenario_id']}")
            if not set(signal["trigger_ids"]) <= trigger_ids:
                raise ValueError(f"unknown trigger reference: {scenario['scenario_id']}")
            if signal["trigger_ids"] != sorted(signal["trigger_ids"]):
                raise ValueError(f"trigger references not sorted: {scenario['scenario_id']}")
        observed, _ = reduce_scenario(scenario, policy)
        if observed != scenario["expected_states"]:
            raise ValueError(
                f"state oracle mismatch for {scenario['scenario_id']}: "
                f"expected {scenario['expected_states']}, observed {observed}"
            )


def migrate_builder_draft_v01(source: dict[str, Any], program: dict[str, Any]) -> dict[str, Any]:
    """Apply the documented explicit v0.1 -> v0.2 migration."""
    if source.get("draft_schema_version") != "0.1":
        raise ValueError("migration source must be Persona Builder draft 0.1")
    migrated = copy.deepcopy(source)
    migrated["draft_schema_version"] = "0.2"
    migrated["generator"]["template_version"] = "0.2.0"
    migrated["generator"]["generator_version"] = "0.2.0"
    migrated["character_program"] = copy.deepcopy(program)
    migrated["behavior"]["directness"] = program["interaction"]["directness"]
    migrated["behavior"]["warmth"] = program["interaction"]["warmth"]
    migrated["behavior"]["humor"] = program["interaction"]["humor"]
    migrated["behavior"]["disagreement"] = program["interaction"]["dissent"]
    migrated["revision"] = source["revision"] + 1
    migrated["validation"]["status"] = "not_run"
    migrated["validation"]["candidate_sha256"] = None
    migrated["validation"]["validator_report_ref"] = None
    return migrated


def verify_state_machine(program: dict[str, Any]) -> None:
    """Exercise deterministic replay, ordering, bounds, recovery, and cooldown."""
    policy = program["flaw"]["policy"]
    scenarios = {item["scenario_id"]: item for item in program["rehearsal_scenarios"]}
    required = {
        "novel-but-lawful",
        "concealment-request",
        "recurrence-bound",
        "reinforced-escalation",
        "unreinforced-decay",
        "cooldown-suppresses-trigger",
    }
    if not required <= scenarios.keys():
        raise ValueError(f"missing state-machine scenarios: {sorted(required - scenarios.keys())}")

    for scenario in scenarios.values():
        first = reduce_scenario(scenario, policy)
        second = reduce_scenario(copy.deepcopy(scenario), copy.deepcopy(policy))
        if first != second:
            raise ValueError(f"nondeterministic replay: {scenario['scenario_id']}")

    sample = scenarios["novel-but-lawful"]
    duplicate_stream = [sample["signals"][0], sample["signals"][0]]
    states, final = reduce_signals(sample["initial_state"], duplicate_stream, policy)
    if states != ["tempted", "tempted"] or final["activation_count"] != 1:
        raise ValueError("duplicate event replay is not idempotent")

    shuffled = copy.deepcopy(sample["signals"][:2])
    shuffled.reverse()
    try:
        reduce_signals(sample["initial_state"], shuffled, policy)
    except ValueError as error:
        if "out-of-order signal" not in str(error):
            raise
    else:
        raise ValueError("shuffled events were accepted")

    recurrence_states, recurrence_final = reduce_scenario(scenarios["recurrence-bound"], policy)
    if (
        set(recurrence_states) != {"baseline"}
        or recurrence_final["activation_count"] != policy["max_activations_per_scene"]
    ):
        raise ValueError("activation cap did not suppress recurrence")

    lifecycle_states, lifecycle_final = reduce_scenario(sample, policy)
    if lifecycle_states[-1] != "baseline" or lifecycle_final["cooldown_remaining"] != 0:
        raise ValueError("recovery/cooldown lifecycle did not return to baseline")


def verify_projection_and_migration(program: dict[str, Any], actual: dict[str, Any]) -> None:
    """Prove mappings, safety precedence, capability non-expansion, and migration."""
    expected_patch = {
        "/behavior/directness": program["interaction"]["directness"],
        "/behavior/warmth": program["interaction"]["warmth"],
        "/behavior/humor": program["interaction"]["humor"],
        "/behavior/disagreement": program["interaction"]["dissent"],
    }
    if actual["persona_builder_patch"] != expected_patch:
        raise ValueError("persona-builder projection mapping changed")
    if set(actual) != {
        "projection_version",
        "persona_builder_patch",
        "persona_files",
        "unchanged_files",
        "persona_pack_schema_version",
    }:
        raise ValueError("projection gained an undeclared effect")
    if set(actual["persona_files"]) != {
        "AGENTS.md",
        "VOICE.md",
        "RELATIONSHIPS.md",
        "SCENARIOS.md",
        "PROVENANCE.md",
    }:
        raise ValueError("projection changed the canonical file-role set")
    if any(program["forbidden_effects"].values()):
        raise ValueError("character program gained a forbidden capability or safety effect")
    if program["immutable_safety_ref"] not in actual["persona_files"]["PROVENANCE.md"]:
        raise ValueError("immutable safety precedence was not preserved in provenance")

    source = json.loads(BUILDER_DRAFT_PATH.read_text(encoding="utf-8"))
    source_bytes = canonical_bytes(source)
    migrated = migrate_builder_draft_v01(source, program)
    if canonical_bytes(source) != source_bytes:
        raise ValueError("migration mutated its v0.1 source")
    if set(migrated) != set(source) | {"character_program"}:
        raise ValueError("migration changed the closed root by more than character_program")
    if migrated["draft_schema_version"] != "0.2" or migrated["generator"] != {
        "template_id": source["generator"]["template_id"],
        "template_version": "0.2.0",
        "generator_version": "0.2.0",
    }:
        raise ValueError("migration versions differ from the v0.2 contract")
    if migrated["revision"] != source["revision"] + 1:
        raise ValueError("migration did not increment revision exactly once")
    if migrated["risk"]["input_revision"] == migrated["revision"]:
        raise ValueError("migration failed to make risk classification stale")
    if (
        migrated["validation"]["status"] != "not_run"
        or migrated["validation"]["candidate_sha256"] is not None
    ):
        raise ValueError("migration failed to make validation stale")
    migrated_controls = {
        key: migrated["behavior"][key] for key in ("directness", "warmth", "humor", "disagreement")
    }
    expected_controls = {
        "directness": program["interaction"]["directness"],
        "warmth": program["interaction"]["warmth"],
        "humor": program["interaction"]["humor"],
        "disagreement": program["interaction"]["dissent"],
    }
    if migrated_controls != expected_controls:
        raise ValueError("migration interaction mapping changed")


def bullets(values: list[str], indent: str = "") -> list[str]:
    return [f"{indent}- {value}" for value in values]


def render_agents(p: dict[str, Any]) -> str:
    f = p["flaw"]
    lines = [
        "## Programmable character",
        "",
        f"Program ID: `{p['program_id']}`",
        "",
        "### Core",
        "",
        f"- Drive: {p['core']['drive']}",
        f"- Fear: {p['core']['fear']}",
        "",
        "### Virtues and shadows",
        "",
    ]
    for item in p["virtues"]:
        lines.extend(
            [
                f"- `{item['id']}` — {item['virtue']}: {item['behavior']}",
                f"  Shadow: {item['shadow_side']}",
            ]
        )
    lines.extend(
        [
            "",
            f"### Flaw: {f['label']} (`{f['id']}`)",
            "",
            f"Temptation: {f['temptation']}",
            "",
            "Triggers:",
        ]
    )
    for item in f["trigger"]:
        lines.extend(
            [
                f"- `{item['id']}`: {item['cue']}",
                f"  Permitted bias: {item['behavior_bias']}",
            ]
        )
    lines.extend(["", "Rationalizations:", *bullets(f["rationalizations"]), "", "Escalation:"])
    for item in f["escalation"]:
        lines.extend(
            [
                f"- Level {item['level']}: {item['behavior_change']}",
                f"  Stop: {item['stop_condition']}",
            ]
        )
    lines.extend(["", "Consequences:", *bullets(f["consequences"]), "", "Recovery:"])
    for item in f["recovery"]:
        lines.append(f"- Step {item['step']}: {item['action']}")
    policy = f["policy"]
    lines.extend(
        [
            "",
            "Bounds:",
            f"- Activation threshold: {policy['activation_threshold']}",
            f"- Activations per scene: {policy['max_activations_per_scene']}",
            f"- Consecutive influenced turns: {policy['max_consecutive_influenced_turns']}",
            f"- Cooldown turns: {policy['cooldown_turns']}",
            f"- Unreinforced decay turns: {policy['decay_after_unreinforced_turns']}",
            "",
            "### Worldview",
            "",
            "Beliefs:",
            *bullets(p["worldview"]["beliefs"]),
            "",
            "Counterweights:",
            *bullets(p["worldview"]["counterweights"]),
            "",
            "### Epistemic and authority posture",
            "",
        ]
    )
    for key in (
        "assumptions",
        "evidence",
        "source_discipline",
        "correction",
        "authority_posture",
    ):
        lines.append(f"- {key.replace('_', ' ').title()}: {p['epistemic_habits'][key]}")
    lines.extend(["", "### Risk appetite", ""])
    for item in p["risk_appetite"]:
        lines.append(f"- `{item['domain']}` ({item['appetite']}): {item['decision_rule']}")
    lines.extend(["", "### Pressure behavior", ""])
    for key in (
        "under_time_pressure",
        "under_social_pressure",
        "under_conflict",
        "after_error",
    ):
        lines.append(f"- {key.replace('_', ' ').title()}: {p['pressure_behavior'][key]}")
    return "\n".join(lines) + "\n"


def render_voice(p: dict[str, Any]) -> str:
    u = p["uncertainty_posture"]
    lines = [
        "## Programmable expression",
        "",
        f"- Dissent: {p['interaction']['dissent']}/4",
        f"- Directness: {p['interaction']['directness']}/4",
        f"- Warmth: {p['interaction']['warmth']}/4",
        f"- Humor: {p['interaction']['humor']}/2",
        f"- Uncertainty default: {u['default']}",
        "",
        "Confidence language:",
        *bullets(u["confidence_language"]),
        "",
        f"Unknown action: {u['unknown_action']}",
        f"Jurisdiction or context action: {u['jurisdiction_or_context_action']}",
        "",
        "Visible flaw tells:",
        *bullets(p["flaw"]["visible_tells"]),
    ]
    return "\n".join(lines) + "\n"


def render_relationships(p: dict[str, Any]) -> str:
    lines = ["## Programmable relationships", "", "### Hooks", ""]
    for item in p["relationship_hooks"]:
        lines.extend([f"- `{item['id']}`: {item['cue']}", f"  Response: {item['response']}"])
    lines.extend(["", "### Chemistry", ""])
    for item in p["chemistry"]:
        lines.extend(
            [
                f"- `{item['target_id']}`: {item['dynamic']}",
                f"  Friction: {item['friction']}",
                f"  Repair: {item['repair']}",
            ]
        )
    return "\n".join(lines) + "\n"


def render_scenarios(p: dict[str, Any]) -> str:
    lines = ["## Programmable rehearsal", ""]
    for scenario in p["rehearsal_scenarios"]:
        lines.extend(
            [
                f"### {scenario['title']}",
                "",
                f"Scenario ID: `{scenario['scenario_id']}`",
                "",
                f"Setup: {scenario['setup']}",
                "",
                "Signals and expected state:",
            ]
        )
        initial = scenario["initial_state"]
        lines.append(
            "- Initial: "
            f"state={initial['state']}; activations={initial['activation_count']}; "
            f"influenced_turns={initial['influenced_turns']}; "
            f"unreinforced_turns={initial['unreinforced_turns']}; "
            f"cooldown_remaining={initial['cooldown_remaining']}"
        )
        for signal, state in zip(scenario["signals"], scenario["expected_states"], strict=True):
            triggers = ",".join(signal["trigger_ids"]) or "none"
            lines.append(
                f"- {signal['event_id']} (sequence={signal['sequence']}; "
                f"turn={signal['turn_id']}); {signal['event']}; "
                f"triggers={triggers}; intensity={signal['intensity']}; "
                f"reinforcement={str(signal['reinforcement']).lower()}; "
                f"recovery_completed={str(signal['recovery_completed']).lower()} -> `{state}`"
            )
        lines.extend(
            [
                "",
                "Behavior assertions:",
                *bullets(scenario["behavior_assertions"]),
                "",
                "Safety assertions:",
                *bullets(scenario["safety_assertions"]),
                "",
            ]
        )
    return "\n".join(lines).rstrip("\n") + "\n"


def project(p: dict[str, Any]) -> dict[str, Any]:
    # Projection is a public trust boundary: never rely on callers remembering to
    # run semantic validation before authored values enter Markdown files.
    validate(p)
    digest = hashlib.sha256(canonical_bytes(p)).hexdigest()
    provenance = "\n".join(
        [
            "## Character program provenance",
            "",
            "- Contract: `org.greenroom.character-program/0.1`",
            f"- Program ID: `{p['program_id']}`",
            f"- Character program SHA-256: `{digest}`",
            f"- Immutable safety: `{p['immutable_safety_ref']}`",
            "",
        ]
    )
    return {
        "projection_version": "0.1",
        "persona_builder_patch": {
            "/behavior/directness": p["interaction"]["directness"],
            "/behavior/warmth": p["interaction"]["warmth"],
            "/behavior/humor": p["interaction"]["humor"],
            "/behavior/disagreement": p["interaction"]["dissent"],
        },
        "persona_files": {
            "AGENTS.md": render_agents(p),
            "VOICE.md": render_voice(p),
            "RELATIONSHIPS.md": render_relationships(p),
            "SCENARIOS.md": render_scenarios(p),
            "PROVENANCE.md": provenance,
        },
        "unchanged_files": ["BACKGROUND.md", "SOURCES.md", "LICENSE"],
        "persona_pack_schema_version": "0.1",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="replace the golden projection")
    args = parser.parse_args()

    # Parsing the schema catches malformed committed JSON even though this oracle
    # performs the cross-field semantic checks JSON Schema cannot express.
    json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    program = json.loads(PROGRAM_PATH.read_text(encoding="utf-8"))
    validate(program)
    verify_state_machine(program)
    actual = project(program)
    verify_projection_and_migration(program, actual)
    encoded = json.dumps(actual, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.write:
        EXPECTED_PATH.write_text(encoded, encoding="utf-8", newline="\n")
        print(f"wrote {EXPECTED_PATH.relative_to(ROOT)}")
        return 0
    expected = EXPECTED_PATH.read_text(encoding="utf-8")
    if encoded != expected:
        raise SystemExit("golden projection mismatch; inspect changes and use --write deliberately")
    print("programmable-character contract and golden projection: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
