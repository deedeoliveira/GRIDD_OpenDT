import test from "node:test";
import assert from "node:assert/strict";
import { loadApplicationIdentityConfig } from "../../applicationIdentity/applicationIdentityConfig.ts";

test("application identity is disabled by default and local sessions are refused in production", () => {
    assert.equal(loadApplicationIdentityConfig({}).mode, "disabled");
    assert.equal(loadApplicationIdentityConfig({ APPLICATION_IDENTITY_ENABLED: "true", APPLICATION_IDENTITY_MODE: "local_session" }).mode, "local_session");
    assert.throws(() => loadApplicationIdentityConfig({ NODE_ENV: "production", APPLICATION_IDENTITY_MODE: "local_session" }), /refused in production/);
});
