"""
RZ-2A0 focused tests: controlled-intake CLI (`ifc_extract.py`) must emit the
same `reservationZoneOccurrences` evidence as the ordinary Flask extraction
path (`ifcopenshell_utils.build_inventory_payload`), for the SAME real IFC4x3
fixtures parsed by IfcOpenShell.

RZ-2A0 does not create any new extraction logic: it only wires the controlled
CLI to call the existing RZ-1 production helper
`ifcopenshell_utils.extract_reservation_zone_occurrences()`. These tests
invoke the REAL `ifc_extract.py` script as a subprocess (no mocking) and
compare its JSON output against the real Python-side extraction helper.
"""
import json
import os
import subprocess
import sys
import unittest

PY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PY_DIR)

import ifcopenshell_utils as u  # noqa: E402

FIX = os.path.abspath(os.path.join(PY_DIR, "..", "tests", "fixtures"))
SCENARIOS = os.path.join(FIX, "ifc4x3-reservation-zone-scenarios.ifc")
BASELINE = os.path.join(FIX, "ifc4x3-three-space-baseline.ifc")  # no IfcSpatialZone at all

SCRIPT = os.path.join(PY_DIR, "ifc_extract.py")

Z1 = "RZ1ZONE0000000000001"
Z3_WRONG_TYPE = "RZ1ZONE0000000000003"


def _run_cli(ifc_path):
    result = subprocess.run(
        [sys.executable, SCRIPT, "--ifc", ifc_path],
        capture_output=True,
        text=True,
        timeout=60,
    )
    return result


class ControlledCliReservationZoneFieldTests(unittest.TestCase):
    def test_cli_exits_successfully_and_emits_reservation_zone_occurrences(self):
        result = _run_cli(SCENARIOS)
        # (A) process exits successfully.
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout.strip())
        # (B) field present.
        self.assertIn("reservationZoneOccurrences", payload)
        # (C) it is an array.
        self.assertIsInstance(payload["reservationZoneOccurrences"], list)

    def test_cli_reservation_zones_present_and_wrong_type_excluded(self):
        result = _run_cli(SCENARIOS)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout.strip())
        by_guid = {o["globalId"]: o for o in payload["reservationZoneOccurrences"]}
        # (D) RESERVATION zones present.
        self.assertIn(Z1, by_guid)
        # (E) wrong-PredefinedType zones excluded.
        self.assertNotIn(Z3_WRONG_TYPE, by_guid)

    def test_cli_matches_rz1_extractor_directly_for_same_fixture(self):
        result = _run_cli(SCENARIOS)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout.strip())
        # (F) N:M / referenced-space values match the RZ-1 extractor's own result.
        expected = u.extract_reservation_zone_occurrences(SCENARIOS)
        self.assertEqual(payload["reservationZoneOccurrences"], expected)

    def test_cli_zero_zone_fixture_returns_empty_list_not_omitted(self):
        result = _run_cli(BASELINE)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout.strip())
        self.assertIn("reservationZoneOccurrences", payload)
        self.assertEqual(payload["reservationZoneOccurrences"], [])
        # Same fixture on the ordinary extraction path is also [].
        ordinary = u.build_inventory_payload(BASELINE)
        self.assertEqual(ordinary["reservationZoneOccurrences"], [])

    def test_cli_preserves_existing_fields_unchanged(self):
        result = _run_cli(SCENARIOS)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout.strip())
        for key in ("inventoryData", "spaceOccurrences", "uncontainedProxies", "schema"):
            self.assertIn(key, payload)
        self.assertIsInstance(payload["inventoryData"], dict)
        self.assertIsInstance(payload["spaceOccurrences"], list)
        self.assertIsInstance(payload["uncontainedProxies"], list)


class CrossPathReservationZoneEqualityTests(unittest.TestCase):
    """RZ-2A0 key regression invariant: ordinary extraction == controlled extraction."""

    def test_cross_path_occurrence_array_structural_equality(self):
        ordinary = u.build_inventory_payload(SCENARIOS)["reservationZoneOccurrences"]

        result = _run_cli(SCENARIOS)
        self.assertEqual(result.returncode, 0, result.stderr)
        controlled = json.loads(result.stdout.strip())["reservationZoneOccurrences"]

        self.assertEqual(len(ordinary), len(controlled))
        # Exact structural equality, occurrence by occurrence, all fields.
        ordinary_by_guid = {o["globalId"]: o for o in ordinary}
        controlled_by_guid = {o["globalId"]: o for o in controlled}
        self.assertEqual(set(ordinary_by_guid.keys()), set(controlled_by_guid.keys()))
        for guid, occ in ordinary_by_guid.items():
            self.assertEqual(occ, controlled_by_guid[guid], guid)
        # Belt and suspenders: the full arrays (order included) are identical too.
        self.assertEqual(ordinary, controlled)

    def test_cross_path_equality_holds_for_zero_zone_fixture(self):
        ordinary = u.build_inventory_payload(BASELINE)["reservationZoneOccurrences"]
        result = _run_cli(BASELINE)
        self.assertEqual(result.returncode, 0, result.stderr)
        controlled = json.loads(result.stdout.strip())["reservationZoneOccurrences"]
        self.assertEqual(ordinary, [])
        self.assertEqual(controlled, [])
        self.assertEqual(ordinary, controlled)


if __name__ == "__main__":
    unittest.main()
