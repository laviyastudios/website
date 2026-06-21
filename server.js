const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createBookingService } = require("./lib/booking-service");
const { createFirebaseStorage } = require("./lib/firebase-storage");
const { createSqliteStorage } = require("./lib/sqlite-storage");
const { legacyBookingFromModel, normalizeBookingPayload } = require("./lib/booking-model");

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "laviya.sqlite");
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const DEFAULT_ADMIN_PASSWORD = "laviya-admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
const BOOKING_STORAGE = process.env.BOOKING_STORAGE || "sqlite";
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const sessions = new Map();

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8"
};

fs.mkdirSync(DATA_DIR, { recursive: true });

const storage = BOOKING_STORAGE === "firebase"
  ? createFirebaseStorage()
  : createSqliteStorage({ root: ROOT, dataDir: DATA_DIR, dbPath: DB_PATH });
const bookingService = createBookingService(storage);

function runSql(sql, json = false) {
  const args = json ? ["-json", DB_PATH, sql] : [DB_PATH, sql];
  const result = spawnSync("sqlite3", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || "sqlite3 command failed");
  }
  if (!json) return [];
  const trimmed = result.stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

function q(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function nowIso() {
  return new Date().toISOString();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || "").split(":");
  if (!salt || !expected) return false;
  const actual = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256");
  const expectedBuffer = Buffer.from(expected, "hex");
  return expectedBuffer.length === actual.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

function initDb() {
  storage.init();

  const count = storage.countAdminUsers();
  if (count === 0) {
    storage.createAdminUser(ADMIN_USERNAME, hashPassword(ADMIN_PASSWORD));
    if (!process.env.ADMIN_PASSWORD) {
      console.log("Admin login created: username 'admin', password 'laviya-admin'. Set ADMIN_PASSWORD before using this publicly.");
    }
  } else if (process.env.RESET_ADMIN_PASSWORD === "1" && process.env.ADMIN_PASSWORD) {
    storage.resetAdminPassword(ADMIN_USERNAME, hashPassword(process.env.ADMIN_PASSWORD));
    console.log(`Admin password reset for '${ADMIN_USERNAME}'.`);
  }
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map((part) => {
    const [key, ...rest] = part.trim().split("=");
    return [key, decodeURIComponent(rest.join("="))];
  }));
}

function currentAdmin(req) {
  const token = parseCookies(req).laviya_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session.username;
}

function send(res, status, body, type = "text/html; charset=utf-8", headers = {}) {
  res.writeHead(status, { "Content-Type": type, ...headers });
  res.end(body);
}

function json(res, status, body, headers = {}) {
  send(res, status, JSON.stringify(body), "application/json; charset=utf-8", headers);
}

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

function notFound(res) {
  send(res, 404, "Not found", "text/plain; charset=utf-8");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function parseBody(req) {
  const raw = await readBody(req);
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("application/json")) return JSON.parse(raw || "{}");
  return Object.fromEntries(new URLSearchParams(raw));
}

function htmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function bookingCost(hours) {
  const duration = Number(hours);
  if (duration === 4) return 220;
  if (duration === 8) return 390;
  return duration * 65;
}

function normalizeAddons(value) {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return String(value).split(",").map((item) => item.trim()).filter(Boolean);
  }
}

