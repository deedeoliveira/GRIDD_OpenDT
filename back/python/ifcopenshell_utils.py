
import ifcopenshell
import ifcopenshell.util.selector
import ifcopenshell.util.element #Andressa


# ---------------------------------------------------------------------------
# IFC4x3-only application profile (ADR-0052 §A).
#
# The operational profile accepts ONLY the IFC4x3 family and rejects IFC2X3 and
# IFC4 with an explicit unsupported-schema result. Acceptance is a PRECISE
# allowlist, not a prefix test: exactly the four IFC4x3 identifiers the installed
# IfcOpenShell 0.8 toolchain can parse — IFC4X3, IFC4X3_ADD1, IFC4X3_ADD2,
# IFC4X3_TC1. Pre-release IFC4X3_RC<number> forms are NOT accepted: IfcOpenShell
# 0.8 raises SchemaError on them, so admitting them would advertise a variant the
# toolchain cannot process. An invented IFC4X3_* variant (e.g. IFC4X3_ADD3) is NOT
# accepted merely because it begins with "IFC4X3". This allowlist is checked
# BEFORE any bare "IFC4" branch because "IFC4X3".startswith("IFC4") is also true.
# Kept byte-for-byte in sync with back/utils/ifcSchemaSupport.ts (one shared policy).
# ---------------------------------------------------------------------------

SUPPORTED_IFC4X3_IDENTIFIERS = frozenset({
    "IFC4X3", "IFC4X3_ADD1", "IFC4X3_ADD2", "IFC4X3_TC1",
})


def classify_ifc_schema(schema):
    """Classify a declared header schema identifier against the precise IFC4x3 allowlist.

    Mirrors back/utils/ifcSchemaSupport.ts EXACTLY (one shared policy). Accepts only the
    four verified IFC4x3 release identifiers (IFC4X3, IFC4X3_ADD1/ADD2, IFC4X3_TC1) that
    IfcOpenShell can parse; a pre-release IFC4X3_RC<number> or an invented IFC4X3_* variant
    is 'unsupported_other', NOT 'unsupported_ifc4'. Returns one of: 'supported'
    | 'unsupported_ifc4' | 'unsupported_ifc2x3' | 'unsupported_other' | 'unknown'
    (None/blank). Never raises.
    """
    if not schema or not isinstance(schema, str):
        return "unknown"
    ident = schema.strip().upper()
    if ident in SUPPORTED_IFC4X3_IDENTIFIERS:
        return "supported"
    if ident.startswith("IFC4X3"):
        return "unsupported_other"
    if ident.startswith("IFC2X3"):
        return "unsupported_ifc2x3"
    if ident.startswith("IFC4"):
        return "unsupported_ifc4"
    return "unsupported_other"


def is_supported_ifc4x3_schema(schema):
    """True iff the declared schema belongs to the accepted IFC4x3 family."""
    return classify_ifc_schema(schema) == "supported"


class UnsupportedIfcSchemaError(ValueError):
    """Raised when an operational entry point receives a non-IFC4x3 file."""

    def __init__(self, schema):
        self.schema = schema
        super().__init__(
            f"Unsupported IFC schema {schema!r}: the application profile requires IFC4x3 (ADR-0052)."
        )


def process_ifc_file():
    model = ifcopenshell.open("source_model.ifc")

    schema = model.header.file_schema.schema_identifiers[0]

    # IFC4x3-only gate (ADR-0052 §A). This legacy sensor-extraction route is still an
    # ACTIVE operational entry point; it must apply the SAME precise IFC4x3 allowlist as
    # the versioning intake so it cannot become an alternate IFC4/IFC2X3-compatible path.
    # IFC4x3 defines IfcSensor, so there is no longer any IFC2X3 fallback class.
    if not is_supported_ifc4x3_schema(schema):
        raise UnsupportedIfcSchemaError(schema)

    sensors = ifcopenshell.util.selector.filter_elements(model, "IfcSensor")

    sensorData = {}

    for sensor in sensors:
        space = ifcopenshell.util.element.get_container(sensor)

        sensorData[sensor.GlobalId] = {
            "name": space.Name + ' - ' + sensor.Name,
            "guid": sensor.GlobalId,
            "space": space.GlobalId if space else None,
            "x": sensor.ObjectPlacement.RelativePlacement.Location.Coordinates[0],
            "y": sensor.ObjectPlacement.RelativePlacement.Location.Coordinates[1],
            "z": sensor.ObjectPlacement.RelativePlacement.Location.Coordinates[2]
        }

    return sensorData

