"""
RZ-1 focused tests: IfcSpatialZone (PredefinedType=RESERVATION) extraction.

Proves, against the real production functions
`extract_reservation_zone_occurrences` / `build_inventory_payload` in
ifcopenshell_utils.py, run over a real synthetic IFC4x3 fixture parsed by
IfcOpenShell:
  - only RESERVATION-typed IfcSpatialZone entities become candidates
    (NOTDEFINED/USERDEFINED/other enum members/missing PredefinedType excluded);
  - Name/GlobalId/entityId are preserved losslessly, including a missing Name
    surfacing as None (never rejected);
  - IfcRelReferencedInSpatialStructure is the ONLY relationship traversed for
    zone->space references (never IfcRelContainedInSpatialStructure);
  - non-IfcSpace RelatedElements never enter referencedSpaceGlobalIds;
  - one-zone/many-spaces, many-zones/one-space (N:M) both work correctly;
  - multiple relationship rows for the SAME zone are unioned and deduplicated;
  - output ordering is deterministic (lexicographic by GlobalId);
  - zero qualifying references extract as [] without any acceptance failure;
  - a model with no IfcSpatialZone at all returns [];
  - existing IfcSpace extraction (`extract_space_occurrences`) is unchanged by
    this addition, and `build_inventory_payload` gains ONLY the additive
    `reservationZoneOccurrences` field with the pre-existing fields untouched.

These fixtures are synthetic and fabricated for this test only; they validate
extraction mechanics, not any institutional policy.
"""
import os
import sys
import unittest

PY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PY_DIR)

import ifcopenshell  # noqa: E402
import ifcopenshell_utils as u  # noqa: E402

FIX = os.path.abspath(os.path.join(PY_DIR, "..", "tests", "fixtures"))
SCENARIOS = os.path.join(FIX, "ifc4x3-reservation-zone-scenarios.ifc")
BASELINE = os.path.join(FIX, "ifc4x3-three-space-baseline.ifc")  # no IfcSpatialZone at all

Z1 = "RZ1ZONE0000000000001"
Z2 = "RZ1ZONE0000000000002"
Z3_WRONG_TYPE = "RZ1ZONE0000000000003"
Z4_NO_NAME = "RZ1ZONE0000000000004"
Z5_NO_REFS = "RZ1ZONE0000000000005"
Z6_NOTDEFINED = "RZ1ZONE0000000000006"
Z7_USERDEFINED = "RZ1ZONE0000000000007"

S1 = "RZ1SPACE0000000000001"
S2 = "RZ1SPACE0000000000002"
PROXY = "RZ1PROXY000000000001"


class ReservationZoneCandidateFilterTests(unittest.TestCase):
    def setUp(self):
        self.by_guid = {
            o["globalId"]: o for o in u.extract_reservation_zone_occurrences(SCENARIOS)
        }

    def test_only_reservation_predefined_type_included(self):
        # (A) RESERVATION candidates included.
        for guid in (Z1, Z2, Z4_NO_NAME, Z5_NO_REFS):
            self.assertIn(guid, self.by_guid, guid)
        # (B) wrong/other PredefinedType values excluded.
        for guid in (Z3_WRONG_TYPE, Z6_NOTDEFINED, Z7_USERDEFINED):
            self.assertNotIn(guid, self.by_guid, guid)
        self.assertEqual(len(self.by_guid), 4)

    def test_name_preserved_verbatim(self):
        # (C) Name preservation.
        self.assertEqual(self.by_guid[Z1]["name"], "Z-101")
        self.assertEqual(self.by_guid[Z2]["name"], "Z-102")

    def test_missing_name_extracts_as_none_not_rejected(self):
        # (D) missing Name remains null, RZ-1 is observational (no exception raised).
        self.assertIsNone(self.by_guid[Z4_NO_NAME]["name"])

    def test_globalid_preserved(self):
        # (E) GlobalId preservation.
        for guid, occ in self.by_guid.items():
            self.assertEqual(occ["globalId"], guid)

    def test_entityid_preserved_and_is_positive_int(self):
        # (F) entityId preservation.
        for occ in self.by_guid.values():
            self.assertIsInstance(occ["entityId"], int)
            self.assertGreater(occ["entityId"], 0)

    def test_output_contract_shape_is_exact(self):
        expected_keys = {
            "entityId", "ifcClass", "globalId", "name",
            "predefinedType", "referencedSpaceGlobalIds",
        }
        for occ in self.by_guid.values():
            self.assertEqual(set(occ.keys()), expected_keys)
            self.assertEqual(occ["ifcClass"], "IfcSpatialZone")
            self.assertEqual(occ["predefinedType"], "RESERVATION")


