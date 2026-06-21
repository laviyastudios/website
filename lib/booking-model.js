const BOOKING_STATUSES = ["new", "accepted", "declined", "archived"];
const BOOKING_SOURCES = ["web", "app", "admin"];

function nowIso() {
  return new Date().toISOString();
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

function normalizeBookingPayload(payload, options = {}) {
  const sessionType = String(payload.sessionType || payload.session_type || "").trim();
  const date = String(payload.date || payload.booking_date || "").trim();
  const time = String(payload.time || payload.start_time || "").trim();
  const duration = Number(payload.duration || payload.duration_hours);
  const guests = Number(payload.guests);
  const name = String(payload.name || payload.client_name || "").trim();
  const email = String(payload.email || payload.client_email || "").trim().toLowerCase();
  const notes = String(payload.notes || "").trim();
  const addons = normalizeAddons(payload.addons);
  const source = BOOKING_SOURCES.includes(options.source) ? options.source : "web";
  const timestamp = options.timestamp || nowIso();

  if (!sessionType) return { error: "Choose a session type." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Choose a valid date." };
  if (!/^\d{2}:\d{2}$/.test(time)) return { error: "Choose a valid start time." };
  if (![2, 3, 4, 8].includes(duration)) return { error: "Choose a valid duration." };
  if (!Number.isInteger(guests) || guests < 1 || guests > 20) return { error: "Enter the number of people on set." };
  if (!name) return { error: "Enter your name." };
  if (!validEmail(email)) return { error: "Enter a valid email." };

  return {
    booking: {
      id: null,
      source,
      status: "new",
      client: {
        name,
        email
      },
      session: {
        type: sessionType,
        date,
        startTime: time,
        durationHours: duration,
        guests,
        addons
      },
      pricing: {
        currency: "GBP",
        estimatedCost: bookingCost(duration)
      },
      notes: {
        client: notes,
        internal: ""
      },
      statusHistory: [
        {
          status: "new",
          at: timestamp,
          by: source
        }
      ],
      createdAt: timestamp,
      updatedAt: timestamp
    }
  };
}

function legacyBookingFromModel(booking) {
  return {
    sessionType: booking.session.type,
    date: booking.session.date,
    time: booking.session.startTime,
    duration: booking.session.durationHours,
    guests: booking.session.guests,
    addons: booking.session.addons,
    name: booking.client.name,
    email: booking.client.email,
    notes: booking.notes.client,
    cost: booking.pricing.estimatedCost,
    source: booking.source
  };
}

function sqliteRowToBooking(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source_channel || "web",
    status: row.status,
    client: {
      name: row.client_name,
      email: row.client_email
    },
    session: {
      type: row.session_type,
      date: row.booking_date,
      startTime: row.start_time,
      durationHours: Number(row.duration_hours),
      guests: Number(row.guests),
      addons: normalizeAddons(row.addons)
    },
    pricing: {
      currency: "GBP",
      estimatedCost: Number(row.cost)
    },
    notes: {
      client: row.notes || "",
      internal: row.internal_notes || ""
    },
    statusHistory: normalizeStatusHistory(row.status_history, row),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function bookingToSqliteRow(booking) {
  return {
    session_type: booking.session.type,
    booking_date: booking.session.date,
    start_time: booking.session.startTime,
    duration_hours: booking.session.durationHours,
    guests: booking.session.guests,
    addons: JSON.stringify(booking.session.addons),
    client_name: booking.client.name,
    client_email: booking.client.email,
    notes: booking.notes.client,
    cost: booking.pricing.estimatedCost,
    status: booking.status,
    internal_notes: booking.notes.internal,
    source_channel: booking.source,
    status_history: JSON.stringify(booking.statusHistory),
    created_at: booking.createdAt,
    updated_at: booking.updatedAt
  };
}

function normalizeStatusHistory(value, row = {}) {
  try {
    const parsed = JSON.parse(value || "[]");
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {
    // Fall through to a synthesized history for older SQLite rows.
  }

  return [
    {
      status: row.status || "new",
      at: row.created_at || nowIso(),
      by: row.source_channel || "web"
    }
  ];
}

function appendStatusHistory(booking, status, actor = "admin") {
  const timestamp = nowIso();
  return {
    ...booking,
    status,
    statusHistory: [
      ...(booking.statusHistory || []),
      {
        status,
        at: timestamp,
        by: actor
      }
    ],
    updatedAt: timestamp
  };
}

module.exports = {
  BOOKING_STATUSES,
  BOOKING_SOURCES,
  appendStatusHistory,
  bookingCost,
  bookingToSqliteRow,
  legacyBookingFromModel,
  normalizeAddons,
  normalizeBookingPayload,
  nowIso,
  sqliteRowToBooking,
  validEmail
};
