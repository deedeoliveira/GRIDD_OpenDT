import os

import ifcopenshell_utils
from flask import Flask, request

# service_config loads back/python/.env deterministically at import (python-dotenv when
# available; process environment stays authoritative) and provides fail-fast accessors.
from service_config import ConfigError
from model_download import (
    ModelDownloadError,
    download_legacy_model_file,
    download_version_file,
)

app = Flask(__name__)


def _write_source_model(data):
    # IfcOpenShell needs a file to work with, so we save the downloaded data to a temp file.
    with open("source_model.ifc", "wb") as model_file:
        model_file.write(data)


def _download_error(error):
    # Configuration/HTTP failures are reported with a stable message that never contains
    # the credential.
    return {"status": "error", "message": str(error), "ok": False}, 500


@app.post("/api/model/process/<modelId>")
def process_model(modelId):
    """
    LEGACY sensor extraction. Downloads the current model file from the UNAUTHENTICATED
    legacy Node route by model id — the internal-service token is never sent here.
    """
    try:
        data = download_legacy_model_file(modelId)
    except (ConfigError, ModelDownloadError) as error:
        return _download_error(error)

    _write_source_model(data)
    try:
        sensorRoomMap = ifcopenshell_utils.process_ifc_file()
    except ifcopenshell_utils.UnsupportedIfcSchemaError as error:
        # IFC4x3-only profile (ADR-0052 §A): the legacy sensor route rejects non-IFC4x3
        # files explicitly rather than silently accepting IFC4/IFC2X3.
        return {"status": "error", "message": str(error),
                "code": "unsupported_ifc_schema", "ok": False}, 422
    return {"status": "success", "data": sensorRoomMap, "ok": True}, 200


# Andressa
@app.post("/api/model/inventory/<modelId>")
def inventory_model(modelId):
    """
    Inventory extraction for the versioning flow. Node sends an opaque numeric
    `versionId` form field; this service constructs the AUTHENTICATED version-download
    URL itself from trusted configuration and presents the internal-service token. When
    no `versionId` is supplied (legacy current-file callers), it falls back to the
    UNAUTHENTICATED legacy download by model id — and never sends the token there.
    """
    version_id = request.form.get("versionId")
    try:
        if version_id is not None and version_id.strip() != "":
            data = download_version_file(version_id)
        else:
            data = download_legacy_model_file(modelId)
    except (ConfigError, ModelDownloadError) as error:
        return _download_error(error)

    _write_source_model(data)

    # The response body is built by the SINGLE pure function build_inventory_payload
    # (ADR-0051 Stage 0B §7-v4), so the endpoint and the tests exercise the same code.
    # It carries "data" (GlobalId-keyed, for backward compatibility) alongside the
    # ordered LOSSLESS "spaceOccurrences" list (one record per IfcSpace ENTITY, before
    # any GlobalId collapse - the dict in "data" can never reveal two IfcSpace instances
    # that share one exact GlobalId; this list can) plus the model context, all consumed
    # by the Node.js model_requirements_preflight and the identity preflight.
    return ifcopenshell_utils.build_inventory_payload(), 200


if (__name__ == "__main__"):
    # The IFC-extraction service is a LOCAL/INTERNAL microservice with no inbound
    # authentication on its own routes; it must not be exposed on all interfaces by
    # default. Bind to loopback unless an explicit bind host is configured.
    bind_host = os.getenv("FLASK_BIND_HOST", "127.0.0.1")
    bind_port = int(os.getenv("FLASK_API_PORT", "3002"))
    app.run(host=bind_host, port=bind_port)
