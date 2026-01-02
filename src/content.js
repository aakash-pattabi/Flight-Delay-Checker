// Content script for Flight Delay Checker extension
// Detects flights on Google Flights and sends them to the popup

(function() {
  'use strict';

  // Track detected flights
  const detectedFlights = new Map(); // flightNumber -> { carrier, number, route }

  // Current route
  let currentRoute = { origin: null, destination: null };

  // Invalid carrier codes
  const INVALID_CARRIER_CODES = new Set([
    'AM', 'PM', 'HR', 'MIN', 'KG', 'LB',
    'CO', 'OF', 'TO', 'IN', 'AT', 'ON', 'BY', 'OR', 'AN', 'IF',
    'VS', 'TV', 'PC', 'ID', 'OK', 'GO', 'UP', 'NO', 'SO',
  ]);

  function init() {
    console.log('%c[FlightDelay] Extension loaded', 'color: #6b7280');
    extractRoute();
    scanForFlights();
    observeDOMChanges();
    observeURLChanges();
  }

  function extractRoute() {
    const bodyText = document.body.innerText;
    const patterns = [
      /\b([A-Z]{3})\s*[→\-–—]+\s*([A-Z]{3})\b/gi,
      /\b([A-Z]{3})\s+to\s+([A-Z]{3})\b/gi,
    ];

    for (const pattern of patterns) {
      const matches = [...bodyText.matchAll(pattern)];
      for (const match of matches) {
        if (match[1] && match[2]) {
          currentRoute.origin = match[1].toUpperCase();
          currentRoute.destination = match[2].toUpperCase();
          console.log(`%c[FlightDelay] Route: ${currentRoute.origin} → ${currentRoute.destination}`, 'background: #8b5cf6; color: white; padding: 2px 6px; border-radius: 3px');
          return;
        }
      }
    }
  }

  function scanForFlights() {
    const bodyText = document.body.innerText;
    const flightPattern = /(?<![A-Z])([A-Z]{2})[\s\u00A0\u202F]*(\d{2,4})(?!\d)/g;
    const matches = [...bodyText.matchAll(flightPattern)];

    let foundNew = false;

    for (const match of matches) {
      const carrier = match[1];
      const number = match[2];

      if (INVALID_CARRIER_CODES.has(carrier)) continue;
      if (number.length < 2) continue;

      const key = `${carrier}${number}`;

      if (!detectedFlights.has(key)) {
        detectedFlights.set(key, {
          carrier,
          number,
          displayName: `${carrier} ${number}`,
          origin: currentRoute.origin,
          destination: currentRoute.destination,
          detectedAt: Date.now()
        });
        foundNew = true;
        console.log(`%c[FlightDelay] ✈ Detected: ${carrier} ${number}`, 'background: #22c55e; color: white; padding: 2px 6px; border-radius: 3px; font-weight: bold');
      }
    }

    if (foundNew) {
      saveDetectedFlights();
    }
  }

  function saveDetectedFlights() {
    const flights = Array.from(detectedFlights.values());
    chrome.storage.local.set({
      detected_flights: flights,
      page_url: location.href,
      route: currentRoute
    });

    // Send to background for proactive lookup and badge update
    chrome.runtime.sendMessage({
      action: 'proactiveLookup',
      flights: flights,
      route: currentRoute
    }).catch(() => {}); // Ignore if background not ready
  }

  function observeDOMChanges() {
    let debounceTimer = null;

    const observer = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (!currentRoute.origin) extractRoute();
        scanForFlights();
      }, 300);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function observeURLChanges() {
    let lastURL = location.href;

    const observer = new MutationObserver(() => {
      if (location.href !== lastURL) {
        lastURL = location.href;
        detectedFlights.clear();
        currentRoute = { origin: null, destination: null };
        console.log('%c[FlightDelay] Page changed, re-scanning...', 'color: #6b7280');
        setTimeout(() => {
          extractRoute();
          scanForFlights();
        }, 500);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getDetectedFlights') {
      sendResponse({
        flights: Array.from(detectedFlights.values()),
        route: currentRoute
      });
    }
    return true;
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 300);
  }
})();
