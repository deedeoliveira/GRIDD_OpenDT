"""
Deterministic-configuration tests for service_config (stdlib unittest).

Proven:
  - the version-download base, legacy base and token accessors each raise an explicit
    ConfigError when their value is missing/empty (never a TypeError);
  - an externally supplied process environment variable is honoured (authoritative);
  - base URLs are normalised (no trailing slash);
  - importing service_config succeeds AND its accessors still work when python-dotenv is
    genuinely unavailable — proven in a real isolated subprocess whose import of `dotenv`
    raises ImportError (no developer .env is required, and the developer's installed
    environment is never mutated).
"""
import os
import subprocess
import sys
import textwrap
import unittest

PY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PY_DIR)

import service_config  # noqa: E402
from service_config import (  # noqa: E402
    ConfigError,
    internal_service_token,
    legacy_model_download_base,
    model_version_download_base,
)

REQUIRED = ("MODEL_VERSION_DOWNLOAD_BASE_URL", "MODEL_DOWNLOAD_ROUTE", "OSWADT_INTERNAL_SERVICE_TOKEN")


class ServiceConfigTests(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in REQUIRED}

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_missing_version_base_raises_configerror(self):
        os.environ.pop("MODEL_VERSION_DOWNLOAD_BASE_URL", None)
        with self.assertRaises(ConfigError):
            model_version_download_base()

    def test_missing_legacy_base_raises_configerror(self):
        os.environ.pop("MODEL_DOWNLOAD_ROUTE", None)
        with self.assertRaises(ConfigError):
            legacy_model_download_base()

    def test_missing_internal_token_raises_configerror(self):
        os.environ.pop("OSWADT_INTERNAL_SERVICE_TOKEN", None)
        with self.assertRaises(ConfigError):
            internal_service_token()

    def test_empty_token_is_treated_as_missing(self):
        os.environ["OSWADT_INTERNAL_SERVICE_TOKEN"] = "   "
        with self.assertRaises(ConfigError):
            internal_service_token()

    def test_process_env_is_authoritative_and_trimmed(self):
        os.environ["OSWADT_INTERNAL_SERVICE_TOKEN"] = "  supplied-by-process  "
        self.assertEqual(internal_service_token(), "supplied-by-process")

    def test_version_base_trailing_slash_normalised(self):
        os.environ["MODEL_VERSION_DOWNLOAD_BASE_URL"] = "http://x/api/model/versions/"
        self.assertEqual(model_version_download_base(), "http://x/api/model/versions")

    def test_legacy_base_trailing_slash_normalised(self):
        os.environ["MODEL_DOWNLOAD_ROUTE"] = "http://x/api/model/download/"
        self.assertEqual(legacy_model_download_base(), "http://x/api/model/download")

    def test_module_exposes_accessors(self):
        self.assertTrue(hasattr(service_config, "internal_service_token"))
        self.assertTrue(hasattr(service_config, "model_version_download_base"))
        self.assertTrue(hasattr(service_config, "legacy_model_download_base"))

    def test_import_and_accessors_work_when_dotenv_unavailable(self):
        """
        Run a child interpreter in which importing `dotenv` raises ImportError, proving the
        guarded import in service_config is real: the module imports, an externally supplied
        variable is honoured, and a missing required variable raises ConfigError. The child
        gets a clean environment (no developer .env is loaded, since dotenv is blocked), and
        this parent process is never mutated.
        """
        child = textwrap.dedent(
            """
            import sys, importlib.abc

            class _BlockDotenv(importlib.abc.MetaPathFinder):
                def find_spec(self, name, path, target=None):
                    if name == 'dotenv' or name.startswith('dotenv.'):
                        raise ImportError('dotenv blocked for isolation test')
                    return None

            sys.meta_path.insert(0, _BlockDotenv())
            sys.path.insert(0, PY_DIR_PLACEHOLDER)

            import service_config
            assert 'dotenv' not in sys.modules, 'dotenv must not have been imported'

            # externally supplied variable is honoured without dotenv
            assert service_config.internal_service_token() == 'from-process-env', 'token accessor failed'

            # a missing required variable raises ConfigError, not TypeError
            import os
            os.environ.pop('MODEL_VERSION_DOWNLOAD_BASE_URL', None)
            try:
                service_config.model_version_download_base()
                raise SystemExit('expected ConfigError')
            except service_config.ConfigError:
                pass
            print('DOTENV_ABSENT_OK')
            """
        ).replace("PY_DIR_PLACEHOLDER", repr(PY_DIR))

        env = {
            "PATH": os.environ.get("PATH", ""),
            "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),
            "OSWADT_INTERNAL_SERVICE_TOKEN": "from-process-env",
        }
        result = subprocess.run(
            [sys.executable, "-c", child],
            capture_output=True,
            text=True,
            env=env,
            cwd=PY_DIR,
        )
        self.assertIn("DOTENV_ABSENT_OK", result.stdout, msg=f"stdout={result.stdout!r} stderr={result.stderr!r}")


if __name__ == "__main__":
    unittest.main()
