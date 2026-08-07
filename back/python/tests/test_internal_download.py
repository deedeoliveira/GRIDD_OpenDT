"""
Blocking security tests for the internal-service model-download boundary
(fix/model-upload-internal-download-auth review remediation).

These prove that the internal-service token can NEVER be sent to a caller-selected URL:

  - the authenticated version download is built from a TRUSTED configured base plus a
    VALIDATED positive-integer version id;
  - an absolute URL, alternate host/port/scheme, userinfo, query, fragment, path
    traversal, non-numeric / zero / negative id are all rejected BEFORE any HTTP request
    (zero outbound calls);
  - redirects are disabled and every 3xx is a failure, so the token is never forwarded
    to a redirect target;
  - a connect/read timeout is passed to urllib3;
  - the legacy download carries NO token;
  - the token never appears in the URL, an error message, or a log line.

The HTTP boundary is mocked with a recording fake; no network or Node process is used.
"""
import io
import os
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from service_config import (  # noqa: E402
    ConfigError,
    INTERNAL_SERVICE_TOKEN_HEADER,
)
import model_download  # noqa: E402
from model_download import (  # noqa: E402
    MAX_DOWNLOAD_BYTES,
    ModelDownloadError,
    download_legacy_model_file,
    download_version_file,
    resolve_legacy_download_url,
    resolve_version_download_url,
)

TOKEN = "test-only-internal-token-a1b2c3"
VERSION_BASE = "http://127.0.0.1:3001/api/model/versions"
LEGACY_BASE = "http://127.0.0.1:3001/api/model/download"


class FakeResponse:
    def __init__(self, status, data):
        self.status = status
        self.data = data


class RecordingHttp:
    """Records every outgoing request: url, headers, redirect option, timeout, count."""

    def __init__(self, response):
        self._response = response
        self.calls = []

    def request(self, method, url, headers=None, redirect=None, timeout=None, **kwargs):
        self.calls.append(
            {
                "method": method,
                "url": url,
                "headers": headers or {},
                "redirect": redirect,
                "timeout": timeout,
            }
        )
        return self._response


# Destinations an attacker might try to smuggle in through a "version id". Every one of
# these must be rejected before any HTTP request is issued.
MALICIOUS_IDS = [
    "http://evil.example/1",          # absolute URL / different host
    "https://evil.example/1",         # different scheme
    "//evil.example/1",               # scheme-relative host
    "http://user:pass@evil.example/1",  # userinfo
    "127.0.0.1:9999/1",               # different port smuggled in
    "1?redirect=http://evil",         # query string
    "1#http://evil",                  # fragment
    "../1",                           # path traversal
    "1/../../2",                      # path traversal
    "%2e%2e/1",                       # encoded traversal
    "1 2",                            # embedded space
    "abc",                            # non-numeric
    "0",                              # zero
    "-1",                             # negative
    "01",                             # leading zero (non-canonical)
    "1.0",                            # decimal
    "",                               # empty
    "   ",                            # whitespace
    None,                             # missing
]


class VersionUrlConstructionTests(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in ("MODEL_VERSION_DOWNLOAD_BASE_URL", "MODEL_DOWNLOAD_ROUTE", "OSWADT_INTERNAL_SERVICE_TOKEN")}
        os.environ["OSWADT_INTERNAL_SERVICE_TOKEN"] = TOKEN
        os.environ["MODEL_VERSION_DOWNLOAD_BASE_URL"] = VERSION_BASE
        os.environ["MODEL_DOWNLOAD_ROUTE"] = LEGACY_BASE

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_exact_trusted_version_url_is_constructed(self):
        self.assertEqual(resolve_version_download_url(42), "http://127.0.0.1:3001/api/model/versions/42/download")
        # a numeric string is accepted identically
        self.assertEqual(resolve_version_download_url("42"), "http://127.0.0.1:3001/api/model/versions/42/download")

    def test_exact_trusted_legacy_url_is_constructed(self):
        self.assertEqual(resolve_legacy_download_url(7), "http://127.0.0.1:3001/api/model/download/7")

    def test_every_malicious_or_invalid_id_is_rejected_with_no_http(self):
        for bad in MALICIOUS_IDS:
            http = RecordingHttp(FakeResponse(200, b"IFCDATA"))
            with self.subTest(id=bad):
                with self.assertRaises(ModelDownloadError):
                    download_version_file(bad, http=http)
                self.assertEqual(len(http.calls), 0, "no HTTP request may be sent for a rejected id")

    def test_resolve_rejects_malicious_ids_before_url(self):
        for bad in MALICIOUS_IDS:
            with self.subTest(id=bad):
                with self.assertRaises(ModelDownloadError):
                    resolve_version_download_url(bad)

    def test_rejection_is_modeldownloaderror_not_typeerror(self):
        try:
            resolve_version_download_url(None)
            self.fail("expected ModelDownloadError")
        except ModelDownloadError:
            pass
        except TypeError:
            self.fail("an invalid id must raise ModelDownloadError, never a TypeError")


