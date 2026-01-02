const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();

// Configuration
const CACHE_TTL_DAYS = 3;
const DAILY_RATE_LIMIT = 20;

// IATA to ICAO carrier code mapping
const IATA_TO_ICAO = {
  'AA': 'AAL', 'AS': 'ASA', 'B6': 'JBU', 'DL': 'DAL',
  'F9': 'FFT', 'G4': 'AAY', 'HA': 'HAL', 'NK': 'NKS',
  'UA': 'UAL', 'WN': 'SWA', 'SY': 'SCX'
};

// ============================================================
// ENDPOINT: /register - Create new install token
// ============================================================
exports.register = functions.https.onRequest(async (req, res) => {
  // CORS headers
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Generate random install ID
  const installId = "ext_" + generateRandomId(16);
  const now = new Date();

  await db.collection("tokens").doc(installId).set({
    createdAt: admin.firestore.Timestamp.fromDate(now),
    lastUsed: admin.firestore.Timestamp.fromDate(now),
    usageToday: 0,
    usageDate: now.toISOString().split("T")[0],
    totalUsage: 0,
    tier: "free"
  });

  console.log(`Registered new install: ${installId}`);

  return res.status(200).json({
    installId: installId,
    dailyLimit: DAILY_RATE_LIMIT
  });
});

// ============================================================
// ENDPOINT: /lookup - Get delay stats for a flight
// ============================================================
exports.lookup = functions.https.onRequest(async (req, res) => {
  // CORS headers
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { installId, flightNumber, origin, destination } = req.body;

  // Validate required fields
  if (!installId || !flightNumber) {
    return res.status(400).json({
      error: "Missing required fields",
      required: ["installId", "flightNumber"]
    });
  }

  // 1. Validate token and check rate limit
  const tokenRef = db.collection("tokens").doc(installId);
  const tokenDoc = await tokenRef.get();

  if (!tokenDoc.exists) {
    return res.status(401).json({ error: "Invalid install token" });
  }

  const tokenData = tokenDoc.data();
  const today = new Date().toISOString().split("T")[0];

  // Reset counter if new day
  let usageToday = tokenData.usageToday;
  if (tokenData.usageDate !== today) {
    usageToday = 0;
  }

  // Check rate limit (only enforced for free tier)
  if (tokenData.tier === "free" && usageToday >= DAILY_RATE_LIMIT) {
    return res.status(429).json({
      error: "Daily limit reached",
      limit: DAILY_RATE_LIMIT,
      resetsAt: "midnight UTC"
    });
  }

  // 2. Check cache
  const normalizedFlight = flightNumber.replace(/\s+/g, "").toUpperCase();
  const cacheKey = normalizedFlight; // Just use flight number as key
  const cacheRef = db.collection("cache").doc(cacheKey);
  const cacheDoc = await cacheRef.get();

  if (cacheDoc.exists) {
    const cacheData = cacheDoc.data();
    const cacheAge = Date.now() - cacheData.fetchedAt.toDate().getTime();
    const cacheTTL = CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

    if (cacheAge < cacheTTL) {
      console.log(`Cache hit for ${cacheKey}`);
      return res.status(200).json({
        source: "cache",
        stats: cacheData.stats
      });
    }
  }

  // 3. Cache miss — call FlightAware API
  console.log(`Cache miss for ${cacheKey}, calling FlightAware API`);

  const FLIGHTAWARE_API_KEY = functions.config().flightaware?.key;
  if (!FLIGHTAWARE_API_KEY) {
    console.error("FlightAware API key not configured");
    return res.status(500).json({ error: "Server configuration error" });
  }

  let flightData;
  try {
    flightData = await fetchFromFlightAware(normalizedFlight, FLIGHTAWARE_API_KEY);
  } catch (err) {
    console.error("FlightAware API error:", err.message);
    return res.status(502).json({
      error: "Failed to fetch flight data",
      details: err.message
    });
  }

  // 4. Calculate stats
  const stats = calculateDelayStats(flightData.flights || []);

  if (stats.error) {
    return res.status(200).json({
      source: "api",
      stats: stats
    });
  }

  // 5. Update cache
  await cacheRef.set({
    fetchedAt: admin.firestore.Timestamp.now(),
    stats: stats,
    flightNumber: normalizedFlight
  });

  // 6. Update token usage (only count API calls, not cache hits)
  await tokenRef.update({
    lastUsed: admin.firestore.Timestamp.now(),
    usageToday: usageToday + 1,
    usageDate: today,
    totalUsage: admin.firestore.FieldValue.increment(1)
  });

  return res.status(200).json({
    source: "api",
    stats: stats,
    usage: {
      today: usageToday + 1,
      limit: DAILY_RATE_LIMIT
    }
  });
});

