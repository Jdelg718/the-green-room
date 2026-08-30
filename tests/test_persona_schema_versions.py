from pathlib import Path
import unittest

import yaml


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
PERSONA_MANIFESTS = tuple(sorted(REPOSITORY_ROOT.glob("personas/**/persona.yaml")))


class PersonaSchemaVersionTests(unittest.TestCase):
    def test_every_persona_manifest_uses_canonical_schema_version_string(self):
        self.assertTrue(PERSONA_MANIFESTS, "no persona manifests found")

        failures = []
        for manifest_path in PERSONA_MANIFESTS:
            manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
            schema_version = manifest.get("schema_version")
            if type(schema_version) is not str or schema_version != "0.1":
                relative_path = manifest_path.relative_to(REPOSITORY_ROOT)
                failures.append(
                    f"{relative_path}: expected exact string '0.1', "
                    f"got {schema_version!r} ({type(schema_version).__name__})"
                )

        self.assertEqual([], failures, "\n" + "\n".join(failures))


if __name__ == "__main__":
    unittest.main()
