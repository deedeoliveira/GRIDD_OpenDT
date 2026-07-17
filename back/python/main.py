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

    inventory = ifcopenshell_utils.extract_inventory_by_space()
    context = ifcopenshell_utils.extract_model_context()

    # "data" mantém o formato anterior (dict de espaços) por compatibilidade;
    # o contexto do modelo (schema, proxies não contidos) segue em campos
    # irmãos para o model_requirements_preflight do Node.js.
    return {
        "status": "success",
        "data": inventory,
        "schema": context["schema"],
        "uncontainedProxies": context["uncontainedProxies"],
        "ok": True
    }, 200
