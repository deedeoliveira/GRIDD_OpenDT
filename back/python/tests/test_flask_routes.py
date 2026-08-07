"""
Real Flask route tests for the IFC-extraction service (main.app), exercised through
Flask's test client. Only the OUTGOING HTTP boundary is mocked (urllib3.request is
replaced by a recording fake); the actual request handlers in main.py run.

The security property under test: the ACTUAL Flask inventory handler can never cause the
internal-service token to be sent to a caller-selected URL. It builds the authenticated
version-download URL itself from trusted configuration and a validated version id; the
legacy fallback carries no token; a removed/ignored `path` field cannot redirect the
request; an invalid or attacker-supplied version id is rejected before any HTTP call.
"""
import os
import shutil
import sys
import tempfile
import unittest

import urllib3

PY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PY_DIR)

from service_config import INTERNAL_SERVICE_TOKEN_HEADER  # noqa: E402
import main  # noqa: E402

TOKEN = "test-only-flask-token-7f7f7f"
VERSION_BASE = "http://127.0.0.1:3001/api/model/versions"
LEGACY_BASE = "http://127.0.0.1:3001/api/model/download"
FIXTURE = os.path.abspath(os.path.join(PY_DIR, "..", "tests", "fixtures", "stage0b-three-space-baseline.ifc"))
with open(FIXTURE, "rb") as _f:
    FIXTURE_BYTES = _f.read()


class FakeResponse:
    def __init__(self, status, data):
        self.status = status
        self.data = data


class Recorder:
    """Records every outgoing urllib3 request and returns a scripted response."""

    def __init__(self):
        self.calls = []
        self.response = FakeResponse(200, b"")

    def request(self, method, url, headers=None, redirect=None, timeout=None, **kwargs):
        self.calls.append({"method": method, "url": url, "headers": headers or {}, "redirect": redirect, "timeout": timeout})
        return self.response

    def token_ever_sent(self):
        return any(INTERNAL_SERVICE_TOKEN_HEADER in c["headers"] for c in self.calls)

    def urls(self):
        return [c["url"] for c in self.calls]


class FlaskInventoryRouteTests(unittest.TestCase):
    def setUp(self):
        self._saved_env = {k: os.environ.get(k) for k in ("MODEL_VERSION_DOWNLOAD_BASE_URL", "MODEL_DOWNLOAD_ROUTE", "OSWADT_INTERNAL_SERVICE_TOKEN")}
        os.environ["OSWADT_INTERNAL_SERVICE_TOKEN"] = TOKEN
        os.environ["MODEL_VERSION_DOWNLOAD_BASE_URL"] = VERSION_BASE
        os.environ["MODEL_DOWNLOAD_ROUTE"] = LEGACY_BASE

        # Run in a throwaway CWD: main writes source_model.ifc there and the extractor reads
        # it there, so nothing pollutes the repository.
        self._saved_cwd = os.getcwd()
        self._tmp = tempfile.mkdtemp(prefix="oswadt-flask-itest-")
        os.chdir(self._tmp)

        # Mock ONLY the outgoing HTTP boundary.
        self._saved_request = urllib3.request
        self.rec = Recorder()
        urllib3.request = self.rec.request

        main.app.testing = True
        self.client = main.app.test_client()

    def tearDown(self):
        urllib3.request = self._saved_request
        os.chdir(self._saved_cwd)
        shutil.rmtree(self._tmp, ignore_errors=True)
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    # ---- valid version id: token goes ONLY to the trusted version URL ---------
    def test_valid_version_id_downloads_from_trusted_url_with_token(self):
        self.rec.response = FakeResponse(200, FIXTURE_BYTES)
        resp = self.client.post("/api/model/inventory/9", data={"versionId": "5"})
        self.assertEqual(resp.status_code, 200)
        body = resp.get_json()
        self.assertEqual(len(body["data"]), 3, "the real extractor ran on the downloaded fixture")
        self.assertEqual(self.rec.urls(), ["http://127.0.0.1:3001/api/model/versions/5/download"])
        self.assertEqual(self.rec.calls[0]["headers"].get(INTERNAL_SERVICE_TOKEN_HEADER), TOKEN)
        self.assertIs(self.rec.calls[0]["redirect"], False)

    # ---- configuration missing ------------------------------------------------
    def test_missing_version_base_returns_error_no_token_no_http(self):
        os.environ.pop("MODEL_VERSION_DOWNLOAD_BASE_URL", None)
        resp = self.client.post("/api/model/inventory/9", data={"versionId": "5"})
        self.assertEqual(resp.status_code, 500)
        self.assertNotIn(TOKEN, resp.get_data(as_text=True))
        self.assertEqual(len(self.rec.calls), 0)

    # ---- invalid version id: rejected before any HTTP request -----------------
    def test_non_numeric_version_id_rejected_no_http(self):
        resp = self.client.post("/api/model/inventory/9", data={"versionId": "abc"})
        self.assertEqual(resp.status_code, 500)
        self.assertEqual(len(self.rec.calls), 0, "no outbound request for an invalid version id")

    def test_attacker_absolute_url_as_version_id_rejected_no_http(self):
        resp = self.client.post("/api/model/inventory/9", data={"versionId": "http://evil.example/1"})
        self.assertEqual(resp.status_code, 500)
        self.assertEqual(len(self.rec.calls), 0)
        self.assertNotIn(TOKEN, resp.get_data(as_text=True))

    # ---- the removed `path` field is inert: it cannot select the destination --
    def test_legacy_path_field_is_ignored_falls_back_to_legacy_no_token(self):
        # No versionId; an attacker-controlled `path` must NOT be used. The handler falls
        # back to the LEGACY download by the route model id, which carries no token.
        self.rec.response = FakeResponse(200, FIXTURE_BYTES)
        resp = self.client.post("/api/model/inventory/9", data={"path": "http://evil.example/steal"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(self.rec.urls(), ["http://127.0.0.1:3001/api/model/download/9"])
        self.assertFalse(self.rec.token_ever_sent(), "the token is never sent on the legacy fallback")
        self.assertFalse(any("evil.example" in u for u in self.rec.urls()), "the attacker URL is never contacted")

    # ---- upstream failures reported without token, no redirect followed -------
    def test_upstream_401_reported_without_token(self):
        self.rec.response = FakeResponse(401, b"")
        resp = self.client.post("/api/model/inventory/9", data={"versionId": "5"})
        self.assertEqual(resp.status_code, 500)
        self.assertNotIn(TOKEN, resp.get_data(as_text=True))

    def test_upstream_redirect_is_failure(self):
        self.rec.response = FakeResponse(302, b"")
        resp = self.client.post("/api/model/inventory/9", data={"versionId": "5"})
        self.assertEqual(resp.status_code, 500)
        self.assertEqual(len(self.rec.calls), 1, "the redirect is not followed to a second destination")
        self.assertIs(self.rec.calls[0]["redirect"], False)


if __name__ == "__main__":
    unittest.main()