function validateBooking(payload) {
  const sessionType = String(payload.sessionType || payload.session_type || "").trim();
  const date = String(payload.date || payload.booking_date || "").trim();
  const time = String(payload.time || payload.start_time || "").trim();
  const duration = Number(payload.duration || payload.duration_hours);
  const guests = Number(payload.guests);
  const name = String(payload.name || payload.client_name || "").trim();
  const email = String(payload.email || payload.client_email || "").trim().toLowerCase();
  const notes = String(payload.notes || "").trim();
  const addons = normalizeAddons(payload.addons);

  if (!sessionType) return { error: "Choose a session type." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Choose a valid date." };
  if (!/^\d{2}:\d{2}$/.test(time)) return { error: "Choose a valid start time." };
  if (![2, 3, 4, 8].includes(duration)) return { error: "Choose a valid duration." };
  if (!Number.isInteger(guests) || guests < 1 || guests > 20) return { error: "Enter the number of people on set." };
  if (!name) return { error: "Enter your name." };
  if (!validEmail(email)) return { error: "Enter a valid email." };

  return {
    booking: {
      sessionType,
      date,
      time,
      duration,
      guests,
      name,
      email,
      notes,
      addons,
      cost: bookingCost(duration)
    }
  };
}

function insertBooking(booking) {
  const timestamp = nowIso();
  runSql(`
    INSERT INTO bookings (
      session_type, booking_date, start_time, duration_hours, guests, addons,
      client_name, client_email, notes, cost, status, internal_notes, created_at, updated_at
    ) VALUES (
      ${q(booking.sessionType)}, ${q(booking.date)}, ${q(booking.time)}, ${q(booking.duration)}, ${q(booking.guests)}, ${q(JSON.stringify(booking.addons))},
      ${q(booking.name)}, ${q(booking.email)}, ${q(booking.notes)}, ${q(booking.cost)}, 'new', '', ${q(timestamp)}, ${q(timestamp)}
    );
  `);
  return runSql("SELECT id FROM bookings ORDER BY id DESC LIMIT 1;", true)[0]?.id;
}

function getBookings(status = "all") {
  return bookingService.listBookingRows(status);
}

function getBooking(id) {
  return bookingService.getBookingRow(id);
}

function getClientHistory(email) {
  return bookingService.getClientHistory(email);
}

function getClientNote(email) {
  return bookingService.getClientNote(email);
}

function layout(title, content) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${htmlEscape(title)} | Laviya Studios</title>
    <link rel="stylesheet" href="/styles.css">
    <link rel="stylesheet" href="/admin.css">
  </head>
  <body class="admin-body">
    <header class="site-header admin-header">
      <a class="brand" href="/"><img src="/assets/laviya-logo-ivory.svg" alt="Laviya Studios"></a>
      <nav aria-label="Admin navigation">
        <a href="/admin">Bookings</a>
        <a href="/">Website</a>
      </nav>
      <form method="post" action="/admin/logout"><button class="header-action" type="submit">Log out</button></form>
    </header>
    ${content}
  </body>
</html>`;
}

function loginPage(error = "") {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Admin Login | Laviya Studios</title>
    <link rel="stylesheet" href="/styles.css">
    <link rel="stylesheet" href="/admin.css">
    <style>
      .login-body {
        min-height: 100vh;
        display: grid;
        place-items: start center;
        padding: clamp(32px, 7vh, 72px) 20px 32px;
        color: var(--ink);
        background: var(--olive-deep);
      }

      .login-panel {
        width: min(480px, 100%);
        padding: clamp(24px, 5vw, 42px);
        color: var(--ink);
        background: var(--linen);
        border: 1px solid var(--line);
        box-shadow: 0 18px 60px rgba(61, 64, 53, 0.08);
      }

      .login-panel img {
        width: 142px;
        padding: 14px;
        margin: 0 auto 28px;
        background: var(--olive-deep);
      }

      .login-panel h1 {
        margin-bottom: 24px;
        font-size: clamp(2.35rem, 6vw, 3.8rem);
      }

      .login-panel .admin-form {
        gap: 18px;
      }

      .login-panel .admin-form input {
        min-height: 58px;
        padding: 16px 18px;
      }

      .login-panel .admin-form button {
        margin-top: 10px;
      }

      @media (max-width: 640px) {
        .login-body {
          padding-top: 24px;
        }

        .login-panel img {
          width: 128px;
        }
      }
    </style>
  </head>
  <body class="admin-body login-body">
    <main class="login-panel">
      <img src="/assets/laviya-logo-ivory.svg" alt="Laviya Studios">
      <p class="eyebrow">Admin access</p>
      <h1>Studio CRM login.</h1>
      ${error ? `<p class="admin-error">${htmlEscape(error)}</p>` : ""}
      <form method="post" action="/admin/login" class="admin-form">
        <label>Username <input name="username" autocomplete="username" required></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
        <button class="button primary" type="submit">Log in</button>
      </form>
    </main>
  </body>
</html>`;
}

function statusBadge(status) {
  return `<span class="status-badge status-${htmlEscape(status)}">${htmlEscape(status)}</span>`;
}

