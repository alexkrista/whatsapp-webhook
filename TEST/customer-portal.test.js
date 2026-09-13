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

test("an existing portal on the main project can still use the independent collection", async t => {
  const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "collection-portal-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dataDir, "25018")); await fs.mkdir(path.join(dataDir, "legacy"));
  const routes = {}, writes = [];
  require("../customer-portal").registerCustomerPortal({ get(){}, put(route, fn){ routes[route] = fn; } }, {
    dataDir, requireAdmin: () => true,
    readJobMeta: async () => ({ collectionMemberJobIds: [], customerPortal: { status: "active", mode: "collection" } }),
    collectionMembers: async id => id === "25018" ? ["25018", "legacy"] : null,
    writeJobMeta: async (id, value) => writes.push({ id, value }), appendJobHistory: async () => {},
  });
  let result;
  const res = { status(value){ assert.fail("Unexpected HTTP " + value); }, json(value){ result = value; } };
  await routes["/admin/api/job/:jobId/customer-portal"]({ params: { jobId: "25018" }, body: { mode: "collection" } }, res);
  assert.equal(result.ok, true); assert.deepEqual(writes[0].value.customerPortal.includedJobIds, ["legacy"]);
  assert.equal(writes[0].value.customerPortal.status, "active");
});
