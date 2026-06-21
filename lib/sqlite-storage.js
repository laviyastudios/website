const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  appendStatusHistory,
  bookingToSqliteRow,
  nowIso,
  sqliteRowToBooking
} = require("./booking-model");

function createSqliteStorage(options = {}) {
  const root = options.root || path.resolve(__dirname, "..");
  const dataDir = options.dataDir || path.join(root, "data");
  const dbPath = options.dbPath || path.join(dataDir, "laviya.sqlite");

  fs.mkdirSync(dataDir, { recursive: true });

  function runSql(sql, json = false) {
    const args = json ? ["-json", dbPath, sql] : [dbPath, sql];
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

  function columnExists(table, column) {
    return runSql(`PRAGMA table_info(${table});`, true).some((row) => row.name === column);
  }

  function ensureColumn(table, column, definition) {
    if (!columnExists(table, column)) {
      runSql(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    }
  }

  function init() {
    runSql(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_type TEXT NOT NULL,
        booking_date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        duration_hours INTEGER NOT NULL,
        guests INTEGER NOT NULL,
        addons TEXT NOT NULL DEFAULT '[]',
        client_name TEXT NOT NULL,
        client_email TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        cost INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'new',
        internal_notes TEXT NOT NULL DEFAULT '',
        source_channel TEXT NOT NULL DEFAULT 'web',
        status_history TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS client_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_email TEXT NOT NULL UNIQUE,
        client_name TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
    `);

    ensureColumn("bookings", "source_channel", "TEXT NOT NULL DEFAULT 'web'");
    ensureColumn("bookings", "status_history", "TEXT NOT NULL DEFAULT '[]'");
  }

  function createAdminUser(username, passwordHash) {
    runSql(`
      INSERT INTO admin_users (username, password_hash, created_at)
      VALUES (${q(username)}, ${q(passwordHash)}, ${q(nowIso())});
    `);
  }

  function resetAdminPassword(username, passwordHash) {
    runSql(`
      UPDATE admin_users
      SET password_hash = ${q(passwordHash)}
      WHERE username = ${q(username)};
    `);
  }

  function countAdminUsers() {
    return runSql("SELECT COUNT(*) AS total FROM admin_users;", true)[0]?.total || 0;
  }

  function getAdminUser(username) {
    return runSql(`SELECT * FROM admin_users WHERE username = ${q(username)} LIMIT 1;`, true)[0];
  }

  function createBooking(booking) {
    const row = bookingToSqliteRow(booking);
    runSql(`
      INSERT INTO bookings (
        session_type, booking_date, start_time, duration_hours, guests, addons,
        client_name, client_email, notes, cost, status, internal_notes,
        source_channel, status_history, created_at, updated_at
      ) VALUES (
        ${q(row.session_type)}, ${q(row.booking_date)}, ${q(row.start_time)}, ${q(row.duration_hours)}, ${q(row.guests)}, ${q(row.addons)},
        ${q(row.client_name)}, ${q(row.client_email)}, ${q(row.notes)}, ${q(row.cost)}, ${q(row.status)}, ${q(row.internal_notes)},
        ${q(row.source_channel)}, ${q(row.status_history)}, ${q(row.created_at)}, ${q(row.updated_at)}
      );
    `);
    const id = runSql("SELECT id FROM bookings ORDER BY id DESC LIMIT 1;", true)[0]?.id;
    return { ...booking, id };
  }

  function listBookingRows(status = "all") {
    const where = ["new", "accepted", "declined", "archived"].includes(status) ? `WHERE status = ${q(status)}` : "";
    return runSql(`
      SELECT * FROM bookings
      ${where}
      ORDER BY booking_date ASC, start_time ASC, created_at DESC;
    `, true);
  }

  function listBookings(status = "all") {
    return listBookingRows(status).map(sqliteRowToBooking);
  }

  function getBookingRow(id) {
    return runSql(`SELECT * FROM bookings WHERE id = ${q(Number(id))} LIMIT 1;`, true)[0];
  }

  function getBooking(id) {
    return sqliteRowToBooking(getBookingRow(id));
  }

  function updateBookingStatus(id, status, actor = "admin") {
    const booking = getBooking(id);
    if (!booking) return null;
    const updated = appendStatusHistory(booking, status, actor);
    runSql(`
      UPDATE bookings
      SET status = ${q(updated.status)},
          status_history = ${q(JSON.stringify(updated.statusHistory))},
          updated_at = ${q(updated.updatedAt)}
      WHERE id = ${q(Number(id))};
    `);
    return updated;
  }

  function updateBookingNotes(id, internalNotes) {
    runSql(`
      UPDATE bookings
      SET internal_notes = ${q(internalNotes || "")},
          updated_at = ${q(nowIso())}
      WHERE id = ${q(Number(id))};
    `);
    return getBooking(id);
  }

  function getClientHistoryRows(email) {
    return runSql(`
      SELECT id, session_type, booking_date, start_time, status, cost
      FROM bookings
      WHERE client_email = ${q(email)}
      ORDER BY booking_date DESC, start_time DESC;
    `, true);
  }

  function getClientNote(email) {
    return runSql(`SELECT * FROM client_notes WHERE client_email = ${q(email)} LIMIT 1;`, true)[0];
  }

  function upsertClientNote(email, name, note) {
    runSql(`
      INSERT INTO client_notes (client_email, client_name, note, updated_at)
      VALUES (${q(String(email || "").toLowerCase())}, ${q(name || "")}, ${q(note || "")}, ${q(nowIso())})
      ON CONFLICT(client_email) DO UPDATE SET
        client_name = excluded.client_name,
        note = excluded.note,
        updated_at = excluded.updated_at;
    `);
  }

  function latestBookingForClient(email) {
    return runSql(`SELECT id FROM bookings WHERE client_email = ${q(String(email || "").toLowerCase())} ORDER BY updated_at DESC LIMIT 1;`, true)[0];
  }

  function countsByStatus() {
    return runSql(`
      SELECT status, COUNT(*) AS total FROM bookings GROUP BY status
      UNION ALL SELECT 'all' AS status, COUNT(*) AS total FROM bookings;
    `, true).reduce((acc, row) => ({ ...acc, [row.status]: row.total }), {});
  }

  return {
    countAdminUsers,
    countsByStatus,
    createAdminUser,
    createBooking,
    getAdminUser,
    getBooking,
    getBookingRow,
    getClientHistoryRows,
    getClientNote,
    init,
    latestBookingForClient,
    listBookingRows,
    listBookings,
    q,
    resetAdminPassword,
    runSql,
    updateBookingNotes,
    updateBookingStatus,
    upsertClientNote
  };
}

module.exports = {
  createSqliteStorage
};