function mailtoFor(booking, type) {
  const accepted = type === "accepted";
  const subject = encodeURIComponent(`Laviya Studios booking ${accepted ? "accepted" : "update"}`);
  const body = encodeURIComponent([
    `Hi ${booking.client_name},`,
    "",
    accepted
      ? `Thank you for your ${booking.session_type} request. We are happy to confirm ${booking.booking_date} at ${booking.start_time}.`
      : `Thank you for your ${booking.session_type} request. We wanted to follow up about ${booking.booking_date} at ${booking.start_time}.`,
    "",
    "Laviya Studios"
  ].join("\n"));
  return `mailto:${booking.client_email}?subject=${subject}&body=${body}`;
}

function calendarMonth(value) {
  const now = new Date();
  const fallback = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return /^\d{4}-\d{2}$/.test(String(value || "")) ? value : fallback;
}

function addMonths(month, offset) {
  const [year, monthIndex] = month.split("-").map(Number);
  const date = new Date(year, monthIndex - 1 + offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(month) {
  const [year, monthIndex] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date(year, monthIndex - 1, 1));
}

function renderBookingCalendar(bookings, month, status) {
  const [year, monthIndex] = month.split("-").map(Number);
  const firstDay = new Date(year, monthIndex - 1, 1);
  const daysInMonth = new Date(year, monthIndex, 0).getDate();
  const startOffset = (firstDay.getDay() + 6) % 7;
  const monthBookings = bookings.reduce((acc, booking) => {
    if (!booking.booking_date.startsWith(month)) return acc;
    acc[booking.booking_date] = acc[booking.booking_date] || [];
    acc[booking.booking_date].push(booking);
    return acc;
  }, {});
  const cells = [];

  for (let index = 0; index < startOffset; index += 1) {
    cells.push(`<div class="calendar-cell calendar-cell-muted" aria-hidden="true"></div>`);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    const dayBookings = monthBookings[date] || [];
    const entries = dayBookings.map((booking) => `
      <a class="calendar-booking status-${htmlEscape(booking.status)}" href="/admin/bookings/${booking.id}">
        <span>${htmlEscape(booking.start_time)}</span>
        <strong>${htmlEscape(booking.client_name)}</strong>
        <em>${htmlEscape(booking.session_type)}</em>
      </a>
    `).join("");

    cells.push(`
      <div class="calendar-cell${dayBookings.length ? " has-bookings" : ""}">
        <div class="calendar-date">${day}</div>
        <div class="calendar-events">${entries}</div>
      </div>
    `);
  }

  const statusQuery = status === "all" ? "" : `&status=${encodeURIComponent(status)}`;
  const viewQuery = "&view=calendar";
  const previous = `/admin?month=${addMonths(month, -1)}${statusQuery}${viewQuery}`;
  const next = `/admin?month=${addMonths(month, 1)}${statusQuery}${viewQuery}`;

  return `
    <section class="calendar-panel" aria-label="Booking calendar">
      <div class="calendar-header">
        <div>
          <p class="eyebrow">Calendar view</p>
          <h2>${htmlEscape(monthLabel(month))}</h2>
        </div>
        <div class="calendar-controls">
          <a class="filter-pill" href="${previous}">Previous</a>
          <a class="filter-pill" href="/admin?view=calendar${status === "all" ? "" : `&status=${encodeURIComponent(status)}`}">This month</a>
          <a class="filter-pill" href="${next}">Next</a>
        </div>
      </div>
      <div class="calendar-weekdays" aria-hidden="true">
        <span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span>
      </div>
      <div class="calendar-grid">${cells.join("")}</div>
    </section>
  `;
}

function renderDashboard(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const status = url.searchParams.get("status") || "all";
  const month = calendarMonth(url.searchParams.get("month"));
  const view = url.searchParams.get("view") === "list" ? "list" : "calendar";
  const bookings = getBookings(status);
  const counts = bookingService.countsByStatus();

  const filters = ["all", "new", "accepted", "declined", "archived"].map((item) => {
    const active = item === status ? " active" : "";
    return `<a class="filter-pill${active}" href="/admin?status=${item}&month=${month}&view=${view}">${item} (${counts[item] || 0})</a>`;
  }).join("");

  const switcher = `
    <section class="view-switcher" aria-label="Choose booking view">
      <a class="view-pill${view === "calendar" ? " active" : ""}" href="/admin?status=${status}&month=${month}&view=calendar">Calendar view</a>
      <a class="view-pill${view === "list" ? " active" : ""}" href="/admin?status=${status}&month=${month}&view=list">List view</a>
    </section>
  `;

  const rows = bookings.map((booking) => `
    <article class="booking-card">
      <div>
        <div class="booking-card-top">
          ${statusBadge(booking.status)}
          <span>${htmlEscape(booking.booking_date)} at ${htmlEscape(booking.start_time)}</span>
        </div>
        <h2>${htmlEscape(booking.session_type)}</h2>
        <p>${htmlEscape(booking.client_name)} · ${htmlEscape(booking.client_email)}</p>
        <p>${htmlEscape(booking.duration_hours)} hours · ${htmlEscape(booking.guests)} people · £${htmlEscape(booking.cost)}</p>
      </div>
      <div class="booking-actions">
        <a class="button primary" href="/admin/bookings/${booking.id}">Review</a>
        ${booking.status === "accepted" ? `<a class="admin-link" href="/admin/bookings/${booking.id}/calendar">Calendar</a>` : ""}
      </div>
    </article>
  `).join("") || `<div class="empty-state">No bookings in this view yet.</div>`;

  return layout("Admin bookings", `
    <main class="admin-shell">
      <section class="admin-title">
        <p class="eyebrow">Booking CRM</p>
        <h1>Manage studio requests.</h1>
        <p>Review new enquiries, update booking status, keep notes and export confirmed sessions to your calendar.</p>
      </section>
      ${switcher}
      <section class="admin-filters">${filters}</section>
      ${view === "calendar" ? renderBookingCalendar(bookings, month, status) : `<section class="booking-list">${rows}</section>`}
    </main>
  `);
}

function renderBookingDetail(id) {
  const booking = getBooking(id);
  if (!booking) return null;
  const addons = normalizeAddons(booking.addons);
  const history = getClientHistory(booking.client_email);
  const clientNote = getClientNote(booking.client_email);
  const historyRows = history.map((item) => `
    <li><a href="/admin/bookings/${item.id}">${htmlEscape(item.booking_date)} · ${htmlEscape(item.session_type)}</a> ${statusBadge(item.status)}</li>
  `).join("");

  return layout(`Booking #${booking.id}`, `
    <main class="admin-shell detail-shell">
      <a class="admin-link" href="/admin">Back to bookings</a>
      <section class="detail-grid">
        <article class="detail-panel">
          <div class="booking-card-top">${statusBadge(booking.status)}<span>Request #${booking.id}</span></div>
          <h1>${htmlEscape(booking.session_type)}</h1>
          <dl class="detail-list">
            <div><dt>Client</dt><dd>${htmlEscape(booking.client_name)} · <a href="mailto:${htmlEscape(booking.client_email)}">${htmlEscape(booking.client_email)}</a></dd></div>
            <div><dt>Date</dt><dd>${htmlEscape(booking.booking_date)} at ${htmlEscape(booking.start_time)}</dd></div>
            <div><dt>Duration</dt><dd>${htmlEscape(booking.duration_hours)} hours</dd></div>
            <div><dt>People</dt><dd>${htmlEscape(booking.guests)}</dd></div>
            <div><dt>Add-ons</dt><dd>${addons.length ? htmlEscape(addons.join(", ")) : "None selected"}</dd></div>
            <div><dt>Estimate</dt><dd>£${htmlEscape(booking.cost)}</dd></div>
            <div><dt>Brief</dt><dd>${htmlEscape(booking.notes || "No brief added.")}</dd></div>
          </dl>
          <div class="status-actions">
            ${["accepted", "declined", "archived", "new"].map((status) => `
              <form method="post" action="/admin/bookings/${booking.id}/status">
                <input type="hidden" name="status" value="${status}">
                <button class="button ${status === "accepted" ? "primary" : "secondary-admin"}" type="submit">${status}</button>
              </form>
            `).join("")}
          </div>
          <div class="status-actions">
            <a class="admin-link" href="${mailtoFor(booking, booking.status)}">Open client email draft</a>
            ${booking.status === "accepted" ? `<a class="admin-link" href="/admin/bookings/${booking.id}/calendar">Download calendar event</a>` : ""}
          </div>
        </article>

        <aside class="detail-panel">
          <h2>Internal notes</h2>
          <form class="admin-form" method="post" action="/admin/bookings/${booking.id}/notes">
            <label>Booking notes <textarea name="internal_notes" rows="5">${htmlEscape(booking.internal_notes)}</textarea></label>
            <button class="button primary" type="submit">Save booking notes</button>
          </form>

          <h2>Client history</h2>
          <ul class="history-list">${historyRows}</ul>
          <form class="admin-form" method="post" action="/admin/client-notes">
            <input type="hidden" name="client_email" value="${htmlEscape(booking.client_email)}">
            <input type="hidden" name="client_name" value="${htmlEscape(booking.client_name)}">
            <label>Client notes <textarea name="note" rows="5">${htmlEscape(clientNote?.note || "")}</textarea></label>
            <button class="button primary" type="submit">Save client notes</button>
          </form>
        </aside>
      </section>
    </main>
  `);
}

function icsEscape(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\n/g, "\\n");
}

