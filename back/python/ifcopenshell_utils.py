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
def extract_inventory_by_space():
    model = ifcopenshell.open("source_model.ifc")

    # Base: spaces existentes
    spaces = model.by_type("IfcSpace")
    inventory = {}

    for sp in spaces:
        inventory[sp.GlobalId] = {
            "spaceGuid": sp.GlobalId,
            "spaceName": getattr(sp, "Name", None),
            "elements": []
        }

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
            inventory[space_guid] = {
                "spaceGuid": space_guid,
                "spaceName": getattr(structure, "Name", None),
                "elements": []
            }

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