const assert = require("node:assert/strict");
const { test } = require("node:test");
const { sanitizeCustomerPortal } = require("../customer-portal");

test("portal modules are independent and collection ids are sanitized", () => {
  const portal = sanitizeCustomerPortal({
    status: "active",
    mode: "collection",
    modules: { projectFile: true, regie: false, communication: true, projectPoints: false },
    includedJobIds: ["26001", "26003", "../../etc", "26001"],
    customerEmail: " kunde@example.at ",
  });
  assert.deepEqual(portal.modules, { projectFile: true, regie: false, communication: true, projectPoints: false });
  assert.deepEqual(portal.includedJobIds, ["26001", "26003"]);
  assert.equal(portal.customerEmail, "kunde@example.at");
});

test("invalid states fall back safely", () => {
  const portal = sanitizeCustomerPortal({ status: "admin", mode: "anything", includedJobIds: ["26001"] });
  assert.equal(portal.status, "off");
  assert.equal(portal.mode, "single");
  assert.deepEqual(portal.includedJobIds, []);
});