function addHours(time, hours) {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + Number(hours) * 60;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}${String(total % 60).padStart(2, "0")}00`;
}

function renderIcs(booking) {
  const date = booking.booking_date.replace(/-/g, "");
  const start = `${date}T${booking.start_time.replace(":", "")}00`;
  const end = `${date}T${addHours(booking.start_time, booking.duration_hours)}`;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Laviya Studios//Booking CRM//EN",
    "BEGIN:VEVENT",
    `UID:laviya-booking-${booking.id}@laviyastudios.com`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${icsEscape(`Laviya Studios - ${booking.session_type}`)}`,
    `DESCRIPTION:${icsEscape(`${booking.client_name} (${booking.client_email})\\n${booking.notes || ""}`)}`,
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(ROOT, relative);
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return notFound(res);
  }
  const ext = path.extname(filePath);
  send(res, 200, fs.readFileSync(filePath), MIME[ext] || "application/octet-stream");
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "POST" && url.pathname === "/api/bookings") {
      const payload = await parseBody(req);
      const result = bookingService.submitBooking(payload, { source: "web" });
      if (result.error) {
        return json(res, 400, { ok: false, error: result.error });
      }
      return json(res, 201, {
        ok: true,
        id: result.booking.id,
        booking: result.legacyBooking
      });
    }

    if (req.method === "POST" && url.pathname === "/api/v1/bookings") {
      const payload = await parseBody(req);
      const result = bookingService.submitBooking(payload, { source: payload.source === "app" ? "app" : "web" });
      if (result.error) {
        return json(res, 400, { ok: false, error: result.error });
      }
      return json(res, 201, { ok: true, booking: result.booking });
    }

    if (req.method === "GET" && url.pathname === "/api/v1/availability") {
      return json(res, 200, {
        ok: true,
        availability: {
          mode: "request-only",
          message: "Availability is reviewed manually by Laviya Studios before a booking is confirmed."
        }
      });
    }

    if (url.pathname.startsWith("/api/v1/admin") && !currentAdmin(req)) {
      return json(res, 401, { ok: false, error: "Admin login required." });
    }

    if (req.method === "GET" && url.pathname === "/api/v1/admin/bookings") {
      const status = url.searchParams.get("status") || "all";
      return json(res, 200, { ok: true, bookings: bookingService.listBookings(status) });
    }

    const apiStatusMatch = url.pathname.match(/^\/api\/v1\/admin\/bookings\/(\d+)\/status$/);
    if (apiStatusMatch && req.method === "PATCH") {
      const body = await parseBody(req);
      const result = bookingService.updateStatus(apiStatusMatch[1], String(body.status || ""), "admin");
      if (result.error) return json(res, result.error === "Booking not found." ? 404 : 400, { ok: false, error: result.error });
      return json(res, 200, { ok: true, booking: result.booking });
    }

    if (req.method === "GET" && url.pathname === "/api/v1/admin/firestore-export") {
      return json(res, 200, { ok: true, export: bookingService.exportForFirestore() });
    }

    if (url.pathname === "/admin/login" && req.method === "GET") {
      if (currentAdmin(req)) return redirect(res, "/admin");
      return send(res, 200, loginPage(url.searchParams.get("error") || ""));
    }

    if (url.pathname === "/admin/login" && req.method === "POST") {
      const body = await parseBody(req);
      const user = storage.getAdminUser(body.username);
      if (!user || !verifyPassword(body.password, user.password_hash)) {
        return send(res, 401, loginPage("Those login details were not recognised."));
      }
      const token = crypto.randomBytes(32).toString("hex");
      sessions.set(token, { username: user.username, expiresAt: Date.now() + SESSION_TTL_MS });
      res.writeHead(303, {
        Location: "/admin",
        "Set-Cookie": `laviya_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
      });
      return res.end();
    }

    if (url.pathname === "/admin/logout" && req.method === "POST") {
      const token = parseCookies(req).laviya_session;
      if (token) sessions.delete(token);
      res.writeHead(303, {
        Location: "/admin/login",
        "Set-Cookie": "laviya_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
      });
      return res.end();
    }

    if (url.pathname.startsWith("/admin") && !currentAdmin(req)) {
      return redirect(res, "/admin/login");
    }

    if (url.pathname === "/admin" && req.method === "GET") {
      return send(res, 200, renderDashboard(req));
    }

    const detailMatch = url.pathname.match(/^\/admin\/bookings\/(\d+)$/);
    if (detailMatch && req.method === "GET") {
      const page = renderBookingDetail(detailMatch[1]);
      return page ? send(res, 200, page) : notFound(res);
    }

    const statusMatch = url.pathname.match(/^\/admin\/bookings\/(\d+)\/status$/);
    if (statusMatch && req.method === "POST") {
      const body = await parseBody(req);
      const status = String(body.status || "");
      const result = bookingService.updateStatus(statusMatch[1], status, "admin");
      if (result.error) return notFound(res);
      return redirect(res, `/admin/bookings/${statusMatch[1]}`);
    }

    const notesMatch = url.pathname.match(/^\/admin\/bookings\/(\d+)\/notes$/);
    if (notesMatch && req.method === "POST") {
      const body = await parseBody(req);
      bookingService.updateInternalNotes(notesMatch[1], body.internal_notes || "");
      return redirect(res, `/admin/bookings/${notesMatch[1]}`);
    }

    if (url.pathname === "/admin/client-notes" && req.method === "POST") {
      const body = await parseBody(req);
      const booking = bookingService.saveClientNote(body.client_email, body.client_name, body.note);
      return redirect(res, booking ? `/admin/bookings/${booking.id}` : "/admin");
    }

    const calendarMatch = url.pathname.match(/^\/admin\/bookings\/(\d+)\/calendar$/);
    if (calendarMatch && req.method === "GET") {
      const booking = getBooking(calendarMatch[1]);
      if (!booking) return notFound(res);
      if (booking.status !== "accepted") return send(res, 409, "Only accepted bookings can be exported.", "text/plain; charset=utf-8");
      return send(res, 200, renderIcs(booking), "text/calendar; charset=utf-8", {
        "Content-Disposition": `attachment; filename="laviya-booking-${booking.id}.ics"`
      });
    }

    if (req.method === "GET") return serveStatic(req, res);
    notFound(res);
  } catch (error) {
    console.error(error);
    send(res, 500, "Something went wrong.", "text/plain; charset=utf-8");
  }
}

if (require.main === module) {
  initDb();
  http.createServer(handle).listen(PORT, HOST, () => {
    console.log(`Laviya Studios server running on ${HOST}:${PORT}`);
  });
}

module.exports = {
  bookingService,
  initDb,
  storage,
  validateBooking: (payload) => {
    const result = normalizeBookingPayload(payload, { source: "web" });
    if (result.error) return result;
    return { booking: legacyBookingFromModel(result.booking) };
  },
  insertBooking: (booking) => bookingService.submitBooking(booking, { source: booking.source || "web" }).booking.id,
  getBooking,
  getClientHistory,
  renderIcs
};
