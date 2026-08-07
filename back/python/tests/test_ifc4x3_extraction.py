"""
Focused tests for the IFC4x3 space extractor and schema gate (ADR-0052).

Proves, against real geometry-free IFC4x3 fixtures parsed by IfcOpenShell:
  - the IFC4x3-only schema rule accepts the IFC4x3 family and rejects IFC2X3/IFC4;
  - IfcSpace.Name is extracted verbatim (the institutional inventory code source);
  - IfcSpace.LongName is extracted verbatim (the informational label source);
  - a Pset_SpaceCommon.Reference property, when present, is carried in the raw
    psets but is NEVER interpreted by the extractor as Name or inventory code
    (the extractor stays dumb; the Node layer ignores Reference entirely).
"""
import os
import sys
import unittest

PY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PY_DIR)

import ifcopenshell_utils as u  # noqa: E402

FIX = os.path.abspath(os.path.join(PY_DIR, "..", "tests", "fixtures"))
BASELINE = os.path.join(FIX, "ifc4x3-three-space-baseline.ifc")
NAME_CHANGED = os.path.join(FIX, "ifc4x3-name-changed-v2.ifc")
LONGNAME_CHANGED = os.path.join(FIX, "ifc4x3-longname-changed-v2.ifc")
REFERENCE_IGNORED = os.path.join(FIX, "ifc4x3-reference-present-ignored.ifc")


class SchemaGateTests(unittest.TestCase):
    def test_ifc4x3_family_supported(self):
        for ident in ("IFC4X3", "IFC4X3_ADD1", "IFC4X3_ADD2", "IFC4X3_TC1", "ifc4x3_add2"):
            self.assertEqual(u.classify_ifc_schema(ident), "supported", ident)
            self.assertTrue(u.is_supported_ifc4x3_schema(ident), ident)

    def test_ifc4_and_ifc2x3_rejected_explicitly(self):
        self.assertEqual(u.classify_ifc_schema("IFC4"), "unsupported_ifc4")
        self.assertEqual(u.classify_ifc_schema("IFC4_ADD2"), "unsupported_ifc4")
        self.assertEqual(u.classify_ifc_schema("IFC2X3"), "unsupported_ifc2x3")
        self.assertEqual(u.classify_ifc_schema("SOMETHING"), "unsupported_other")
        self.assertEqual(u.classify_ifc_schema(None), "unknown")
        for ident in ("IFC4", "IFC4_ADD2", "IFC2X3", None):
            self.assertFalse(u.is_supported_ifc4x3_schema(ident), ident)

    def test_precise_allowlist_rejects_invented_ifc4x3_variants(self):
        # A loose startswith("IFC4X3") would wrongly accept these; the allowlist rejects
        # them and never mislabels them as IFC4.
        for bad in ("IFC4X3_FAKE", "IFC4X3_ATTACK", "IFC4X3_ADD3", "IFC4X3X", "IFC4X3_RCX"):
            self.assertEqual(u.classify_ifc_schema(bad), "unsupported_other", bad)
            self.assertFalse(u.is_supported_ifc4x3_schema(bad), bad)
        # Pre-release RC forms are NOT accepted: IfcOpenShell 0.8 raises SchemaError on them,
        # so they must fail closed exactly like any other unsupported IFC4X3_* variant.
        for rc in ("IFC4X3_RC1", "IFC4X3_RC4"):
            self.assertEqual(u.classify_ifc_schema(rc), "unsupported_other", rc)
            self.assertFalse(u.is_supported_ifc4x3_schema(rc), rc)

    def test_baseline_schema_supported_flag(self):
        ctx = u.extract_model_context(BASELINE)
        self.assertEqual(ctx["schema"], "IFC4X3_ADD2")
        self.assertEqual(ctx["schemaClassification"], "supported")
        self.assertTrue(ctx["schemaSupported"])


