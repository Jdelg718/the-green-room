from __future__ import annotations

import copy
import datetime as dt
import re
from collections.abc import Mapping
from typing import Any

import yaml
from yaml.constructor import ConstructorError
from yaml.nodes import MappingNode, Node, ScalarNode
from yaml.tokens import (
    AliasToken,
    AnchorToken,
    BlockEndToken,
    BlockMappingStartToken,
    BlockSequenceStartToken,
    DirectiveToken,
    FlowMappingEndToken,
    FlowMappingStartToken,
    FlowSequenceEndToken,
    FlowSequenceStartToken,
    TagToken,
)

from .limits import MAX_YAML_BYTES, MAX_YAML_DEPTH, MAX_YAML_NODES
from .models import DiagnosticCollector

STRING_TAG = "tag:yaml.org,2002:str"
TIMESTAMP_TAG = "tag:yaml.org,2002:timestamp"
SCHEMA_VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
SEMVER_PRERELEASE_IDENTIFIER = r"(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
SEMVER = re.compile(
    r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    rf"(?:-{SEMVER_PRERELEASE_IDENTIFIER}(?:\.{SEMVER_PRERELEASE_IDENTIFIER})*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\Z"
)
PACK_ID = re.compile(r"[a-z0-9]+(?:[.-][a-z0-9]+)+\Z")
LICENSE = re.compile(r"[A-Za-z0-9][A-Za-z0-9.+-]{1,63}\Z")
ASSET_NAME = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}\Z")
ASSET_PATH = re.compile(
    r"assets/[A-Za-z0-9][A-Za-z0-9._-]{0,63}"
    r"(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,63})*\Z"
)

TOP_FIELDS = {
    "schema_version",
    "id",
    "name",
    "version",
    "author",
    "license",
    "summary",
    "identity",
    "behavior",
    "knowledge",
    "boundaries",
    "assets",
}
REQUIRED_TOP_FIELDS = TOP_FIELDS - {"assets"}
IDENTITY_FIELDS = {"type", "age_band", "setting"}
BEHAVIOR_FIELDS = {
    "initiative",
    "interruption",
    "verbosity",
    "agreeableness",
    "emotional_range",
    "max_consecutive_turns",
}
KNOWLEDGE_FIELDS = {"cutoff", "domains", "limitations"}
BOUNDARY_FIELDS = {"external_tools", "impersonates_real_person", "copied_dialogue"}
ASSET_FIELDS = {"path", "source", "creator"}


class _StrictLoader(yaml.SafeLoader):
    pass


class _YamlComplexityError(Exception):
    pass


_StrictLoader.yaml_implicit_resolvers = copy.deepcopy(yaml.SafeLoader.yaml_implicit_resolvers)
for first_character, resolvers in _StrictLoader.yaml_implicit_resolvers.items():
    _StrictLoader.yaml_implicit_resolvers[first_character] = [
        resolver for resolver in resolvers if resolver[0] != TIMESTAMP_TAG
    ]


def _construct_unique_mapping(
    loader: _StrictLoader, node: MappingNode, deep: bool = False
) -> dict[Any, Any]:
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        try:
            duplicate = key in mapping
        except TypeError as exc:
            raise ConstructorError(
                None, None, "unhashable YAML mapping key", key_node.start_mark
            ) from exc
        if duplicate:
            raise ConstructorError(None, None, "duplicate YAML mapping key", key_node.start_mark)
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


_StrictLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    _construct_unique_mapping,
)


def _walk_complexity(node: Node, *, depth: int = 1) -> tuple[int, int]:
    if isinstance(node, MappingNode):
        children = [child for pair in node.value for child in pair]
    elif hasattr(node, "value") and isinstance(node.value, list):
        children = list(node.value)
    else:
        children = []
    nodes = 1
    maximum_depth = depth
    for child in children:
        child_nodes, child_depth = _walk_complexity(child, depth=depth + 1)
        nodes += child_nodes
        maximum_depth = max(maximum_depth, child_depth)
    return nodes, maximum_depth


