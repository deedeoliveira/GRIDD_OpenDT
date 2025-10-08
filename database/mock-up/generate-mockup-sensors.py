# -----------------------------------
# This script generates a JSON file with fake sensor data for each IfcSpace in an IFC file.
# Each sensor is placed at the centroid of the bounding box of the space.
#
# Requirements:
# - ifcopenshell
# -----------------------------------

IFC_FILE_PATH = "file.ifc" # Path to the IFC file
MODEL_ID = 1  # Id of the model in the database

import ifcopenshell.util.selector
import ifcopenshell.util.element
import ifcopenshell.geom
import ifcopenshell.util.shape
import ifcopenshell.guid
import json

def main():
    model = ifcopenshell.open(IFC_FILE_PATH)

    spaces = model.by_type("IfcSpace")

    settings = ifcopenshell.geom.settings()
    iterator = ifcopenshell.geom.iterator(settings = settings, file_or_filename = model, include=spaces)

    sensors = []

    if iterator.initialize():
        while True:
            shape = iterator.get()
            name = shape.name
            space_id = shape.guid
            [x, y, z] = ifcopenshell.util.shape.get_shape_bbox_centroid(shape, shape.geometry)

            sensors.append({
                "guid": ifcopenshell.guid.new(),
                "model_id": MODEL_ID,
                "name": name,
                "room_id": space_id,
                "x": x,
                "y": y,
                "z": z
            })

            if not iterator.next():
                break

    with open("sensors.json", "w") as f:
        json.dump(sensors, f, indent=4)

if (__name__ == "__main__"):
    main()