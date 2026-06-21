# Laviya Studios Live Deployment

## Recommended First Launch Setup

Use a Docker-capable web host with a persistent disk. Render is a straightforward option for this project because it can run the Node server and attach a persistent disk for the SQLite database.

This site is not static-only. It needs the Node server running because bookings, admin login, CRM pages, calendar view, and future app API routes all live behind the backend.

## Render Setup

1. Push this `studio-booking-site` folder to a GitHub repository.
2. In Render, create a new Web Service.
3. Choose Docker as the runtime.
4. Set the root directory to this folder if the repository contains more than this site.
5. Add a persistent disk:
   - Mount path: `/var/data`
   - Size: start with the smallest paid disk available.
6. Add environment variables:
   - `NODE_ENV=production`
   - `HOST=0.0.0.0`
   - `DATA_DIR=/var/data`
   - `ADMIN_USERNAME=admin`
   - `ADMIN_PASSWORD=<choose-a-strong-password>`
   - `RESET_ADMIN_PASSWORD=1` for the first deploy only, or whenever changing the admin password.
7. Deploy.
8. Open the Render URL and test:
   - Homepage
   - Booking form
   - `/admin/login`
   - Admin calendar/list views

After the admin password is set, remove `RESET_ADMIN_PASSWORD` or set it to `0`.

## Domain Setup

In your host dashboard, add your custom domain. Then update DNS at your domain provider using the records the host gives you.

Usually this means:

- `www` points to the host target using a `CNAME`.
- The root domain points to the host using either an `A` record, `ALIAS`, `ANAME`, or flattened `CNAME`, depending on your domain provider.

After DNS is connected, the host should issue an SSL certificate automatically. Wait for the domain to show as verified before sharing it publicly.

## Important Notes

- Do not deploy this as a static site. The booking backend will not work.
- Do not store the live SQLite database inside the source folder. Use `DATA_DIR=/var/data` with a persistent disk.
- Keep `ADMIN_PASSWORD` private.
- The first live booking should be a test booking that you submit yourself, then accept/decline from the admin dashboard.
- The future app-ready API is already available at `/api/v1`.

## Future Firebase Move

When you are ready to move away from SQLite:

1. Log in as admin.
2. Export data from `/api/v1/admin/firestore-export`.
3. Import that data into Firestore.
4. Implement the Firebase adapter in `lib/firebase-storage.js`.
5. Run with `BOOKING_STORAGE=firebase`.