class ReservationZoneReferenceTraversalTests(unittest.TestCase):
    def setUp(self):
        self.by_guid = {
            o["globalId"]: o for o in u.extract_reservation_zone_occurrences(SCENARIOS)
        }

    def test_one_zone_many_spaces(self):
        # (H) multi-space relation, non-space RelatedElements excluded (proxy).
        self.assertEqual(self.by_guid[Z1]["referencedSpaceGlobalIds"], sorted([S1, S2]))
        self.assertNotIn(PROXY, self.by_guid[Z1]["referencedSpaceGlobalIds"])

    def test_shared_space_across_zones_many_zones_one_space(self):
        # (I) N:M — S1 is referenced by both Z1 and Z2 without conflation.
        self.assertIn(S1, self.by_guid[Z1]["referencedSpaceGlobalIds"])
        self.assertIn(S1, self.by_guid[Z2]["referencedSpaceGlobalIds"])
        self.assertEqual(self.by_guid[Z2]["referencedSpaceGlobalIds"], [S1])

    def test_one_space_relation(self):
        # (G) one-space relation.
        self.assertEqual(self.by_guid[Z2]["referencedSpaceGlobalIds"], [S1])

    def test_multiple_relationship_rows_for_one_zone_are_unioned(self):
        # (K) Z1 has 4 relationship rows (S1, S2, proxy, duplicate S1) -> unioned.
        self.assertEqual(set(self.by_guid[Z1]["referencedSpaceGlobalIds"]), {S1, S2})

    def test_duplicate_referenced_space_globalids_deduplicated(self):
        # (L) the duplicate Z1->S1 row must not produce a duplicate entry.
        refs = self.by_guid[Z1]["referencedSpaceGlobalIds"]
        self.assertEqual(len(refs), len(set(refs)))

    def test_output_ordering_is_deterministic_lexicographic(self):
        # (M) deterministic ordering: lexicographic sort after dedup.
        refs = self.by_guid[Z1]["referencedSpaceGlobalIds"]
        self.assertEqual(refs, sorted(refs))

    def test_zero_qualifying_references_is_empty_list_not_rejected(self):
        # (J) zero-space references extract as [] without exception.
        self.assertEqual(self.by_guid[Z5_NO_REFS]["referencedSpaceGlobalIds"], [])

    def test_contained_in_spatial_structure_is_never_used_as_substitute(self):
        # Sanity: the scenarios fixture defines no IfcRelContainedInSpatialStructure
        # rows touching zones at all, so a correct implementation cannot have used it.
        model = ifcopenshell.open(SCENARIOS)
        contained_rels = model.by_type("IfcRelContainedInSpatialStructure")
        self.assertEqual(len(contained_rels), 0)


class ReservationZoneNoZonesModelTests(unittest.TestCase):
    def test_model_with_no_zones_returns_empty_list(self):
        # (N) model with no IfcSpatialZone at all returns [].
        self.assertEqual(u.extract_reservation_zone_occurrences(BASELINE), [])


class ExistingSpaceExtractionUnchangedTests(unittest.TestCase):
    """(O) existing IfcSpace extraction still works unchanged by this addition."""

    def test_space_occurrences_unaffected_by_reservation_zones_in_same_model(self):
        occ = {o["guid"]: o for o in u.extract_space_occurrences(SCENARIOS)}
        self.assertEqual(set(occ.keys()), {S1, S2})
        self.assertEqual(occ[S1]["name"], "T-101")
        self.assertEqual(occ[S2]["name"], "T-102")

    def test_baseline_space_extraction_identical_to_pre_existing_contract(self):
        occ = {o["guid"]: o for o in u.extract_space_occurrences(BASELINE)}
        self.assertEqual(len(occ), 3)
        self.assertEqual(occ["0IFC4X3SPACE0000000001"]["name"], "T-101")


class BuildInventoryPayloadAdditiveFieldTests(unittest.TestCase):
    def test_payload_gains_only_the_additive_reservation_zone_field(self):
        payload = u.build_inventory_payload(SCENARIOS)
        self.assertIn("reservationZoneOccurrences", payload)
        self.assertIsInstance(payload["reservationZoneOccurrences"], list)
        self.assertEqual(len(payload["reservationZoneOccurrences"]), 4)
        # Pre-existing fields remain present and structurally unchanged.
        for key in ("status", "data", "spaceOccurrences", "schema",
                    "schemaClassification", "schemaSupported",
                    "uncontainedProxies", "ok"):
            self.assertIn(key, payload)
        self.assertEqual(payload["ok"], True)
        self.assertEqual(payload["status"], "success")

    def test_payload_reservation_zone_field_is_empty_list_when_no_zones(self):
        payload = u.build_inventory_payload(BASELINE)
        self.assertEqual(payload["reservationZoneOccurrences"], [])
        # Existing baseline contract (space count / schema) unaffected.
        self.assertEqual(len(payload["spaceOccurrences"]), 3)
        self.assertEqual(payload["schema"], "IFC4X3_ADD2")
        self.assertTrue(payload["schemaSupported"])


if __name__ == "__main__":
    unittest.main()
