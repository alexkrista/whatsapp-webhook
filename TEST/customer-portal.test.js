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

test("portal contact defaults come from customer data, without guessing between two owners or other recipients", () => {
  const { customerContactDefaults } = require("../customer-portal");
  let contact = customerContactDefaults({ name: "Testprojekt", customerMaster: { name: "Testkunde", email: " kunde@example.test ", phone: "+430000001" } });
  assert.equal(contact.customerName, "Testkunde"); assert.equal(contact.customerEmail, "kunde@example.test"); assert.equal(contact.customerPhone, "+430000001");
  contact = customerContactDefaults({ projectContacts: { owner: { womanEmail: "person1@example.test", manEmail: "person2@example.test", phoneOwnerWoman: "+430000002", phoneOwnerMan: "+430000003" }, architect: { email: "architect@example.test" } } });
  assert.equal(contact.customerEmail, ""); assert.equal(contact.customerPhone, "");
  assert.deepEqual(contact.emails, ["person1@example.test", "person2@example.test"]); assert.equal(contact.phones.length, 2);
  contact = customerContactDefaults({ contactEmail: "selected@example.test", projectContacts: { owner: { womanEmail: "person1@example.test", manEmail: "person2@example.test" } } });
  assert.equal(contact.customerEmail, "selected@example.test");
});

test("opening portal settings reads fresh main-file contacts without saving or replacing portal choices", async t => {
  const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "portal-defaults-")); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dataDir, "99001"));
  const routes = {}; let version = 1, result;
  require("../customer-portal").registerCustomerPortal({ get(route, fn) { routes[route] = fn; }, put() {} }, {
    dataDir, requireAdmin: () => true,
    readJobMeta: async () => ({ customerPortal: { customerEmail: "portal@example.test", status: "prepared" }, projectContacts: { owner: { email: `current${version}@example.test`, phoneOwnerMan: "+430000001" } } }),
    writeJobMeta() { assert.fail("Opening must not write"); }, appendJobHistory() { assert.fail("Opening must not write"); },
  });
  const open = () => routes["/admin/api/job/:jobId/customer-portal"]({ params: { jobId: "99001" } }, { json(value) { result = value; }, status(code) { throw new Error(String(code)); } });
  await open(); assert.equal(result.contactDefaults.customerEmail, "current1@example.test"); assert.equal(result.portal.customerEmail, "portal@example.test");
  version = 2; await open(); assert.equal(result.contactDefaults.customerEmail, "current2@example.test"); assert.equal(result.portal.status, "prepared");
});