def _schema_version_node(root: Node) -> ScalarNode | None:
    if not isinstance(root, MappingNode):
        return None
    for key, value in root.value:
        if isinstance(key, ScalarNode) and key.value == "schema_version":
            return value if isinstance(value, ScalarNode) else None
    return None


def _mapping(
    value: object,
    field: str,
    required: set[str],
    allowed: set[str],
    diagnostics: DiagnosticCollector,
) -> Mapping[str, Any] | None:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        diagnostics.error("invalid_field_type", f"{field} must be a string-keyed mapping", field)
        return None
    keys = set(value)
    for missing in sorted(required - keys):
        diagnostics.error("missing_field", f"required field {field}.{missing} is missing", field)
    for unknown in sorted(keys - allowed):
        diagnostics.error("unknown_field", f"unknown field {field}.{unknown}", f"{field}.{unknown}")
    return value


def _string(
    value: object,
    field: str,
    diagnostics: DiagnosticCollector,
    *,
    minimum: int = 1,
    maximum: int = 512,
) -> str | None:
    if not isinstance(value, str) or not minimum <= len(value) <= maximum:
        diagnostics.error(
            "invalid_field_type",
            f"{field} must be a string of {minimum}..{maximum} characters",
            field,
        )
        return None
    if any(ord(character) < 0x20 and character not in "\n\t" for character in value):
        diagnostics.error("invalid_field_type", f"{field} contains control characters", field)
        return None
    return value


def _string_list(
    value: object,
    field: str,
    diagnostics: DiagnosticCollector,
    *,
    maximum_items: int = 16,
    maximum_length: int = 512,
) -> None:
    if not isinstance(value, list) or not 1 <= len(value) <= maximum_items:
        diagnostics.error(
            "invalid_field_type", f"{field} must contain 1..{maximum_items} strings", field
        )
        return
    for index, item in enumerate(value):
        _string(item, f"{field}[{index}]", diagnostics, maximum=maximum_length)


