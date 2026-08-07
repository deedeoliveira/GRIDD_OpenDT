"""
Deterministic runtime configuration for the IFC-extraction microservice.

The baseline Stage 0B operational test showed that `back/python/.env` was NOT loaded
because the environment lacked `python-dotenv` and the service relied on Flask CLI
auto-loading. This module makes configuration deterministic:

  * it loads the `.env` colocated with this service ONCE, at import, using
    `python-dotenv` when available — WITHOUT overriding variables already present in
    the process environment (externally supplied values stay authoritative);
  * it exposes explicit, fail-fast accessors so a missing/empty required value raises
    a clear `ConfigError` instead of a `TypeError` deep inside a request handler.

Two DISTINCT download endpoints are configured separately, on purpose:

  * MODEL_VERSION_DOWNLOAD_BASE_URL — the AUTHENTICATED, capability-guarded Node route
    `GET /api/model/versions/:versionId/download`. The internal-service token is sent
    ONLY to a URL this service constructs from this trusted base plus a validated
    positive-integer version id (see model_download.download_version_file).
  * MODEL_DOWNLOAD_ROUTE — the LEGACY, unauthenticated sensor/process route
    `GET /api/model/download/:modelId`. The internal-service token is NEVER sent here.

No configuration value (in particular no credential) is ever logged by this module.
"""
import os

try:
    from dotenv import load_dotenv
    # Load the .env next to this service. override=False keeps any variable already
    # set in the real process environment authoritative over the file.
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"), override=False)
except ImportError:
    # python-dotenv is a declared dependency (requirements.txt). If it is not installed,
    # externally supplied process environment variables are still honoured; the
    # accessors below fail clearly when a required value is absent.
    pass


class ConfigError(RuntimeError):
    """A required runtime configuration value is missing or empty."""


def _require(name):
    value = os.getenv(name)
    if value is None or value.strip() == "":
        raise ConfigError(
            "Required environment variable %s is not set. Configure it in "
            "back/python/.env or the process environment." % name
        )
    return value.strip()


def model_version_download_base():
    """
    Trusted base for the AUTHENTICATED Node model-version download route
    (`/api/model/versions`, no trailing slash). The internal-service token is only ever
    attached to a URL constructed from this base plus a validated version id.
    """
    return _require("MODEL_VERSION_DOWNLOAD_BASE_URL").rstrip("/")


def legacy_model_download_base():
    """
    Trusted base for the LEGACY, unauthenticated sensor/process download route
    (`/api/model/download`, no trailing slash). The internal-service token is NEVER
    sent to this endpoint.
    """
    return _require("MODEL_DOWNLOAD_ROUTE").rstrip("/")


def internal_service_token():
    """Shared internal-service token for the authenticated version download. Never logged."""
    return _require("OSWADT_INTERNAL_SERVICE_TOKEN")


# Dedicated header carrying the internal-service token to the Node version-download route.
INTERNAL_SERVICE_TOKEN_HEADER = "X-OSWADT-Internal-Service-Token"