class NameLongNameExtractionTests(unittest.TestCase):
    def test_name_is_inventory_code_and_longname_is_label(self):
        occ = {o["guid"]: o for o in u.extract_space_occurrences(BASELINE)}
        self.assertEqual(len(occ), 3)
        self.assertEqual(occ["0IFC4X3SPACE0000000001"]["name"], "T-101")
        self.assertEqual(occ["0IFC4X3SPACE0000000001"]["longName"], "Stage0B Test Space 101")
        self.assertEqual(occ["0IFC4X3SPACE0000000002"]["name"], "T-102")
        self.assertEqual(occ["0IFC4X3SPACE0000000003"]["name"], "T-103")

    def test_name_change_only_variant(self):
        base = {o["guid"]: o for o in u.extract_space_occurrences(BASELINE)}
        v2 = {o["guid"]: o for o in u.extract_space_occurrences(NAME_CHANGED)}
        self.assertEqual(set(base), set(v2), "GlobalIds unchanged")
        self.assertEqual(v2["0IFC4X3SPACE0000000002"]["name"], "T-102-NEW")
        self.assertEqual(v2["0IFC4X3SPACE0000000002"]["longName"],
                         base["0IFC4X3SPACE0000000002"]["longName"], "LongName unchanged")
        for g in ("0IFC4X3SPACE0000000001", "0IFC4X3SPACE0000000003"):
            self.assertEqual(v2[g]["name"], base[g]["name"])

    def test_longname_change_only_variant(self):
        base = {o["guid"]: o for o in u.extract_space_occurrences(BASELINE)}
        v2 = {o["guid"]: o for o in u.extract_space_occurrences(LONGNAME_CHANGED)}
        self.assertEqual(v2["0IFC4X3SPACE0000000002"]["name"],
                         base["0IFC4X3SPACE0000000002"]["name"], "Name unchanged")
        self.assertEqual(v2["0IFC4X3SPACE0000000002"]["longName"], "Stage0B Renamed Laboratory 102")


class ReferenceIgnoredTests(unittest.TestCase):
    def test_reference_present_but_never_becomes_name(self):
        occ = {o["guid"]: o for o in u.extract_space_occurrences(REFERENCE_IGNORED)}
        space2 = occ["0IFC4X3SPACE0000000002"]
        # Name stays the authoritative inventory code, NOT the Reference value.
        self.assertEqual(space2["name"], "T-102")
        self.assertNotEqual(space2["name"], "R-999-CONFLICT")
        # The Reference is present only in the raw, uninterpreted psets.
        ref = space2["psets"].get("Pset_SpaceCommon", {}).get("Reference")
        self.assertEqual(ref, "R-999-CONFLICT")


class LegacySensorRouteGateTests(unittest.TestCase):
    """The active legacy sensor route (process_ifc_file) must apply the SAME IFC4x3 gate."""

    def _run_on(self, fixture):
        import shutil
        import tempfile
        cwd = os.getcwd()
        tmp = tempfile.mkdtemp()
        try:
            shutil.copy(fixture, os.path.join(tmp, "source_model.ifc"))
            os.chdir(tmp)
            return u.process_ifc_file()
        finally:
            os.chdir(cwd)
            shutil.rmtree(tmp, ignore_errors=True)

    def test_ifc4_file_rejected_by_legacy_route(self):
        with self.assertRaises(u.UnsupportedIfcSchemaError):
            self._run_on(os.path.join(FIX, "ifc4-single-space-unsupported.ifc"))

    def test_ifc2x3_file_rejected_by_legacy_route(self):
        with self.assertRaises(u.UnsupportedIfcSchemaError):
            self._run_on(os.path.join(FIX, "ifc2x3-single-space-unsupported.ifc"))

    def test_ifc4x3_file_passes_the_gate(self):
        # The IFC4x3 baseline has no sensors; the gate accepts it and it returns an
        # (empty) sensor map rather than raising an unsupported-schema error.
        self.assertEqual(self._run_on(BASELINE), {})


if __name__ == "__main__":
    unittest.main()
