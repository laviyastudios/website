# Laviya Studios Backend Notes

## Current Mode

The website currently runs with the SQLite storage adapter:

```bash
npm start
```

Bookings still submit through `POST /api/bookings`, and the admin dashboard still uses the same login/session flow as before.

## Future App API

The app-ready API starts at `/api/v1`:

- `POST /api/v1/bookings`
- `GET /api/v1/availability`
- `GET /api/v1/admin/bookings`
- `PATCH /api/v1/admin/bookings/:id/status`
- `GET /api/v1/admin/firestore-export`

Admin API routes currently use the existing admin session cookie. A later Firebase phase should replace this with Firebase Auth custom claims for staff/admin users.

## Firebase-Ready Model

Bookings are normalized into a Firebase-ready document shape with:

- `source`: `web`, `app`, or `admin`
- `status`: `new`, `accepted`, `declined`, or `archived`
- `client`
- `session`
- `pricing`
- `notes`
- `statusHistory`
- `createdAt` and `updatedAt`

Planned Firestore collections:

- `bookings`
- `clients`
- `clientNotes`
- `adminUsers`
- `availability`
- `payments`
- `notifications`

## Migration Path

SQLite remains the default storage while the website is local/lightweight. When Firebase credentials and hosting are ready:

1. Export current data from the admin-only route: `/api/v1/admin/firestore-export`.
2. Import the JSON into Firestore collections.
3. Implement `lib/firebase-storage.js` behind the existing storage adapter methods.
4. Run the server with `BOOKING_STORAGE=firebase`.
5. Move admin authentication to Firebase Auth custom claims.
