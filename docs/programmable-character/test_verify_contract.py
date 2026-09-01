"""Adversarial regression tests for character-program authored strings."""

from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("verify_contract", ROOT / "verify_contract.py")
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import invariant
    raise RuntimeError("cannot load programmable-character verifier")
verify_contract = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify_contract)


class AuthoredStringValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.program = json.loads(verify_contract.PROGRAM_PATH.read_text(encoding="utf-8"))
        schema = json.loads(verify_contract.SCHEMA_PATH.read_text(encoding="utf-8"))
        cls.schema_validator = Draft202012Validator(schema)

    def mutated(self, value: str) -> dict:
        program = copy.deepcopy(self.program)
        program["core"]["drive"] = value
        return program

    def assert_semantic_and_projection_reject(self, value: str) -> None:
        program = self.mutated(value)
        with self.assertRaises(ValueError):
            verify_contract.validate(program)
        with self.assertRaises(ValueError):
            verify_contract.project(program)

    def test_schema_rejects_control_and_unicode_noncharacters(self) -> None:
        for value in (
            "safe\u0000hidden",
            "safe\u001fhidden",
            "safe\u007fhidden",
            "safe\u0085hidden",
            "safe\ufdd0hidden",
            "safe\ufffehidden",
        ):
            with self.subTest(value=ascii(value)):
                self.assertTrue(list(self.schema_validator.iter_errors(self.mutated(value))))

    def test_semantics_reject_non_nfc(self) -> None:
        self.assert_semantic_and_projection_reject("Cafe\u0301")

    def test_semantics_and_projection_apply_closed_nested_schema(self) -> None:
        program = copy.deepcopy(self.program)
        program["core"]["undeclared"] = "must fail closed"
        with self.assertRaisesRegex(ValueError, "schema violation"):
            verify_contract.validate(program)
        with self.assertRaisesRegex(ValueError, "schema violation"):
            verify_contract.project(program)

    def test_semantics_reject_controls_and_noncharacters(self) -> None:
        for value in (
            "safe\u0000hidden",
            "safe\u0085hidden",
            "safe\ufdd0hidden",
            "safe\U0001fffehidden",
        ):
            with self.subTest(value=ascii(value)):
                self.assert_semantic_and_projection_reject(value)

    def test_semantics_reject_markdown_and_html_block_markers(self) -> None:
        for value in (
            "# heading",
            "- list item",
            "> quote",
            "```python",
            "***",
            "1. ordered",
            "<script>alert(1)</script>",
            "<!-- comment -->",
        ):
            with self.subTest(value=value):
                self.assert_semantic_and_projection_reject(value)

    def test_golden_program_remains_valid_and_projectable(self) -> None:
        self.assertEqual(list(self.schema_validator.iter_errors(self.program)), [])
        verify_contract.validate(self.program)
        self.assertEqual(verify_contract.project(self.program)["projection_version"], "0.1")


if __name__ == "__main__":
    unittest.main()
