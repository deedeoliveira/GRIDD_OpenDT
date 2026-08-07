"""
Real IfcTester execution of the governed IDS 1.1.0 profile (ADR-0052 §A/§G).

Proves, against IFC files that IfcOpenShell actually parses, that IDS-SPACE-NAME:
  - passes a valid IfcSpace.Name inventory code;
  - fails a missing, blank, whitespace-only, or pattern-invalid Name;
  - ignores Pset_SpaceCommon.Reference (Reference present and conflicting still passes);
  - governs EVERY accepted IFC4x3 schema variant (IFC4X3, IFC4X3_ADD1, IFC4X3_ADD2,
    IFC4X3_TC1) under the runtime configuration (version filtering disabled).

It also documents, with a real filtering-enabled control, WHY the runtime pins version
filtering off: the IDS 1.0 schema enumerates only IFC4X3_ADD2, so with filtering ON the
governed spec is skipped for the other three parseable variants. Governance therefore relies
on the entity-based applicability plus the disabled filter, never on the ifcVersion token
covering all four (which the IDS XSD cannot express).
"""
import os
import sys
import tempfile
import unittest

PY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PY_DIR)

import ifcopenshell  # noqa: E402
from ifctester import ids  # noqa: E402

GOVERNED_IDS = os.path.abspath(os.path.join(
    PY_DIR, "..", "..", "semantic", "artifacts", "runtime",
    "oswadt-ifc4-model-requirements", "1.1.0", "oswadt-ifc4-model-requirements-v1.1.ids"))
FIX = os.path.abspath(os.path.join(PY_DIR, "..", "tests", "fixtures"))
REFERENCE_IGNORED = os.path.join(FIX, "ifc4x3-reference-present-ignored.ifc")

ACCEPTED_SCHEMAS = ("IFC4X3", "IFC4X3_ADD1", "IFC4X3_ADD2", "IFC4X3_TC1")

_TEMPLATE = """ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('%(schema)s'));
ENDSEC;
DATA;
#1=IFCSPACE('0SPACEGUID0000000000AA',$,%(name)s,$,$,$,$,$,.ELEMENT.,$,$);
ENDSEC;
END-ISO-10303-21;
"""


def _single_space_model(schema, name_literal):
    text = _TEMPLATE % {"schema": schema, "name": name_literal}
    path = tempfile.mktemp(suffix=".ifc")
    with open(path, "w", encoding="ascii") as handle:
        handle.write(text)
    return ifcopenshell.open(path)


def _space_name_spec(profile):
    # ifctester does not surface the IDS @identifier on the parsed object, so the governed
    # IDS-SPACE-NAME specification is located by its stable name.
    return next(s for s in profile.specifications
                if "institutional inventory code in Name" in s.name)


def _run(model, should_filter_version=False):
    profile = ids.open(GOVERNED_IDS, validate=True)
    profile.validate(model, should_filter_version=should_filter_version)
    return _space_name_spec(profile)


class IdsSpaceNameGovernanceTests(unittest.TestCase):
    def test_valid_name_passes(self):
        spec = _run(_single_space_model("IFC4X3_ADD2", "'T-101'"))
        self.assertIs(spec.status, True)

    def test_missing_blank_whitespace_and_invalid_name_all_fail(self):
        for name in ("$", "''", "'   '", "'XYZ'", "'t-101'", "'T-1010'"):
            spec = _run(_single_space_model("IFC4X3_ADD2", name))
            self.assertIs(spec.status, False, name)
            self.assertEqual(len(spec.failed_entities), 1, name)

    def test_reference_present_and_conflicting_is_ignored(self):
        # The fixture carries a valid IfcSpace.Name plus a Pset_SpaceCommon.Reference whose
        # value differs from Name. IDS-SPACE-NAME must still pass: Reference is never read.
        profile = ids.open(GOVERNED_IDS, validate=True)
        model = ifcopenshell.open(REFERENCE_IGNORED)
        profile.validate(model, should_filter_version=False)
        spec = _space_name_spec(profile)
        self.assertIs(spec.status, True)

    def test_every_accepted_schema_is_governed_with_filtering_off(self):
        # The runtime configuration: applicability is entity-based and version filtering is
        # disabled, so a missing Name fails IDS-SPACE-NAME for ALL four accepted variants,
        # never only IFC4X3_ADD2.
        for schema in ACCEPTED_SCHEMAS:
            spec = _run(_single_space_model(schema, "$"), should_filter_version=False)
            self.assertIs(spec.status, False, schema)
            self.assertEqual(len(spec.failed_entities), 1, schema)

    def test_filtering_enabled_control_documents_why_the_runtime_disables_it(self):
        # Positive control: with filtering ON, the IFC4X3_ADD2 token matches and the spec
        # still fails a missing Name.
        add2 = _run(_single_space_model("IFC4X3_ADD2", "$"), should_filter_version=True)
        self.assertIs(add2.status, False)
        # The other three parseable variants are SKIPPED under filtering (the IDS XSD cannot
        # name them), which is precisely why the runtime pins should_filter_version=False.
        for schema in ("IFC4X3", "IFC4X3_ADD1", "IFC4X3_TC1"):
            spec = _run(_single_space_model(schema, "$"), should_filter_version=True)
            self.assertIsNot(spec.status, False, schema)


if __name__ == "__main__":
    unittest.main()
