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

def extract_inventory_by_space():
    model = ifcopenshell.open("source_model.ifc")

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

            inventory[space_guid]["elements"].append({
                "guid": el.GlobalId,
                "type": el.is_a(),
                "name": getattr(el, "Name", None)
            })

    return inventory