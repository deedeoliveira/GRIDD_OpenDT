"""Extract the existing project-rule input shape from a local IFC file."""

import argparse
import json

import ifcopenshell_utils


parser = argparse.ArgumentParser()
parser.add_argument("--ifc", required=True)
args = parser.parse_args()

_context = ifcopenshell_utils.extract_model_context(args.ifc)

# RZ-2A0: align controlled-intake extraction with the ordinary Flask path's
# `build_inventory_payload` contract, which already always emits
# `reservationZoneOccurrences` (never missing, `[]` when empty). Uses the single
# production source of truth in ifcopenshell_utils.py; no traversal logic is
# duplicated here.
#
# `IfcSpatialZone` does not exist as an entity type in the IFC2X3 schema (it was
# introduced in IFC4), so unconditionally calling
# `extract_reservation_zone_occurrences` on an IFC2X3 file raises inside
# IfcOpenShell (`Entity with name 'IfcSpatialZone' not found in schema
# 'IFC2X3'`) and crashes this whole CLI invocation before ANY field can be
# returned. The controlled-intake preflight (back/modelIntake/modelIntakeService.ts)
# calls this CLI to obtain `schema` BEFORE it applies the IFC4x3-only schema gate
# (ADR-0052 §A), so an IFC2X3/pre-IFC4 upload reaches this extraction call. The
# gate/rejection semantics themselves are unchanged by this guard: only the
# reservation-zone evidence field is skipped (as `[]`) for schemas where the
# entity type cannot exist at all, so the CLI keeps returning every other field
# (inventoryData/spaceOccurrences/uncontainedProxies/schema) for the gate to
# still reject the upload downstream exactly as before.
if ifcopenshell_utils.is_supported_ifc4x3_schema(_context["schema"]):
    _reservation_zone_occurrences = ifcopenshell_utils.extract_reservation_zone_occurrences(args.ifc)
else:
    _reservation_zone_occurrences = []

print(json.dumps({
    "inventoryData": ifcopenshell_utils.extract_inventory_by_space(args.ifc),
    # Lossless, ordered per-IfcSpace occurrences — the ONLY source that can reveal a
    # duplicate exact GlobalId (inventoryData is keyed by GlobalId and collapses them).
    "spaceOccurrences": ifcopenshell_utils.extract_space_occurrences(args.ifc),
    "uncontainedProxies": _context["uncontainedProxies"],
    "schema": _context["schema"],
    "reservationZoneOccurrences": _reservation_zone_occurrences,
}))