#Andressa
def _space_entry(sp):
    """
    Extrai os dados de um IfcSpace de forma lossless. Contrato do código de
    inventário do IfcSpace (ADR-0052): GlobalId copiado exatamente; Name copiado
    como fonte do código de inventário institucional; LongName copiado como
    rótulo informativo opcional; a Reference (deprecada) é IGNORADA — nunca é a
    fonte de identidade nem de código. Os property sets são copiados na íntegra
    apenas para o processamento de EQUIPAMENTO (não do IfcSpace); a extração não
    interpreta nenhum pset do espaço.
    """
    try:
        psets = ifcopenshell.util.element.get_psets(sp)
    except Exception:
        psets = {}

    try:
        container = ifcopenshell.util.element.get_aggregate(sp)
        storey_name = getattr(container, "Name", None) if container and container.is_a("IfcBuildingStorey") else None
    except Exception:
        storey_name = None

    return {
        "spaceGuid": sp.GlobalId,
        "spaceName": getattr(sp, "Name", None),
        "spaceLongName": getattr(sp, "LongName", None),
        "storeyName": storey_name,
        "psets": psets,
        "elements": []
    }

def _space_occurrence(sp):
    """
    One LOSSLESS record per IfcSpace ENTITY (ADR-0051 Stage 0B §1). Emitted as an
    ordered list BEFORE any GlobalId-keyed collapse, so two IfcSpace instances that
    share the same exact GlobalId are both retained for duplicate detection — which
    `extract_inventory_by_space` (a dict keyed by GlobalId) can never reveal.

    Contrato IfcSpace (ADR-0052): GlobalId lossless; Name = fonte do código de
    inventário institucional; LongName = rótulo informativo opcional; a Reference
    (deprecada) é IGNORADA. Os property sets são copiados na íntegra apenas para o
    processamento de equipamento a jusante; a extração não interpreta nenhum pset
    do IfcSpace.
    """
    try:
        psets = ifcopenshell.util.element.get_psets(sp)
    except Exception:
        psets = {}

    # Per-occurrence storey (ADR-0051 §3-v3): two IfcSpace occurrences that share one
    # GlobalId may sit under different storeys, so the storey is derived PER OCCURRENCE
    # here rather than looked up from the GlobalId-collapsed inventory.
    try:
        container = ifcopenshell.util.element.get_aggregate(sp)
        storey_name = getattr(container, "Name", None) if container and container.is_a("IfcBuildingStorey") else None
    except Exception:
        storey_name = None

    return {
        "entityId": sp.id(),
        "guid": sp.GlobalId,
        "name": getattr(sp, "Name", None),
        "longName": getattr(sp, "LongName", None),
        "storeyName": storey_name,
        "psets": psets,
    }


def extract_space_occurrences(file_path="source_model.ifc"):
    """Ordered, lossless list of every IfcSpace occurrence (no GlobalId collapse)."""
    model = ifcopenshell.open(file_path)
    return [_space_occurrence(sp) for sp in model.by_type("IfcSpace")]


def extract_inventory_by_space(file_path="source_model.ifc"):
    model = ifcopenshell.open(file_path)

    # Base: spaces existentes
    spaces = model.by_type("IfcSpace")
    inventory = {}

    for sp in spaces:
        inventory[sp.GlobalId] = _space_entry(sp)

    rels = model.by_type("IfcRelContainedInSpatialStructure")
    for rel in rels:
        structure = rel.RelatingStructure
        if not structure:
            continue

        # só inventário por IfcSpace
        if not structure.is_a("IfcSpace"):
            continue

        space_guid = structure.GlobalId
        if space_guid not in inventory:
            inventory[space_guid] = _space_entry(structure)

        for el in rel.RelatedElements or []:
            # IfcElement em geral
            if not el.is_a("IfcElement"):
                continue

            inventory[space_guid]["elements"].append(_element_entry(el))

    return inventory


