function createFirebaseStorage() {
  return {
    init() {
      throw new Error(
        "Firebase storage is not configured yet. Add Firebase Admin credentials and implement this adapter when switching BOOKING_STORAGE=firebase."
      );
    }
  };
}

const FIRESTORE_COLLECTIONS = {
  bookings: "Booking requests from web, app, and admin-created entries.",
  clients: "Client profiles keyed or indexed by email for CRM history.",
  clientNotes: "Private studio notes grouped by client email.",
  adminUsers: "Future staff metadata; Firebase Auth/custom claims should own authentication.",
  availability: "Optional future studio availability and blocked dates.",
  payments: "Optional future deposit/payment records.",
  notifications: "Optional future email/push notification audit trail."
};

module.exports = {
  FIRESTORE_COLLECTIONS,
  createFirebaseStorage
};
