const {
  BOOKING_STATUSES,
  legacyBookingFromModel,
  normalizeBookingPayload,
  sqliteRowToBooking
} = require("./booking-model");

function createBookingService(storage) {
  function submitBooking(payload, options = {}) {
    const result = normalizeBookingPayload(payload, { source: options.source || "web" });
    if (result.error) return result;
    const booking = storage.createBooking(result.booking);
    return {
      booking,
      legacyBooking: legacyBookingFromModel(booking)
    };
  }

  function listBookings(status = "all") {
    return storage.listBookings(status);
  }

  function listBookingRows(status = "all") {
    return storage.listBookingRows(status);
  }

  function getBooking(id) {
    return storage.getBooking(id);
  }

  function getBookingRow(id) {
    return storage.getBookingRow(id);
  }

  function updateStatus(id, status, actor = "admin") {
    if (!BOOKING_STATUSES.includes(status)) return { error: "Choose a valid status." };
    const booking = storage.updateBookingStatus(id, status, actor);
    return booking ? { booking } : { error: "Booking not found." };
  }

  function updateInternalNotes(id, internalNotes) {
    const booking = storage.updateBookingNotes(id, internalNotes);
    return booking ? { booking } : { error: "Booking not found." };
  }

  function getClientHistory(email) {
    return storage.getClientHistoryRows(email);
  }

  function getClientNote(email) {
    return storage.getClientNote(email);
  }

  function saveClientNote(email, name, note) {
    storage.upsertClientNote(email, name, note);
    return storage.latestBookingForClient(email);
  }

  function countsByStatus() {
    return storage.countsByStatus();
  }

  function exportForFirestore() {
    return {
      collections: {
        bookings: storage.listBookingRows("all").map(sqliteRowToBooking),
        clientNotes: storage.listBookingRows("all").reduce((acc, row) => {
          if (!acc.some((note) => note.clientEmail === row.client_email)) {
            const clientNote = storage.getClientNote(row.client_email);
            if (clientNote) {
              acc.push({
                clientEmail: clientNote.client_email,
                clientName: clientNote.client_name,
                note: clientNote.note,
                updatedAt: clientNote.updated_at
              });
            }
          }
          return acc;
        }, [])
      },
      plannedCollections: ["bookings", "clients", "clientNotes", "adminUsers", "availability", "payments", "notifications"]
    };
  }

  return {
    countsByStatus,
    exportForFirestore,
    getBooking,
    getBookingRow,
    getClientHistory,
    getClientNote,
    listBookingRows,
    listBookings,
    saveClientNote,
    submitBooking,
    updateInternalNotes,
    updateStatus
  };
}

module.exports = {
  createBookingService
};