def _element_entry(el):
    """
    Extração bruta de um IfcElement. A extração NÃO decide nada: a
    classificação (equipamento gerido vs outros) e a validação de requisitos
    (Tag EQP-, ObjectType dos proxies) são responsabilidade do Node.js.
    """
    try:
        el_psets = ifcopenshell.util.element.get_psets(el)
    except Exception:
        el_psets = {}

    predefined = getattr(el, "PredefinedType", None)
    return {
        "guid": el.GlobalId,
        "type": el.is_a(),
        "name": getattr(el, "Name", None),
        "tag": getattr(el, "Tag", None),
        "objectType": getattr(el, "ObjectType", None),
        "predefinedType": str(predefined) if predefined is not None else None,
        "psets": el_psets
    }


def _reservation_zone_occurrence(zone, model):
    """
    One LOSSLESS record per IfcSpatialZone occurrence whose PredefinedType is
    RESERVATION (RZ-1). Mirrors the `_space_occurrence` philosophy: an ordered,
    ungrouped record so malformed/duplicate GlobalId occurrences remain
    observable — RZ-1 preserves evidence only, it does not resolve identity.

    ReservationZone here is an IFC-EXTRACTION CANDIDATE, not yet the future
    persistent operational resource (that is RZ-2's `reservation_zone_uuid`).
    `IfcSpatialZone.Name` is a mandatory OPERATIONAL LABEL in the eventual
    governed contract, but RZ-1 is purely observational: a missing Name is
    extracted as `name=None` and never rejects model intake. (Future contract
    only, NOT implemented here: a `missing_zone_name` acceptance gate belongs
    to a later, explicitly-governed slice.)

    Spatial references are collected from real `IfcRelReferencedInSpatialStructure`
    relationships where this zone is `RelatingStructure` (NOT the unrelated
    `IfcRelContainedInSpatialStructure`, which is a different relationship already
    used for space->element containment). One zone may reference many IfcSpaces,
    and one IfcSpace may be referenced by many zones (N:M) — no collapsing, no
    exclusivity check, no DB identity logic.
    """
    referenced_guids = set()
    for rel in model.by_type("IfcRelReferencedInSpatialStructure"):
        if rel.RelatingStructure != zone:
            continue
        for el in rel.RelatedElements or []:
            if el is not None and el.is_a("IfcSpace") and getattr(el, "GlobalId", None):
                referenced_guids.add(el.GlobalId)

    # Deterministic ordering: lexicographic sort after deduplication. No existing
    # ordering convention for a set-valued relationship field was found in
    # `_space_occurrence`/`_space_entry` (their fields are scalar or model-order
    # lists), so lexicographic-by-GlobalId is chosen here as the simplest
    # deterministic rule.
    ordered_guids = sorted(referenced_guids)

    predefined = getattr(zone, "PredefinedType", None)
    return {
        "entityId": zone.id(),
        "ifcClass": "IfcSpatialZone",
        "globalId": zone.GlobalId,
        "name": getattr(zone, "Name", None),
        "predefinedType": str(predefined) if predefined is not None else None,
        "referencedSpaceGlobalIds": ordered_guids,
    }


def extract_reservation_zone_occurrences(model_or_path="source_model.ifc"):
    """
    Ordered, lossless list of every IfcSpatialZone occurrence whose
    PredefinedType is RESERVATION (RZ-1 candidate filter). A candidate is
    included only when `entity.is_a("IfcSpatialZone")` AND
    `str(entity.PredefinedType) == "RESERVATION"`, with defensive handling of a
    missing/None PredefinedType (never crashes). Values other than RESERVATION
    (NOTDEFINED, USERDEFINED, any other IfcSpatialZoneTypeEnum member, or
    None/missing) are excluded — never case-normalized, never inferred from
    Name/ObjectType. Does NOT place zones into the IfcSpace `data`
    dictionary/`elements`; returns a standalone occurrence list, not a dict.

    Accepts either an already-open ifcopenshell model or a file path, matching
    both call styles used elsewhere in this module.
    """
    model = model_or_path if hasattr(model_or_path, "by_type") else ifcopenshell.open(model_or_path)

    occurrences = []
    for zone in model.by_type("IfcSpatialZone"):
        predefined = getattr(zone, "PredefinedType", None)
        if predefined is None:
            continue
        if str(predefined) != "RESERVATION":
            continue
        occurrences.append(_reservation_zone_occurrence(zone, model))
    return occurrences


