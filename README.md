# Flight Delay Checker

Chrome extension that displays historical delay statistics for flights shown on Google Flights.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Chrome Extension (Manifest V3)                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  content.js          background.js           popup.html/js      │
│  ───────────         ─────────────           ────────────       │
│  - Runs on           - Service worker        - Extension UI     │
│    Google Flights    - Handles messages      - Shows flight     │
│  - Detects flight    - Calls Firebase API      delay stats      │
│    numbers via       - Manages badge         - Displays usage   │
│    regex scanning    - Registers install       statistics       │
│  - Extracts route                                               │
│    (origin/dest)                                                │
│                                                                 │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTPS
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ Firebase Backend (Cloud Functions)                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  /register           /lookup                                    │
│  ─────────           ───────                                    │
│  - Creates install   - Validates token                          │
│    token             - Checks rate limit (20/day free)          │
│  - Returns daily     - Returns cached data if fresh (<3 days)   │
│    limit             - Calls FlightAware if cache miss          │
│                      - Calculates delay statistics              │
│                                                                 │
│  Firestore Collections:                                         │
│  - tokens: Install tokens with usage tracking                   │
│  - cache: Flight delay data (3-day TTL)                         │
│                                                                 │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTPS (on cache miss)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ FlightAware AeroAPI                                             │
├─────────────────────────────────────────────────────────────────┤
│  Endpoint: /history/flights/{ident}?start=...&end=...           │
│  Returns: Last 7 days of flight history with arrival delays     │
└─────────────────────────────────────────────────────────────────┘
```

## Components

| Component | File | Purpose |
|-----------|------|---------|
| Content Script | `src/content.js` | Detects flights on Google Flights pages |
| Background Worker | `src/background.js` | API communication, badge management |
| Popup UI | `src/popup.html`, `src/popup.js` | User interface for viewing delay stats |
| Cloud Functions | `server/functions/index.js` | Backend API with caching and rate limiting |

## Key Data Flow

1. User visits Google Flights
2. Content script scans page for flight numbers (e.g., "UA 1234")
3. User clicks extension icon to open popup
4. Popup requests delay stats via background worker
5. Background worker calls Firebase `/lookup` endpoint
6. Firebase returns cached data or fetches from FlightAware
7. Stats displayed in popup (avg delay, max delay, on-time range)

## Configuration

| Setting | Location | Value |
|---------|----------|-------|
| Firebase URL | `src/background.js:9` | `API_BASE` constant |
| FlightAware Key | Firebase config | `flightaware.key` |
| Cache TTL | `server/functions/index.js:8` | 3 days |
| Daily Rate Limit | `server/functions/index.js:9` | 20 lookups |

## Dependencies

### Extension
- Chrome Manifest V3
- No external dependencies (vanilla JS)

### Firebase Functions
- Node.js 20
- firebase-admin ^11.11.0
- firebase-functions ^4.5.0

## Delay Statistics Calculated

- `avg_delay`: Mean arrival delay in minutes
- `max_delay`: Maximum arrival delay
- `min_delay`: Minimum arrival delay
- `p25`, `p75`: 25th and 75th percentile delays
- `sample_size`: Number of flights analyzed
- `cancelled_count`: Recent cancellations

## Status Thresholds

- **On Time**: avg_delay < 30 minutes
- **Often Delayed**: avg_delay >= 30 minutes