def parse_manifest(raw: bytes, diagnostics: DiagnosticCollector) -> dict[str, Any]:
    if len(raw) > MAX_YAML_BYTES:
        diagnostics.error("yaml_complexity", "persona.yaml exceeds 64 KiB", "persona.yaml")
        return {}
    if raw.startswith(b"\xef\xbb\xbf") or b"\x00" in raw:
        diagnostics.error("invalid_yaml", "persona.yaml contains a BOM or NUL", "persona.yaml")
        return {}
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        diagnostics.error("invalid_yaml", "persona.yaml is not UTF-8", "persona.yaml")
        return {}
    try:
        collection_depth = 0
        for token in yaml.scan(text, Loader=_StrictLoader):
            if isinstance(token, (AliasToken, AnchorToken, DirectiveToken, TagToken)):
                diagnostics.error(
                    "invalid_yaml",
                    "YAML aliases, anchors, directives, and tags are forbidden",
                    "persona.yaml",
                )
                return {}
            if isinstance(
                token,
                (
                    BlockMappingStartToken,
                    BlockSequenceStartToken,
                    FlowMappingStartToken,
                    FlowSequenceStartToken,
                ),
            ):
                collection_depth += 1
                if collection_depth > MAX_YAML_DEPTH:
                    raise _YamlComplexityError
            elif isinstance(token, (BlockEndToken, FlowMappingEndToken, FlowSequenceEndToken)):
                collection_depth -= 1
        root_node = yaml.compose(text, Loader=_StrictLoader)
        if root_node is None:
            diagnostics.error("invalid_yaml", "persona.yaml is empty", "persona.yaml")
            return {}
        node_count, depth = _walk_complexity(root_node)
        if node_count > MAX_YAML_NODES or depth > MAX_YAML_DEPTH:
            diagnostics.error(
                "yaml_complexity", "persona.yaml exceeds node or depth limits", "persona.yaml"
            )
            return {}
        version_node = _schema_version_node(root_node)
        if version_node is not None and version_node.tag != STRING_TAG:
            diagnostics.error(
                "invalid_schema_version_type",
                "schema_version must be a quoted YAML string",
                "schema_version",
            )
        loader = _StrictLoader(text)
        try:
            loaded = loader.get_single_data()
        finally:
            loader.dispose()
    except (_YamlComplexityError, RecursionError):
        diagnostics.error(
            "yaml_complexity", "persona.yaml exceeds node or depth limits", "persona.yaml"
        )
        return {}
    except yaml.YAMLError:
        diagnostics.error("invalid_yaml", "persona.yaml is not valid strict YAML", "persona.yaml")
        return {}

    top = _mapping(loaded, "manifest", REQUIRED_TOP_FIELDS, TOP_FIELDS, diagnostics)
    if top is None:
        return {}
    manifest = dict(top)
    schema_version = manifest.get("schema_version")
    if isinstance(schema_version, str):
        if not SCHEMA_VERSION.fullmatch(schema_version):
            diagnostics.error(
                "invalid_schema_version", "schema_version is not canonical MAJOR.MINOR"
            )
        elif schema_version != "0.1":
            diagnostics.error(
                "unsupported_schema_version",
                "only schema_version 0.1 is loadable",
                "schema_version",
            )
    elif version_node is None or version_node.tag == STRING_TAG:
        diagnostics.error(
            "invalid_schema_version_type",
            "schema_version must be a quoted YAML string",
            "schema_version",
        )

    pack_id = _string(manifest.get("id"), "id", diagnostics, maximum=128)
    if pack_id is not None and not PACK_ID.fullmatch(pack_id):
        diagnostics.error(
            "invalid_pack_id", "id must be a canonical lowercase dotted identifier", "id"
        )
    version = _string(manifest.get("version"), "version", diagnostics, maximum=128)
    if version is not None and not SEMVER.fullmatch(version):
        diagnostics.error("invalid_semver", "version must be strict Semantic Versioning", "version")
    license_id = _string(manifest.get("license"), "license", diagnostics, maximum=64)
    if license_id is not None and not LICENSE.fullmatch(license_id):
        diagnostics.error(
            "invalid_license", "license must be a bounded SPDX-style identifier", "license"
        )
    _string(manifest.get("name"), "name", diagnostics, maximum=128)
    _string(manifest.get("author"), "author", diagnostics, maximum=128)
    _string(manifest.get("summary"), "summary", diagnostics, maximum=1_024)

    identity = _mapping(
        manifest.get("identity"), "identity", IDENTITY_FIELDS, IDENTITY_FIELDS, diagnostics
    )
    if identity is not None:
        identity_type = _string(identity.get("type"), "identity.type", diagnostics, maximum=64)
        if identity_type not in {None, "original", "historical", "historical_interpretation"}:
            diagnostics.error("invalid_identity", "unsupported identity.type", "identity.type")
        _string(identity.get("age_band"), "identity.age_band", diagnostics, maximum=64)
        _string(identity.get("setting"), "identity.setting", diagnostics, maximum=512)

    behavior = _mapping(
        manifest.get("behavior"), "behavior", BEHAVIOR_FIELDS, BEHAVIOR_FIELDS, diagnostics
    )
    if behavior is not None:
        for field in BEHAVIOR_FIELDS - {"max_consecutive_turns"}:
            value = behavior.get(field)
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not 0 <= value <= 1
            ):
                diagnostics.error(
                    "behavior_out_of_range",
                    f"behavior.{field} must be a number from 0 to 1",
                    f"behavior.{field}",
                )
        turns = behavior.get("max_consecutive_turns")
        if isinstance(turns, bool) or not isinstance(turns, int) or not 1 <= turns <= 3:
            diagnostics.error(
                "behavior_out_of_range",
                "behavior.max_consecutive_turns must be an integer from 1 to 3",
                "behavior.max_consecutive_turns",
            )

    knowledge = _mapping(
        manifest.get("knowledge"), "knowledge", KNOWLEDGE_FIELDS, KNOWLEDGE_FIELDS, diagnostics
    )
    if knowledge is not None:
        cutoff = _string(knowledge.get("cutoff"), "knowledge.cutoff", diagnostics, maximum=10)
        if cutoff is not None:
            try:
                parsed = dt.date.fromisoformat(cutoff)
            except ValueError:
                parsed = None
            if parsed is None or parsed.isoformat() != cutoff:
                diagnostics.error(
                    "invalid_knowledge_cutoff",
                    "knowledge.cutoff must be a real YYYY-MM-DD date",
                    "knowledge.cutoff",
                )
        _string_list(knowledge.get("domains"), "knowledge.domains", diagnostics, maximum_length=128)
        _string_list(
            knowledge.get("limitations"), "knowledge.limitations", diagnostics, maximum_length=512
        )

    boundaries = _mapping(
        manifest.get("boundaries"), "boundaries", BOUNDARY_FIELDS, BOUNDARY_FIELDS, diagnostics
    )
    if boundaries is not None:
        for field in BOUNDARY_FIELDS:
            if not isinstance(boundaries.get(field), bool):
                diagnostics.error(
                    "invalid_field_type",
                    f"boundaries.{field} must be boolean",
                    f"boundaries.{field}",
                )
        for field in ("external_tools", "copied_dialogue"):
            if boundaries.get(field) is True:
                diagnostics.error(
                    "forbidden_capability",
                    f"boundaries.{field} must be false",
                    f"boundaries.{field}",
                )
        if boundaries.get("impersonates_real_person") is True:
            diagnostics.warning(
                "real_person_impersonation",
                "pack declares real-person impersonation",
                "boundaries.impersonates_real_person",
            )

    assets_value = manifest.get("assets", {})
    assets = _mapping(
        assets_value,
        "assets",
        set(),
        set(assets_value) if isinstance(assets_value, dict) else set(),
        diagnostics,
    )
    seen_paths: set[str] = set()
    if assets is not None:
        if len(assets) > 32:
            diagnostics.error("yaml_complexity", "assets may declare at most 32 entries", "assets")
        for asset_name, descriptor_value in assets.items():
            if not ASSET_NAME.fullmatch(asset_name):
                diagnostics.error(
                    "invalid_asset",
                    "asset keys must be lowercase identifiers",
                    f"assets.{asset_name}",
                )
            descriptor = _mapping(
                descriptor_value,
                f"assets.{asset_name}",
                ASSET_FIELDS,
                ASSET_FIELDS,
                diagnostics,
            )
            if descriptor is None:
                diagnostics.error(
                    "missing_asset_provenance",
                    "asset requires path, source, and creator",
                    f"assets.{asset_name}",
                )
                continue
            if set(descriptor) != ASSET_FIELDS:
                diagnostics.error(
                    "missing_asset_provenance",
                    "asset requires path, source, and creator",
                    f"assets.{asset_name}",
                )
            asset_path = _string(
                descriptor.get("path"), f"assets.{asset_name}.path", diagnostics, maximum=255
            )
            _string(
                descriptor.get("source"), f"assets.{asset_name}.source", diagnostics, maximum=256
            )
            _string(
                descriptor.get("creator"), f"assets.{asset_name}.creator", diagnostics, maximum=128
            )
            if asset_path is not None:
                if not ASSET_PATH.fullmatch(asset_path):
                    diagnostics.error(
                        "invalid_asset", "asset path is not canonical", f"assets.{asset_name}.path"
                    )
                elif asset_path in seen_paths:
                    diagnostics.error(
                        "duplicate_path", "asset declarations repeat a path", asset_path
                    )
                seen_paths.add(asset_path)
    return manifest


def declared_asset_paths(manifest: Mapping[str, Any]) -> set[str]:
    assets = manifest.get("assets")
    if not isinstance(assets, dict):
        return set()
    return {
        descriptor["path"]
        for descriptor in assets.values()
        if isinstance(descriptor, dict) and isinstance(descriptor.get("path"), str)
    }