def build_inventory_payload(file_path="source_model.ifc"):
    """
    Build the EXACT body of the ordinary `/api/model/inventory/<modelId>` response
    (ADR-0051 Stage 0B §7-v4). The Flask endpoint calls THIS function, so a test that
    invokes it exercises the real endpoint-used implementation — not a hand-assembled
    reconstruction. Per ADR-0052 the IfcSpace inventory-code contract is GlobalId
    (lossless) + Name (institutional inventory code) + LongName (optional label); the
    deprecated Reference is never interpreted (raw psets are copied only for downstream
    equipment processing). Fields:
      - `data`               — GlobalId-keyed inventory (duplicates already collapsed);
      - `spaceOccurrences`   — ordered LOSSLESS list, one record per IfcSpace entity,
                               each carrying its own `entityId` and `storeyName`, so two
                               IfcSpace instances sharing one exact GlobalId are BOTH kept;
      - `schema`             — declared IFC schema;
      - `uncontainedProxies` — proxies outside any IfcSpace (PROXY-* rules);
      - `reservationZoneOccurrences` — ordered LOSSLESS list of IfcSpatialZone
                               occurrences with PredefinedType=RESERVATION (RZ-1).
                               ADDITIVE ONLY: OBSERVATIONAL evidence, never consumed
                               by model-intake acceptance/governance in RZ-1. Always
                               an array (`[]` when the model has no ReservationZone),
                               never missing/null, so existing consumers that
                               ignore unknown fields are unaffected.
    """
    inventory = extract_inventory_by_space(file_path)
    occurrences = extract_space_occurrences(file_path)
    context = extract_model_context(file_path)
    reservation_zone_occurrences = extract_reservation_zone_occurrences(file_path)
    return {
        "status": "success",
        "data": inventory,
        "spaceOccurrences": occurrences,
        "schema": context["schema"],
        "schemaClassification": context["schemaClassification"],
        "schemaSupported": context["schemaSupported"],
        "uncontainedProxies": context["uncontainedProxies"],
        "reservationZoneOccurrences": reservation_zone_occurrences,
        "ok": True,
    }


def extract_model_context(file_path="source_model.ifc"):
    """
    Contexto do modelo para o preflight de requisitos no Node.js:
     - schema declarado no header + classificação IFC4x3 (ADR-0052 §A: apenas a
       família IFC4x3 é suportada; IFC2X3 e IFC4 são rejeitados);
     - IfcBuildingElementProxy fora de qualquer IfcSpace (as regras PROXY-*
       aplicam-se a QUALQUER proxy do modelo, contido ou não).
    """
    model = ifcopenshell.open(file_path)

    try:
        schema = model.header.file_schema.schema_identifiers[0]
    except Exception:
        schema = None

    schema_classification = classify_ifc_schema(schema)

    contained = set()
    for rel in model.by_type("IfcRelContainedInSpatialStructure"):
        structure = rel.RelatingStructure
        if structure is not None and structure.is_a("IfcSpace"):
            for el in rel.RelatedElements or []:
                contained.add(el.GlobalId)

    uncontained_proxies = [
        _element_entry(proxy)
        for proxy in model.by_type("IfcBuildingElementProxy")
        if proxy.GlobalId not in contained
    ]

    return {
        "schema": schema,
        "schemaClassification": schema_classification,
        "schemaSupported": schema_classification == "supported",
        "uncontainedProxies": uncontained_proxies,
    }
