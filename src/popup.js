// Popup script for Flight Delay Checker extension

document.addEventListener('DOMContentLoaded', async () => {
  const subtitle = document.getElementById('subtitle');
  const routeBadge = document.getElementById('routeBadge');
  const emptyState = document.getElementById('emptyState');
  const flightList = document.getElementById('flightList');
  const statusDot = document.getElementById('statusDot');
  const connectionStatus = document.getElementById('connectionStatus');
  const searchStats = document.getElementById('searchStats');

  // IATA to ICAO carrier mapping for FlightAware URLs (must be defined before use)
  const IATA_TO_ICAO = {
    'AA': 'AAL', 'AS': 'ASA', 'B6': 'JBU', 'DL': 'DAL',
    'F9': 'FFT', 'G4': 'AAY', 'HA': 'HAL', 'NK': 'NKS',
    'UA': 'UAL', 'WN': 'SWA', 'SY': 'SCX', 'QF': 'QFA',
    'BA': 'BAW', 'LH': 'DLH', 'AF': 'AFR', 'KL': 'KLM'
  };

  function buildFlightAwareUrl(carrier, number) {
    const icao = IATA_TO_ICAO[carrier] || carrier;
    return `https://www.flightaware.com/live/flight/${icao}${number}`;
  }

  function buildFlightStatsUrl(carrier, number, origin) {
    const originCode = origin || '';
    return `https://www.flightstats.com/v2/flight-ontime-performance-rating/${carrier}/${number}/${originCode}`;
  }

  // Track flight delay status for badge color
  let totalFlights = 0;
  let loadedFlights = 0;
  let hasDelayedFlight = false;

  // Initialize
  await updateUsageStats();
  await loadFlights();

  async function updateUsageStats() {
    try {
      const data = await chrome.storage.local.get(['installId', 'usageToday', 'cacheHits', 'dailyLimit']);

      if (data.installId) {
        statusDot.classList.remove('disconnected');
        connectionStatus.textContent = 'Connected';
      } else {
        statusDot.classList.add('disconnected');
        connectionStatus.textContent = 'Not registered';
      }

      const apiCalls = data.usageToday || 0;
      const cacheHits = data.cacheHits || 0;
      const totalSearches = apiCalls + cacheHits;

      if (totalSearches === 0) {
        searchStats.textContent = '0 searches';
      } else {
        searchStats.textContent = `${totalSearches} searches (${apiCalls} API, ${cacheHits} cached)`;
      }
    } catch (e) {
      console.error('Failed to get usage stats:', e);
    }
  }

  async function loadFlights() {
    // Try to get flights from storage (set by content script)
    const stored = await chrome.storage.local.get(['detected_flights', 'route']);

    let flights = stored.detected_flights || [];
    let route = stored.route || { origin: null, destination: null };

    // Also try to query the active tab directly
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && tab.url.includes('google.com/travel/flights')) {
        const response = await chrome.tabs.sendMessage(tab.id, { action: 'getDetectedFlights' });
        if (response && response.flights) {
          flights = response.flights;
          route = response.route;
        }
      }
    } catch (e) {
      // Content script might not be ready, use stored data
    }

    // Update UI
    if (route.origin && route.destination) {
      routeBadge.textContent = `${route.origin} → ${route.destination}`;
      routeBadge.style.display = 'block';
    }

    if (flights.length === 0) {
      subtitle.textContent = 'No flights found';
      emptyState.classList.add('visible');
      flightList.classList.remove('visible');
      return;
    }

    subtitle.textContent = `${flights.length} flight${flights.length > 1 ? 's' : ''} detected`;
    emptyState.classList.remove('visible');
    emptyState.style.display = 'none';
    flightList.classList.add('visible');
    flightList.style.display = 'block';
    flightList.innerHTML = '';

    // Reset tracking for badge color
    totalFlights = flights.length;
    loadedFlights = 0;
    hasDelayedFlight = false;

    // Create flight cards
    for (const flight of flights) {
      const card = createFlightCard(flight, route);
      flightList.appendChild(card);
      fetchDelayData(card, flight, route);
    }
  }

  function createFlightCard(flight, route) {
    const card = document.createElement('div');
    card.className = 'flight-card';
    card.dataset.flight = `${flight.carrier}${flight.number}`;
    card.dataset.carrier = flight.carrier;
    card.dataset.number = flight.number;
    card.dataset.origin = route.origin || '';

    // Build FlightAware and FlightStats URLs
    const flightAwareUrl = buildFlightAwareUrl(flight.carrier, flight.number);
    const flightStatsUrl = buildFlightStatsUrl(flight.carrier, flight.number, route.origin);

    card.innerHTML = `
      <div class="flight-header">
        <span class="flight-number">${flight.displayName}</span>
        <span class="flight-status loading"><span class="spinner"></span>Loading...</span>
      </div>
      <div class="flight-details">
        <div class="stat-grid">
          <div class="stat-item">
            <div class="stat-label">Avg. Delay</div>
            <div class="stat-value" id="avgDelay">--</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Max Delay</div>
            <div class="stat-value" id="maxDelay">--</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Typical Delay Range</div>
            <div class="stat-value" id="delayRange">--</div>
          </div>
          <div class="stat-item">
            <div class="stat-label">Sample Size</div>
            <div class="stat-value" id="sampleSize">--</div>
          </div>
        </div>
        <div class="flight-footer" id="flightFooter">
          <span class="flight-footer-left" id="footerText"></span>
          <span class="data-links">
            Raw Data: <a href="${flightAwareUrl}" target="_blank" title="View on FlightAware">FlightAware</a> | <a href="${flightStatsUrl}" target="_blank" title="View on FlightStats">FlightStats</a>
          </span>
        </div>
      </div>
    `;

    // Toggle expanded state on click (but not on link clicks)
    card.addEventListener('click', (e) => {
      if (e.target.tagName !== 'A') {
        card.classList.toggle('expanded');
      }
    });

    return card;
  }

  async function fetchDelayData(card, flight, route) {
    const flightNumber = `${flight.carrier}${flight.number}`;
    const origin = route.origin || flight.origin;
    const destination = route.destination || flight.destination;

    // Check for pre-fetched results first
    const stored = await chrome.storage.local.get('prefetched_results');
    const prefetched = stored.prefetched_results || {};

    if (prefetched[flightNumber]) {
      const response = prefetched[flightNumber];

      if (response.error) {
        updateCardError(card, response.error);
      } else if (response.stats && response.stats.error) {
        updateCardError(card, response.stats.error);
      } else if (response.stats) {
        updateCardSuccess(card, response.stats, response.fromCache || true);
      } else {
        updateCardError(card, 'No data available');
      }

      await updateUsageStats();
      return;
    }

    // No pre-fetched data, fetch fresh
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'getDelayStats',
        flightNumber: flightNumber,
        origin: origin,
        destination: destination
      });

      if (response.error) {
        updateCardError(card, response.error);
      } else if (response.stats && response.stats.error) {
        updateCardError(card, response.stats.error);
      } else if (response.stats) {
        updateCardSuccess(card, response.stats, response.fromCache);
      } else {
        updateCardError(card, 'No data available');
      }

      // Update usage stats after each lookup
      await updateUsageStats();

    } catch (error) {
      updateCardError(card, 'Failed to fetch data');
    }
  }

  function updateCardSuccess(card, stats, fromCache) {
    const isDelayed = stats.avg_delay >= 30;
    const statusClass = isDelayed ? 'delayed' : 'on-time';

    // Format the average delay for the pill
    let statusText;
    if (stats.avg_delay <= 0) {
      statusText = 'On Time';
    } else if (stats.avg_delay < 60) {
      statusText = `Avg. ${Math.round(stats.avg_delay)} min`;
    } else {
      const hours = Math.floor(stats.avg_delay / 60);
      const mins = Math.round(stats.avg_delay % 60);
      statusText = `Avg. ${hours}h ${mins}m`;
    }

    card.className = `flight-card ${statusClass}`;

    const statusEl = card.querySelector('.flight-status');
    statusEl.className = `flight-status ${statusClass}`;
    statusEl.textContent = statusText;

    // Update stats
    const avgDelay = card.querySelector('#avgDelay');
    avgDelay.textContent = formatDelay(stats.avg_delay);
    avgDelay.className = `stat-value ${stats.avg_delay > 15 ? 'negative' : 'positive'}`;

    const maxDelay = card.querySelector('#maxDelay');
    maxDelay.textContent = formatDelay(stats.max_delay);
    maxDelay.className = `stat-value ${stats.max_delay > 30 ? 'negative' : ''}`;

    card.querySelector('#delayRange').textContent = `${formatDelay(stats.p25)} – ${formatDelay(stats.p75)}`;
    card.querySelector('#sampleSize').textContent = `${stats.sample_size} flights`;

    const footerText = card.querySelector('#footerText');
    let sourceText = fromCache ? 'Cached' : 'Live';
    if (stats.cancelled_count > 0) {
      sourceText += ` • ${stats.cancelled_count} cancelled`;
    }
    footerText.textContent = sourceText;

    // Auto-expand if delayed
    if (isDelayed) {
      card.classList.add('expanded');
      hasDelayedFlight = true;
    }

    // Track loaded flights and update badge color
    onFlightLoaded();
  }

  function updateCardError(card, message) {
    card.className = 'flight-card error';

    const statusEl = card.querySelector('.flight-status');
    statusEl.className = 'flight-status error';
    statusEl.textContent = 'No Data';

    const footerText = card.querySelector('#footerText');
    footerText.textContent = message;

    // Track loaded flights and update badge color
    onFlightLoaded();
  }

  async function onFlightLoaded() {
    loadedFlights++;

    // Once all flights are loaded, update badge color
    if (loadedFlights >= totalFlights) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tab?.id;

        chrome.runtime.sendMessage({
          action: 'updateBadgeColor',
          hasDelayed: hasDelayedFlight,
          tabId: tabId
        }).catch(() => {});
      } catch (e) {
        // Ignore errors
      }
    }
  }

  function formatDelay(minutes) {
    if (minutes === undefined || minutes === null) return '--';
    if (minutes <= 0) return 'On time';
    if (minutes < 60) return `${Math.round(minutes)} min`;
    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    return `${hours}h ${mins}m`;
  }
});
