"""
Server-to-server download of a promoted model file from the Node backend.

SECURITY CONTRACT
-----------------
The internal-service token is a bearer credential. It is attached ONLY to a URL this
module constructs itself, from a TRUSTED configured base plus a VALIDATED positive
integer version id. A caller can never select the scheme, host, port or path of the
authenticated request: there is no caller-supplied URL or `path` field anymore.

  * `download_version_file(version_id)` — AUTHENTICATED download of
    `GET /api/model/versions/<version_id>/download`. Sends the internal-service token.
    Redirects are disabled, so the token is never forwarded to a redirect target; any
    3xx is treated as failure. A read/connect timeout and a maximum accepted body size
    are enforced.
  * `download_legacy_model_file(model_id)` — LEGACY sensor/process download of
    `GET /api/model/download/<model_id>`. This route is not capability-guarded on Node,
    so NO internal-service token is sent. Same redirect/timeout/size safeguards apply.

The token is NEVER placed in a URL/query string, a log line, or an error message.
"""
import re

import urllib3

from service_config import (
    INTERNAL_SERVICE_TOKEN_HEADER,
    internal_service_token,
    legacy_model_download_base,
    model_version_download_base,
)


class ModelDownloadError(RuntimeError):
    """The model file could not be downloaded from the Node backend."""


# A canonical positive integer id: no sign, no leading zero, no dot, slash, scheme,
# userinfo, query or fragment. Anything else is rejected BEFORE any HTTP request.
_POSITIVE_INT = re.compile(r"^[1-9][0-9]*$")

# Explicit local-download timeout (a local Node model download is fast; it must never
# hang the extraction worker) and a hard cap on the response body we are willing to
# accept. These bound the authenticated request independently of the caller.
_CONNECT_TIMEOUT_SECONDS = 5.0
_READ_TIMEOUT_SECONDS = 60.0
MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024


def _validate_numeric_id(value, label):
    """
    Return the canonical string form of a positive-integer id, or raise
    `ModelDownloadError` (never a TypeError) for zero, negative, non-numeric,
    path-like or URL-like input. No HTTP request is made for a rejected id.
    """
    text = "" if value is None else str(value).strip()
    if not _POSITIVE_INT.match(text):
        # The rejected value is not a secret, but keep the message about shape only.
        raise ModelDownloadError(
            "invalid %s: a positive integer is required (got a non-numeric, "
            "path-like or URL-like value)" % label
        )
    return text


def resolve_version_download_url(version_id):
    """
    Construct the authenticated model-version download URL from the TRUSTED configured
    base and a validated positive-integer version id. Never accepts a caller-supplied
    URL. Raises `ModelDownloadError` for an invalid id and `ConfigError` when the base
    is not configured.
    """
    validated = _validate_numeric_id(version_id, "version id")
    return "%s/%s/download" % (model_version_download_base(), validated)


def resolve_legacy_download_url(model_id):
    """
    Construct the LEGACY (unauthenticated) model download URL from the configured legacy
    base and a validated positive-integer model id. No token is ever sent to this URL.
    """
    validated = _validate_numeric_id(model_id, "model id")
    return "%s/%s" % (legacy_model_download_base(), validated)


def _timeout():
    return urllib3.Timeout(connect=_CONNECT_TIMEOUT_SECONDS, read=_READ_TIMEOUT_SECONDS)


def _get_bytes(http, url, headers):
    """
    Perform a single bounded GET with redirects disabled and return the body bytes.
    Every 3xx is a failure (the token, when present, is therefore never forwarded to a
    redirect target). Raises `ModelDownloadError` on any non-200 status, an empty body,
    or a body larger than MAX_DOWNLOAD_BYTES. Never includes credential material.
    """
    response = http.request(
        "GET",
        url,
        headers=headers,
        redirect=False,
        timeout=_timeout(),
    )
    status = response.status
    if 300 <= status < 400:
        raise ModelDownloadError(
            "model download refused a redirect (status %s); the request is not followed"
            % status
        )
    if status != 200:
        # Report the status only — never the token, the header, or the upstream body.
        raise ModelDownloadError("model download failed with status %s" % status)
    data = response.data
    if data is None or len(data) == 0:
        raise ModelDownloadError("model download returned an empty body")
    if len(data) > MAX_DOWNLOAD_BYTES:
        raise ModelDownloadError(
            "model download exceeded the maximum accepted size of %d bytes"
            % MAX_DOWNLOAD_BYTES
        )
    return data


def download_version_file(version_id, http=urllib3):
    """
    AUTHENTICATED download of the promoted model file for a specific version. The URL is
    constructed from trusted configuration; the internal-service credential is presented
    in the dedicated header. Returns the raw bytes on success. Raises `ModelDownloadError`
    on an invalid id / non-200 status / redirect / empty or oversized body, and
    `ConfigError` when required configuration (base URL or token) is missing.
    """
    url = resolve_version_download_url(version_id)
    token = internal_service_token()
    return _get_bytes(http, url, {INTERNAL_SERVICE_TOKEN_HEADER: token})


def download_legacy_model_file(model_id, http=urllib3):
    """
    LEGACY, UNAUTHENTICATED download for the sensor/process flow. The Node legacy route is
    not capability-guarded, so NO internal-service token is attached. Same redirect,
    timeout and size safeguards as the authenticated path.
    """
    url = resolve_legacy_download_url(model_id)
    return _get_bytes(http, url, {})