// ============================================================
// HELPER: Fetch from FlightAware
// ============================================================
async function fetchFromFlightAware(flightNumber, apiKey) {
  // Parse carrier and number
  const match = flightNumber.match(/^([A-Z]{2})(\d+)$/);
  if (!match) {
    throw new Error("Invalid flight number format");
  }

  const [, carrier, number] = match;
  const icaoCarrier = IATA_TO_ICAO[carrier];

  // Try ICAO format first, then IATA
  const identifiers = icaoCarrier
    ? [`${icaoCarrier}${number}`, `${carrier}${number}`]
    : [`${carrier}${number}`];

  // Build date range: last 7 days
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 7);
  const startStr = start.toISOString().split("T")[0];
  const endStr = end.toISOString().split("T")[0];

  for (const ident of identifiers) {
    const url = `https://aeroapi.flightaware.com/aeroapi/history/flights/${ident}?start=${startStr}&end=${endStr}`;
    console.log(`Fetching: ${url}`);

    const response = await fetch(url, {
      headers: { "x-apikey": apiKey }
    });

    console.log(`Response for ${ident}: ${response.status}`);

    if (response.status === 401) {
      throw new Error("Invalid FlightAware API key");
    }

    if (response.status === 429) {
      throw new Error("FlightAware rate limit exceeded");
    }

    if (response.status === 404) {
      continue; // Try next identifier
    }

    if (!response.ok) {
      continue;
    }

    const data = await response.json();
    if (data.flights && data.flights.length > 0) {
      console.log(`Found ${data.flights.length} flights for ${ident}`);
      return data;
    }
  }

  return { flights: [] };
}

// ============================================================
// HELPER: Calculate delay statistics
// ============================================================
function calculateDelayStats(flights) {
  if (!flights || flights.length === 0) {
    return {
      error: "No flight data available",
      insufficient_data: true
    };
  }

  // Filter out cancelled flights
  const validFlights = flights.filter(f => !f.cancelled);
  const cancelledCount = flights.filter(f => f.cancelled).length;

  if (validFlights.length < 3) {
    return {
      error: `Insufficient data (only ${validFlights.length} flights)`,
      insufficient_data: true,
      sample_size: validFlights.length
    };
  }

  // Calculate delays in minutes (arrival_delay is in seconds)
  const delays = validFlights
    .slice(0, 10)
    .map(f => (f.arrival_delay || 0) / 60);

  const sorted = [...delays].sort((a, b) => a - b);

  return {
    sample_size: delays.length,
    avg_delay: Math.round(delays.reduce((a, b) => a + b, 0) / delays.length),
    max_delay: Math.round(Math.max(...delays)),
    min_delay: Math.round(Math.min(...delays)),
    p25: Math.round(percentile(sorted, 25)),
    p75: Math.round(percentile(sorted, 75)),
    cancelled_count: cancelledCount
  };
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  if (sortedArr.length === 1) return sortedArr[0];
  const index = (p / 100) * (sortedArr.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedArr[lower];
  return sortedArr[lower] * (upper - index) + sortedArr[upper] * (index - lower);
}

function generateRandomId(length) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
