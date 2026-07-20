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

    return {
        "spaceGuid": sp.GlobalId,
        "spaceName": getattr(sp, "Name", None),
        "spaceLongName": getattr(sp, "LongName", None),
        "psets": psets,
        "elements": []
    }

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
