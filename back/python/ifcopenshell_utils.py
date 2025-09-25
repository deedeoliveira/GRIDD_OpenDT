import ifcopenshell
import ifcopenshell.util.selector

def process_ifc_file():
    model = ifcopenshell.open("source_model.ifc")
    
    schema = model.header.file_schema.schema_identifiers[0]

    ifcSensorType = "IfcDistributionControlElement" if schema == "IFC2X3" else "IfcSensor"

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

    # Perform operations on the IFC file
    return sensorData