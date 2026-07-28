import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs, isSystemSchema } from "../../scripts/runSpaceGlobalIdMigration.ts";

test("forward requires an explicit database confirmation and maintenance acknowledgement", () => {
  const cfg = parseCliArgs(["--confirm-database", "digital_twin", "--maintenance-confirmed"]);
  assert.equal(cfg.direction, "forward");
  assert.equal(cfg.confirmDatabase, "digital_twin");
  assert.equal(cfg.maintenanceConfirmed, true);
});

test("rollback requires --rollback, --confirm-rollback, --confirm-database and --maintenance-confirmed", () => {
  const cfg = parseCliArgs(["--rollback", "--confirm-rollback", "--confirm-database", "digital_twin", "--maintenance-confirmed"]);
  assert.equal(cfg.direction, "rollback");
  assert.equal(cfg.confirmDatabase, "digital_twin");
});

test("missing --confirm-database is rejected", () => {
  assert.throws(() => parseCliArgs(["--maintenance-confirmed"]), /--confirm-database/);
});

test("missing --maintenance-confirmed is rejected", () => {
  assert.throws(() => parseCliArgs(["--confirm-database", "digital_twin"]), /--maintenance-confirmed/);
});

test("--confirm-database without a value is rejected", () => {
  assert.throws(() => parseCliArgs(["--confirm-database", "--maintenance-confirmed"]), /requires a database name/);
});

test("rollback without --confirm-rollback is rejected", () => {
  assert.throws(() => parseCliArgs(["--rollback", "--confirm-database", "digital_twin", "--maintenance-confirmed"]), /--confirm-rollback/);
});

test("--confirm-rollback without --rollback is rejected", () => {
  assert.throws(() => parseCliArgs(["--confirm-rollback", "--confirm-database", "digital_twin", "--maintenance-confirmed"]), /only valid together with --rollback/);
});

test("unknown arguments fail rather than being ignored", () => {
  assert.throws(() => parseCliArgs(["--confirm-database", "digital_twin", "--maintenance-confirmed", "--force"]), /unknown argument: --force/);
});

test("isSystemSchema rejects system schemas independently of case", () => {
  for (const name of ["mysql", "MYSQL", "Mysql", "information_schema", "INFORMATION_SCHEMA", "performance_schema", "SYS"]) {
    assert.equal(isSystemSchema(name), true, `expected ${name} to be a system schema`);
  }
});

test("isSystemSchema permits real target databases", () => {
  assert.equal(isSystemSchema("digital_twin"), false);
  assert.equal(isSystemSchema("oswadt_spaceguid_migtest_example"), false);
});
