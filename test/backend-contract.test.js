const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createBookingService } = require("../lib/booking-service");
const { normalizeBookingPayload } = require("../lib/booking-model");
const { createSqliteStorage } = require("../lib/sqlite-storage");

function createTestService() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "laviya-bookings-"));
  const storage = createSqliteStorage({ dataDir, dbPath: path.join(dataDir, "test.sqlite") });
  storage.init();
  return createBookingService(storage);
}

const validPayload = {
  sessionType: "Photography session",
  date: "2026-07-12",
  time: "10:30",
  duration: "4",
  guests: "3",
  addons: ["Photographer"],
  name: "Aisha Client",
  email: "AISHA@example.com",
  notes: "Editorial portraits with a soft neutral setup."
};

test("normalizes a public booking into the Firebase-ready model", () => {
  const result = normalizeBookingPayload(validPayload, { source: "app", timestamp: "2026-06-21T10:00:00.000Z" });

  assert.equal(result.error, undefined);
  assert.equal(result.booking.source, "app");
  assert.equal(result.booking.status, "new");
  assert.equal(result.booking.client.email, "aisha@example.com");
  assert.equal(result.booking.session.durationHours, 4);
  assert.equal(result.booking.pricing.currency, "GBP");
  assert.equal(result.booking.pricing.estimatedCost, 220);
  assert.deepEqual(result.booking.statusHistory, [
    {
      status: "new",
      at: "2026-06-21T10:00:00.000Z",
      by: "app"
    }
  ]);
});

test("rejects missing required booking fields", () => {
  const result = normalizeBookingPayload({ ...validPayload, email: "not-an-email" });

  assert.equal(result.error, "Enter a valid email.");
});

test("SQLite storage adapter preserves the shared booking model", () => {
  const service = createTestService();
  const created = service.submitBooking(validPayload, { source: "web" });

  assert.equal(created.error, undefined);
  assert.equal(created.booking.id > 0, true);
  assert.equal(created.booking.source, "web");

  const listed = service.listBookings("all");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].client.email, "aisha@example.com");
  assert.equal(listed[0].session.type, "Photography session");
});

test("status updates append status history for future app and Firestore use", () => {
  const service = createTestService();
  const created = service.submitBooking(validPayload, { source: "web" });
  const updated = service.updateStatus(created.booking.id, "accepted", "admin");

  assert.equal(updated.error, undefined);
  assert.equal(updated.booking.status, "accepted");
  assert.equal(updated.booking.statusHistory.at(-1).status, "accepted");
  assert.equal(updated.booking.statusHistory.at(-1).by, "admin");
});

test("Firestore export exposes planned collections and booking documents", () => {
  const service = createTestService();
  service.submitBooking(validPayload, { source: "app" });
  const migration = service.exportForFirestore();

  assert.ok(migration.plannedCollections.includes("bookings"));
  assert.ok(migration.plannedCollections.includes("clients"));
  assert.equal(migration.collections.bookings.length, 1);
  assert.equal(migration.collections.bookings[0].source, "app");
});
