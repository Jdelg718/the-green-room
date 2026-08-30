"""Slice 1 package and fail-closed configuration tests."""

from __future__ import annotations

import random
import unittest

from greenroom_live.config import ConfigError, LiveBuzzConfig

PUBLIC_PLACEHOLDER = {
    "GREENROOM_RELAY_URL": "wss://relay.invalid",
    "GREENROOM_ROOM_ID": "00000000-0000-4000-8000-000000000000",
    "GREENROOM_DIRECTOR_PUBLIC_KEY": "0" * 64,
}


class PackageSmokeTests(unittest.TestCase):
    def test_package_imports(self) -> None:
        import greenroom_live

        self.assertEqual(greenroom_live.__version__, "0.1.0")


class ConfigTests(unittest.TestCase):
    def test_public_safe_placeholder_config_loads(self) -> None:
        config = LiveBuzzConfig.from_mapping(PUBLIC_PLACEHOLDER)

        self.assertEqual(config.relay_url, "wss://relay.invalid")
        self.assertEqual(
            str(config.room_id), "00000000-0000-4000-8000-000000000000"
        )
        self.assertEqual(config.director_public_key, "0" * 64)

    def test_missing_required_value_fails_closed(self) -> None:
        values = dict(PUBLIC_PLACEHOLDER)
        del values["GREENROOM_ROOM_ID"]

        with self.assertRaisesRegex(ConfigError, "GREENROOM_ROOM_ID"):
            LiveBuzzConfig.from_mapping(values)

    def test_unknown_prefixed_setting_fails_closed(self) -> None:
        values = dict(PUBLIC_PLACEHOLDER)
        values["GREENROOM_PRIVATE_KEY"] = "not-a-real-key"

        with self.assertRaisesRegex(ConfigError, "GREENROOM_PRIVATE_KEY"):
            LiveBuzzConfig.from_mapping(values)

    def test_unsafe_relay_components_fail_closed(self) -> None:
        unsafe_urls = (
            "ws://relay.invalid",
            "https://relay.invalid",
            "wss://user@relay.invalid",
            "wss://user:password@relay.invalid",
            "wss://relay.invalid?token=value",
            "wss://relay.invalid#fragment",
        )

        for relay_url in unsafe_urls:
            with self.subTest(relay_url=relay_url):
                values = dict(PUBLIC_PLACEHOLDER)
                values["GREENROOM_RELAY_URL"] = relay_url

                with self.assertRaises(ConfigError):
                    LiveBuzzConfig.from_mapping(values)

    def test_malformed_relay_authorities_fail_closed(self) -> None:
        malformed_urls = (
            "wss://relay .invalid",
            "wss://Relay.invalid",
            "wss://-relay.invalid",
            "wss://relay..invalid",
            "wss://relay.invalid:abc",
            "wss://relay.invalid:99999",
            "wss://relay.invalid:0",
        )

        for relay_url in malformed_urls:
            with self.subTest(relay_url=relay_url):
                values = dict(PUBLIC_PLACEHOLDER)
                values["GREENROOM_RELAY_URL"] = relay_url

                with self.assertRaisesRegex(ConfigError, "GREENROOM_RELAY_URL"):
                    LiveBuzzConfig.from_mapping(values)

    def test_relay_url_raw_input_must_be_a_nonempty_string(self) -> None:
        for relay_url in (None, b"wss://relay.invalid", 1, ""):
            with self.subTest(relay_url=relay_url):
                values = dict(PUBLIC_PLACEHOLDER)
                values["GREENROOM_RELAY_URL"] = relay_url  # type: ignore[assignment]

                with self.assertRaisesRegex(ConfigError, "GREENROOM_RELAY_URL"):
                    LiveBuzzConfig.from_mapping(values)

    def test_relay_url_raw_input_must_be_canonical_before_parsing(self) -> None:
        noncanonical_urls = (
            "\twss://relay.invalid",
            "\nwss://relay.invalid",
            "\rwss://relay.invalid",
            "wss://relay.in\tvalid",
            "wss://relay.in\nvalid",
            "wss://relay.in\rvalid",
            "\x01wss://relay.invalid",
            "wss://relay.invalid/\x01",
            "wss://relay.invalid/\x7f",
            "wss://relay.invalid/café",
            "WSS://relay.invalid",
            "WsS://relay.invalid",
            "wss://relay.invalid?",
            "wss://relay.invalid#",
            "wss://relay.invalid?#",
            "wss://[::1]",
        )

        for relay_url in noncanonical_urls:
            with self.subTest(relay_url=repr(relay_url)):
                values = dict(PUBLIC_PLACEHOLDER)
                values["GREENROOM_RELAY_URL"] = relay_url

                with self.assertRaisesRegex(ConfigError, "GREENROOM_RELAY_URL"):
                    LiveBuzzConfig.from_mapping(values)

    def test_idna_alabel_hostname_fails_closed(self) -> None:
        for relay_url in (
            "wss://xn--caf-dma.example",
            "wss://relay.xn--caf-dma.example",
        ):
            with self.subTest(relay_url=relay_url):
                values = dict(PUBLIC_PLACEHOLDER)
                values["GREENROOM_RELAY_URL"] = relay_url

                with self.assertRaisesRegex(ConfigError, "GREENROOM_RELAY_URL"):
                    LiveBuzzConfig.from_mapping(values)

    def test_reserved_idna_prefix_fails_closed_for_malformed_alabels(self) -> None:
        malformed_alabel_urls = (
            "wss://xn--a.example",
            "wss://xn--not-an-alabel.example",
            "wss://relay.xn--a.example",
        )

        for relay_url in malformed_alabel_urls:
            with self.subTest(relay_url=relay_url):
                values = dict(PUBLIC_PLACEHOLDER)
                values["GREENROOM_RELAY_URL"] = relay_url

                with self.assertRaisesRegex(ConfigError, "GREENROOM_RELAY_URL"):
                    LiveBuzzConfig.from_mapping(values)

    def test_non_idna_hyphenated_hostnames_load(self) -> None:
        for relay_url in (
            "wss://relay-edge.example",
            "wss://relay-xn--edge.example",
        ):
            with self.subTest(relay_url=relay_url):
                values = dict(PUBLIC_PLACEHOLDER)
                values["GREENROOM_RELAY_URL"] = relay_url

                config = LiveBuzzConfig.from_mapping(values)

                self.assertEqual(config.relay_url, relay_url)

    def test_optional_relay_port_boundaries_load(self) -> None:
        for port in (1, 65535):
            with self.subTest(port=port):
                values = dict(PUBLIC_PLACEHOLDER)
                values["GREENROOM_RELAY_URL"] = f"wss://relay.invalid:{port}"

                config = LiveBuzzConfig.from_mapping(values)

                self.assertEqual(config.relay_url, f"wss://relay.invalid:{port}")

    def test_endpoint_identity_rejects_paths_and_default_port(self) -> None:
        noncanonical_urls = (
            "wss://relay.invalid/",
            "wss://relay.invalid/path",
            "wss://relay.invalid/.",
            "wss://relay.invalid/%2e",
            "wss://relay.invalid//",
            "wss://relay.invalid:443",
        )

        for relay_url in noncanonical_urls:
            with self.subTest(relay_url=relay_url):
                values = dict(PUBLIC_PLACEHOLDER)
                values["GREENROOM_RELAY_URL"] = relay_url

                with self.assertRaisesRegex(ConfigError, "GREENROOM_RELAY_URL"):
                    LiveBuzzConfig.from_mapping(values)

    def test_endpoint_identity_retains_non_default_port(self) -> None:
        values = dict(PUBLIC_PLACEHOLDER)
        values["GREENROOM_RELAY_URL"] = "wss://relay.invalid:8443"

        config = LiveBuzzConfig.from_mapping(values)

        self.assertEqual(config.relay_url, "wss://relay.invalid:8443")

    def test_noncanonical_public_key_fails_closed(self) -> None:
        values = dict(PUBLIC_PLACEHOLDER)
        values["GREENROOM_DIRECTOR_PUBLIC_KEY"] = "A" * 64

        with self.assertRaisesRegex(ConfigError, "lowercase"):
            LiveBuzzConfig.from_mapping(values)

    def test_non_mapping_input_fails_with_config_error(self) -> None:
        for values in (None, 1, [], "not a mapping"):
            with self.subTest(values=repr(values)), self.assertRaisesRegex(
                ConfigError, "mapping"
            ):
                LiveBuzzConfig.from_mapping(values)  # type: ignore[arg-type]

    def test_mapping_keys_must_be_strings(self) -> None:
        for malformed_key in (None, 1, ("tuple",)):
            with self.subTest(malformed_key=repr(malformed_key)):
                values = dict(PUBLIC_PLACEHOLDER)
                values[malformed_key] = "ignored"  # type: ignore[index]

                with self.assertRaisesRegex(ConfigError, "keys must be strings"):
                    LiveBuzzConfig.from_mapping(values)  # type: ignore[arg-type]

    def test_all_mapping_values_must_be_strings(self) -> None:
        for key in (*PUBLIC_PLACEHOLDER, "UNRELATED"):
            for malformed_value in (None, 1, [], {}):
                with self.subTest(key=key, malformed_value=repr(malformed_value)):
                    values = dict(PUBLIC_PLACEHOLDER)
                    values[key] = malformed_value  # type: ignore[assignment]

                    with self.assertRaisesRegex(ConfigError, "values must be strings"):
                        LiveBuzzConfig.from_mapping(values)

    def test_unknown_setting_diagnostic_is_escaped_and_bounded(self) -> None:
        values = dict(PUBLIC_PLACEHOLDER)
        values.update(
            {
                f"GREENROOM_{index:05d}_\n\t_é_" + ("x" * 500): "value"
                for index in range(10_000)
            }
        )

        with self.assertRaises(ConfigError) as first:
            LiveBuzzConfig.from_mapping(values)
        with self.assertRaises(ConfigError) as second:
            LiveBuzzConfig.from_mapping(dict(reversed(tuple(values.items()))))

        message = str(first.exception)
        self.assertEqual(message, str(second.exception))
        self.assertLessEqual(len(message), 512)
        self.assertTrue(message.isascii())
        self.assertNotIn("\n", message)
        self.assertNotIn("\t", message)
        self.assertIn("10000 unknown Green Room settings", message)
        self.assertIn("9995 more", message)

    def test_room_id_requires_canonical_lowercase_hyphenated_text(self) -> None:
        noncanonical_ids = (
            "00000000-0000-4000-8000-00000000000A",
            "{00000000-0000-4000-8000-000000000000}",
            "00000000000040008000000000000000",
        )

        for room_id in noncanonical_ids:
            with self.subTest(room_id=room_id):
                values = dict(PUBLIC_PLACEHOLDER)
                values["GREENROOM_ROOM_ID"] = room_id

                with self.assertRaisesRegex(ConfigError, "GREENROOM_ROOM_ID"):
                    LiveBuzzConfig.from_mapping(values)

    def test_deterministic_malformed_mapping_fuzz_fails_bounded(self) -> None:
        rng = random.Random(0xB022)
        malformed_values = (None, 1, [], {})
        required_keys = tuple(PUBLIC_PLACEHOLDER)

        for iteration in range(500):
            values = dict(PUBLIC_PLACEHOLDER)
            if rng.randrange(2):
                values[rng.choice(required_keys)] = rng.choice(  # type: ignore[assignment]
                    malformed_values
                )
            else:
                values[  # type: ignore[index]
                    rng.choice((None, rng.randrange(10_000), (iteration,)))
                ] = "value"

            with self.subTest(iteration=iteration):
                with self.assertRaises(ConfigError) as raised:
                    LiveBuzzConfig.from_mapping(values)  # type: ignore[arg-type]
                self.assertLessEqual(len(str(raised.exception)), 512)

    def test_room_id_rejects_raw_surrounding_whitespace(self) -> None:
        canonical = PUBLIC_PLACEHOLDER["GREENROOM_ROOM_ID"]
        for whitespace in (" ", "\t", "\n", "\u00a0", "\u2003"):
            for room_id in (whitespace + canonical, canonical + whitespace):
                with self.subTest(room_id=repr(room_id)):
                    values = dict(PUBLIC_PLACEHOLDER)
                    values["GREENROOM_ROOM_ID"] = room_id

                    with self.assertRaisesRegex(ConfigError, "GREENROOM_ROOM_ID"):
                        LiveBuzzConfig.from_mapping(values)

    def test_public_key_rejects_raw_surrounding_whitespace(self) -> None:
        canonical = PUBLIC_PLACEHOLDER["GREENROOM_DIRECTOR_PUBLIC_KEY"]
        for whitespace in (" ", "\t", "\n", "\u00a0", "\u2003"):
            for public_key in (whitespace + canonical, canonical + whitespace):
                with self.subTest(public_key=repr(public_key)):
                    values = dict(PUBLIC_PLACEHOLDER)
                    values["GREENROOM_DIRECTOR_PUBLIC_KEY"] = public_key

                    with self.assertRaisesRegex(
                        ConfigError, "GREENROOM_DIRECTOR_PUBLIC_KEY"
                    ):
                        LiveBuzzConfig.from_mapping(values)


if __name__ == "__main__":
    unittest.main()
