import ifcopenshell
import ifcopenshell.util.selector
import ifcopenshell.util.element #Andressa

def process_ifc_file():
    model = ifcopenshell.open("source_model.ifc")
    
    schema = model.header.file_schema.schema_identifiers[0]

    ifcSensorType = "IfcSensor" if schema.startswith("IFC4") else "IfcDistributionControlElement"

    sensors = ifcopenshell.util.selector.filter_elements(model, ifcSensorType)

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
    Extrai os dados brutos de um IfcSpace, incluindo todos os property sets.
    A extração NÃO decide nada: identidade persistente, reservabilidade e
    validação de códigos são responsabilidade da camada de domínio no Node.js
    (o provider de identidade escolhe que property set/propriedade usar).
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

    The extraction stays DUMB: it copies ALL property sets verbatim and names none.
    Interpreting a specific pset (e.g. the identity Reference) is the Node.js
    identity/model-intake layer's responsibility, never Python's.
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


def build_inventory_payload(file_path="source_model.ifc"):
    """
    Build the EXACT body of the ordinary `/api/model/inventory/<modelId>` response
    (ADR-0051 Stage 0B §7-v4). The Flask endpoint calls THIS function, so a test that
    invokes it exercises the real endpoint-used implementation — not a hand-assembled
    reconstruction. It stays a dumb extractor: it copies raw property sets and never
    interprets a Reference. Fields:
      - `data`               — GlobalId-keyed inventory (duplicates already collapsed);
      - `spaceOccurrences`   — ordered LOSSLESS list, one record per IfcSpace entity,
                               each carrying its own `entityId` and `storeyName`, so two
                               IfcSpace instances sharing one exact GlobalId are BOTH kept;
      - `schema`             — declared IFC schema;
      - `uncontainedProxies` — proxies outside any IfcSpace (PROXY-* rules).
    """
    inventory = extract_inventory_by_space(file_path)
    occurrences = extract_space_occurrences(file_path)
    context = extract_model_context(file_path)
    return {
        "status": "success",
        "data": inventory,
        "spaceOccurrences": occurrences,
        "schema": context["schema"],
        "uncontainedProxies": context["uncontainedProxies"],
        "ok": True,
    }


def extract_model_context(file_path="source_model.ifc"):
    """
    Contexto do modelo para o preflight de requisitos no Node.js:
     - schema declarado no header (o perfil suportado/testado é IFC4);
     - IfcBuildingElementProxy fora de qualquer IfcSpace (as regras PROXY-*
       aplicam-se a QUALQUER proxy do modelo, contido ou não).
    """
    model = ifcopenshell.open(file_path)

    try:
        schema = model.header.file_schema.schema_identifiers[0]
    except Exception:
        schema = None

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

    return {"schema": schema, "uncontainedProxies": uncontained_proxies}
