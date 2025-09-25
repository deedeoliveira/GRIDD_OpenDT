import ifcopenshell_utils
import os
from dotenv import load_dotenv
from flask import Flask, request
import urllib3

load_dotenv()

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
    app.run(debug=True, host="0.0.0.0", port=os.getenv("FLASK_API_PORT"))