class VersionDownloadTests(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in ("MODEL_VERSION_DOWNLOAD_BASE_URL", "MODEL_DOWNLOAD_ROUTE", "OSWADT_INTERNAL_SERVICE_TOKEN")}
        os.environ["OSWADT_INTERNAL_SERVICE_TOKEN"] = TOKEN
        os.environ["MODEL_VERSION_DOWNLOAD_BASE_URL"] = VERSION_BASE
        os.environ["MODEL_DOWNLOAD_ROUTE"] = LEGACY_BASE

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    # ---- header propagation, single trusted destination -----------------------
    def test_token_sent_only_in_header_to_the_trusted_url(self):
        http = RecordingHttp(FakeResponse(200, b"IFCDATA"))
        data = download_version_file(5, http=http)
        self.assertEqual(data, b"IFCDATA")
        self.assertEqual(len(http.calls), 1, "exactly one request, to the trusted URL")
        call = http.calls[0]
        self.assertEqual(call["url"], "http://127.0.0.1:3001/api/model/versions/5/download")
        self.assertEqual(call["headers"].get(INTERNAL_SERVICE_TOKEN_HEADER), TOKEN)
        self.assertNotIn(TOKEN, call["url"])  # never in the URL / query string

    def test_redirects_disabled_and_timeout_passed(self):
        http = RecordingHttp(FakeResponse(200, b"IFCDATA"))
        download_version_file(5, http=http)
        call = http.calls[0]
        self.assertIs(call["redirect"], False, "redirects must be explicitly disabled")
        self.assertIsNotNone(call["timeout"], "a connect/read timeout must be passed to urllib3")

    def test_every_3xx_is_treated_as_failure_no_second_destination(self):
        for status in (301, 302, 303, 307, 308):
            http = RecordingHttp(FakeResponse(status, b""))
            with self.subTest(status=status):
                with self.assertRaises(ModelDownloadError):
                    download_version_file(5, http=http)
                # redirect disabled => exactly one request, no forward to a second URL
                self.assertEqual(len(http.calls), 1)
                self.assertIs(http.calls[0]["redirect"], False)

    def test_token_required(self):
        os.environ.pop("OSWADT_INTERNAL_SERVICE_TOKEN", None)
        http = RecordingHttp(FakeResponse(200, b"IFCDATA"))
        with self.assertRaises(ConfigError):
            download_version_file(5, http=http)
        self.assertEqual(len(http.calls), 0, "no request is sent when the token is unconfigured")

    def test_version_base_required(self):
        os.environ.pop("MODEL_VERSION_DOWNLOAD_BASE_URL", None)
        http = RecordingHttp(FakeResponse(200, b"IFCDATA"))
        with self.assertRaises(ConfigError):
            download_version_file(5, http=http)
        self.assertEqual(len(http.calls), 0)

    def test_upstream_401_reported_without_token(self):
        http = RecordingHttp(FakeResponse(401, b""))
        with self.assertRaises(ModelDownloadError) as ctx:
            download_version_file(5, http=http)
        message = str(ctx.exception)
        self.assertIn("401", message)
        self.assertNotIn(TOKEN, message)

    def test_empty_body_reported_without_token(self):
        http = RecordingHttp(FakeResponse(200, b""))
        with self.assertRaises(ModelDownloadError) as ctx:
            download_version_file(5, http=http)
        self.assertNotIn(TOKEN, str(ctx.exception))

    def test_oversized_body_rejected(self):
        http = RecordingHttp(FakeResponse(200, b"x" * (MAX_DOWNLOAD_BYTES + 1)))
        with self.assertRaises(ModelDownloadError):
            download_version_file(5, http=http)

    def test_successful_download_returns_bytes_unchanged(self):
        http = RecordingHttp(FakeResponse(200, b"ISO-10303-21;\nHEADER;"))
        self.assertEqual(download_version_file(5, http=http), b"ISO-10303-21;\nHEADER;")

    def test_no_token_appears_in_logs(self):
        out, err = io.StringIO(), io.StringIO()
        http = RecordingHttp(FakeResponse(401, b""))
        with redirect_stdout(out), redirect_stderr(err):
            try:
                download_version_file(5, http=http)
            except ModelDownloadError:
                pass
        self.assertNotIn(TOKEN, out.getvalue())
        self.assertNotIn(TOKEN, err.getvalue())

    def test_default_http_client_is_urllib3(self):
        import inspect
        import urllib3
        default = inspect.signature(download_version_file).parameters["http"].default
        self.assertIs(default, urllib3)


class LegacyDownloadTests(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in ("MODEL_DOWNLOAD_ROUTE", "OSWADT_INTERNAL_SERVICE_TOKEN")}
        os.environ["OSWADT_INTERNAL_SERVICE_TOKEN"] = TOKEN
        os.environ["MODEL_DOWNLOAD_ROUTE"] = LEGACY_BASE

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_legacy_download_never_sends_the_token(self):
        http = RecordingHttp(FakeResponse(200, b"IFCDATA"))
        download_legacy_model_file(9, http=http)
        self.assertEqual(len(http.calls), 1)
        headers = http.calls[0]["headers"]
        self.assertNotIn(INTERNAL_SERVICE_TOKEN_HEADER, headers)
        self.assertEqual(http.calls[0]["url"], "http://127.0.0.1:3001/api/model/download/9")
        self.assertIs(http.calls[0]["redirect"], False)

    def test_legacy_download_rejects_invalid_id_without_http(self):
        http = RecordingHttp(FakeResponse(200, b"IFCDATA"))
        with self.assertRaises(ModelDownloadError):
            download_legacy_model_file("http://evil.example/9", http=http)
        self.assertEqual(len(http.calls), 0)


if __name__ == "__main__":
    unittest.main()
