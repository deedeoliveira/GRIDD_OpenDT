"""
Bugfix regression: RZ-1 ReservationZone extraction in the ordinary/Flask
extraction path (`ifcopenshell_utils.build_inventory_payload`) must not crash
on IFC schemas that lack the `IfcSpatialZone` entity (e.g. IFC2X3).

Before this fix, `build_inventory_payload()` called
`extract_reservation_zone_occurrences(file_path)` unconditionally, which
performs `model.by_type("IfcSpatialZone")`. That entity does not exist in the
IFC2X3 schema, so IfcOpenShell raised a RuntimeError
("Entity with name 'IfcSpatialZone' not found in schema 'IFC2X3'") BEFORE the
existing unsupported-schema gate downstream could run.

RZ-2A0 already fixed the identical problem in the controlled-intake CLI path
(`ifc_extract.py`) by gating the call on `is_supported_ifc4x3_schema(...)`.
This test proves the ordinary path now uses the same technique: it invokes
the REAL production function against the REAL IFC2X3 fixture already used by
the TypeScript schema-gate tests — no mocking of IfcOpenShell.
"""
import os
import sys
import unittest

PY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PY_DIR)

import ifcopenshell_utils as u  # noqa: E402

FIX = os.path.abspath(os.path.join(PY_DIR, "..", "tests", "fixtures"))
IFC2X3_UNSUPPORTED = os.path.join(FIX, "ifc2x3-single-space-unsupported.ifc")
IFC4X3_SCENARIOS = os.path.join(FIX, "ifc4x3-reservation-zone-scenarios.ifc")


class OrdinaryPathUnsupportedIfc2x3DoesNotCrashTests(unittest.TestCase):
    def test_build_inventory_payload_does_not_raise_on_ifc2x3(self):
        # Prior to the fix this raised RuntimeError from IfcOpenShell.
        payload = u.build_inventory_payload(IFC2X3_UNSUPPORTED)
        self.assertIsInstance(payload, dict)

    def test_schema_identified_as_unsupported_ifc2x3(self):
        payload = u.build_inventory_payload(IFC2X3_UNSUPPORTED)
        self.assertEqual(payload["schema"], "IFC2X3")
        self.assertEqual(payload["schemaClassification"], "unsupported_ifc2x3")
        self.assertFalse(payload["schemaSupported"])

    def test_reservation_zone_occurrences_present_and_empty_not_missing(self):
        payload = u.build_inventory_payload(IFC2X3_UNSUPPORTED)
        self.assertIn("reservationZoneOccurrences", payload)
        self.assertEqual(payload["reservationZoneOccurrences"], [])

    def test_pre_existing_top_level_fields_all_present(self):
        payload = u.build_inventory_payload(IFC2X3_UNSUPPORTED)
        for key in (
            "status", "data", "spaceOccurrences", "schema",
            "schemaClassification", "schemaSupported", "uncontainedProxies",
            "reservationZoneOccurrences", "ok",
        ):
            self.assertIn(key, payload)
        self.assertEqual(payload["status"], "success")
        self.assertTrue(payload["ok"])


class SupportedIfc4x3RegressionUnchangedTests(unittest.TestCase):
    """
    Confirms the fix does not alter behavior for the already-supported IFC4x3
    family: same 4 ReservationZone occurrences, same GlobalIds/Names/refs,
    same deterministic ordering as established by the RZ-1/RZ-2A0 tests.
    """

    def test_supported_schema_reservation_zone_extraction_unchanged(self):
        payload = u.build_inventory_payload(IFC4X3_SCENARIOS)
        self.assertTrue(payload["schemaSupported"])
        occ = payload["reservationZoneOccurrences"]
        self.assertEqual(len(occ), 4)
        # Cross-check against calling the extractor directly (bypasses the
        # new gate's supported branch identically) to prove byte/semantic
        # equivalence of the supported-path output.
        direct = u.extract_reservation_zone_occurrences(IFC4X3_SCENARIOS)
        self.assertEqual(occ, direct)
        expected_guids = {
            "RZ1ZONE0000000000001",
            "RZ1ZONE0000000000002",
            "RZ1ZONE0000000000004",
            "RZ1ZONE0000000000005",
        }
        self.assertEqual({o["globalId"] for o in occ}, expected_guids)


if __name__ == "__main__":
    unittest.main()
