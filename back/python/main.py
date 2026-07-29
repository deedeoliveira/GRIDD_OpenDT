import ifcopenshell_utils
import os
from flask import Flask, request
import urllib3

app = Flask(__name__)

@app.post("/api/model/process/<modelId>")
def process_model(modelId):
    fileUrl = os.getenv("MODEL_DOWNLOAD_ROUTE") + f"/{modelId}"
    
    try:
        if (request.form['path'] is not None):
            fileUrl = request.form['path']
    except KeyError:
        pass

    res = urllib3.request("GET", fileUrl)

    if (res.status != 200):
        return {"status": "error", "message": "Failed to download model", "ok": False}, 500
    
    if (res.data is None or len(res.data) == 0):
        return {"status": "error", "message": "Model data is empty", "ok": False}, 500

    # IfcOpenShell needs a file to work with so we save the downloaded data to a temporary file
    with open("source_model.ifc", "wb") as modelFile:
        modelFile.write(res.data)
    
    sensorRoomMap = ifcopenshell_utils.process_ifc_file()

    return {"status": "success", "data": sensorRoomMap, "ok": True}, 200

if (__name__ == "__main__"):
    app.run(host="0.0.0.0")

#Andressa
@app.post("/api/model/inventory/<modelId>")
def inventory_model(modelId):
    fileUrl = os.getenv("MODEL_DOWNLOAD_ROUTE") + f"/{modelId}"

    try:
        if (request.form['path'] is not None):
            fileUrl = request.form['path']
    except KeyError:
        pass

    res = urllib3.request("GET", fileUrl)

    if (res.status != 200):
        return {"status": "error", "message": "Failed to download model", "ok": False}, 500

    if (res.data is None or len(res.data) == 0):
        return {"status": "error", "message": "Model data is empty", "ok": False}, 500

    with open("source_model.ifc", "wb") as modelFile:
        modelFile.write(res.data)

    # The response body is built by the SINGLE pure function build_inventory_payload
    # (ADR-0051 Stage 0B §7-v4), so the endpoint and the tests exercise the same code.
    # It carries "data" (GlobalId-keyed, for backward compatibility) alongside the
    # ordered LOSSLESS "spaceOccurrences" list (one record per IfcSpace ENTITY, before
    # any GlobalId collapse — the dict in "data" can never reveal two IfcSpace instances
    # that share one exact GlobalId; this list can) plus the model context, all consumed
    # by the Node.js model_requirements_preflight and the identity preflight.
    return ifcopenshell_utils.build_inventory_payload(), 200
