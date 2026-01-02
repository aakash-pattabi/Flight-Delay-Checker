// Background service worker for Flight Delay Checker extension
// Calls Firebase backend for flight delay data

// ============================================================
// CONFIGURATION
// ============================================================

// TODO: Replace with your deployed Firebase Functions URL
const API_BASE = "https://us-central1-flight-delays-eb2cc.cloudfunctions.net";

const DEBUG = true;

function log(component, message, data = null) {
  if (!DEBUG) return;
  const prefix = `[FlightDelay] [BG] [${component}]`;
  if (data !== null) {
    console.log(prefix, message, data);
  } else {
    console.log(prefix, message);
  }
}

// ============================================================
// INSTALLATION & REGISTRATION
// ============================================================

// Register for install token on first install
chrome.runtime.onInstalled.addListener(async (details) => {
  log('Init', 'Extension installed', { reason: details.reason });

  if (details.reason === 'install') {
    await registerInstall();
  }
});

async function registerInstall() {
  log('Register', 'Registering new installation...');

  try {
    const response = await fetch(`${API_BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (response.ok) {
      const { installId, dailyLimit } = await response.json();
      await chrome.storage.local.set({
        installId,
        dailyLimit,
        usageToday: 0,
        cacheHits: 0
      });
      log('Register', 'Registration successful', { installId, dailyLimit });
    } else {
      log('Register', 'Registration failed', { status: response.status });
    }
  } catch (err) {
    log('Register', 'Registration error', err.message);
  }
}

// ============================================================
// MESSAGE HANDLER
// ============================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getDelayStats') {
    log('Message', 'Received getDelayStats request', {
      flightNumber: request.flightNumber,
      origin: request.origin,
      destination: request.destination
    });

    handleFlightLookup(request.flightNumber, request.origin, request.destination)
      .then(response => {
        log('Message', 'Sending response', response);
        sendResponse(response);
      })
      .catch(error => {
        log('Message', 'Handler error', error.message);
        sendResponse({ error: error.message });
      });

    return true; // Keep message channel open for async response
  }

  if (request.action === 'updateBadge') {
    const count = request.count || 0;
    const tabId = sender.tab?.id;
    if (count > 0) {
      chrome.action.setBadgeText({ text: count.toString(), tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#3b82f6', tabId });
    } else {
      chrome.action.setBadgeText({ text: '', tabId });
    }
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'updateBadgeColor') {
    const tabId = request.tabId;
    const color = request.hasDelayed ? '#ef4444' : '#22c55e'; // Red if delayed, green if on-time
    log('Badge', 'Updating badge color', { hasDelayed: request.hasDelayed, color });
    chrome.action.setBadgeBackgroundColor({ color, tabId });
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'getUsageStats') {
    chrome.storage.local.get(['installId', 'usageToday', 'cacheHits', 'dailyLimit'])
      .then(sendResponse);
    return true;
  }

  if (request.action === 'proactiveLookup') {
    const tabId = sender.tab?.id;
    const flights = request.flights || [];
    const route = request.route || {};

    log('Proactive', 'Starting proactive lookup', { count: flights.length, tabId });

    // Set badge count immediately
    if (flights.length > 0 && tabId) {
      chrome.action.setBadgeText({ text: flights.length.toString(), tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#3b82f6', tabId }); // Blue while loading
    }

    // Fetch delay data in background (don't block)
    proactiveFetchAll(flights, route, tabId);

    sendResponse({ success: true });
    return true;
  }
});

// ============================================================
// PROACTIVE LOOKUP (background fetch for badge color)
// ============================================================

async function proactiveFetchAll(flights, route, tabId) {
  if (!flights || flights.length === 0) return;

  const results = {};
  let hasDelayedFlight = false;
  let hasAnyData = false;

  // Fetch all flights in parallel
  const promises = flights.map(async (flight) => {
    const flightNumber = `${flight.carrier}${flight.number}`;
    const origin = route.origin || flight.origin;
    const destination = route.destination || flight.destination;

    try {
      const result = await handleFlightLookup(flightNumber, origin, destination);
      results[flightNumber] = result;

      if (result.stats && !result.stats.error) {
        hasAnyData = true;
        if (result.stats.avg_delay >= 30) {
          hasDelayedFlight = true;
        }
      }
    } catch (err) {
      log('Proactive', 'Error fetching', { flightNumber, error: err.message });
      results[flightNumber] = { error: err.message };
    }
  });

  await Promise.all(promises);

  // Store pre-fetched results
  await chrome.storage.local.set({ prefetched_results: results });

  log('Proactive', 'All lookups complete', {
    count: Object.keys(results).length,
    hasDelayed: hasDelayedFlight,
    hasData: hasAnyData
  });

  // Update badge color based on results
  if (tabId && hasAnyData) {
    const color = hasDelayedFlight ? '#ef4444' : '#22c55e'; // Red or green
    chrome.action.setBadgeBackgroundColor({ color, tabId });
    log('Proactive', 'Badge color updated', { color, hasDelayed: hasDelayedFlight });
  }
}

// ============================================================
// MAIN LOOKUP FUNCTION
// ============================================================

async function handleFlightLookup(flightNumber, origin, destination) {
  // Get install ID
  const data = await chrome.storage.local.get(['installId', 'usageToday', 'cacheHits']);

  if (!data.installId) {
    log('Lookup', 'No install ID, registering...');
    await registerInstall();
    const newData = await chrome.storage.local.get('installId');
    if (!newData.installId) {
      return { error: 'Failed to register' };
    }
    data.installId = newData.installId;
  }

  // Call Firebase backend
  try {
    log('API', 'Calling Firebase lookup', { flightNumber, origin, destination });

    const response = await fetch(`${API_BASE}/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installId: data.installId,
        flightNumber: flightNumber.replace(/\s+/g, ''),
        origin,
        destination
      })
    });

    const result = await response.json();

    log('API', 'Firebase response', {
      status: response.status,
      source: result.source,
      hasStats: !!result.stats
    });

    if (!response.ok) {
      return { error: result.error || 'API error', stats: null };
    }

    // Update local stats
    if (result.source === 'cache') {
      await chrome.storage.local.set({
        cacheHits: (data.cacheHits || 0) + 1
      });
    } else if (result.usage) {
      await chrome.storage.local.set({
        usageToday: result.usage.today
      });
    }

    return { stats: result.stats, fromCache: result.source === 'cache' };

  } catch (err) {
    log('API', 'Fetch error', err.message);
    return { error: 'Network error: ' + err.message };
  }
}

// ============================================================
// STARTUP
// ============================================================

log('Init', 'Background service worker loaded');

// Check if we need to register (in case onInstalled didn't fire)
chrome.storage.local.get('installId').then(data => {
  if (!data.installId) {
    log('Init', 'No install ID found, registering...');
    registerInstall();
  } else {
    log('Init', 'Install ID exists', { installId: data.installId });
  }
});
