# Privacy Policy for Flight Delay Checker

**Last updated:** January 11, 2025

## Overview

Flight Delay Checker is a browser extension that displays historical delay data for flights on Google Flights. Your privacy is important, and this extension is designed to collect minimal data necessary for functionality.

## Data Collection

### What We Collect

1. **Anonymous Installation ID**
   - A randomly generated identifier (not linked to your identity)
   - Used solely for rate limiting API requests
   - Cannot be used to identify you personally

2. **Usage Statistics**
   - Number of flight lookups performed
   - Used to enforce daily usage limits and determine when to show optional tip prompts

3. **Flight Numbers Searched**
   - Temporarily processed to fetch delay data
   - Cached on our servers for up to 3 days to improve performance
   - Not linked to any user or installation ID

### What We Do NOT Collect

- Personal information (name, email, etc.)
- Browsing history
- Location data
- Any data from pages other than Google Flights
- Payment information (tips are processed entirely by Stripe)

## Data Storage

- **Local Storage:** Your installation ID and usage counts are stored locally in your browser
- **Server Storage:** Flight delay statistics are cached on Firebase servers (US-based) for performance
- **Retention:** Cached flight data is automatically deleted after 3 days

## Third-Party Services

This extension uses the following third-party services:

1. **FlightAware** - Provides historical flight delay data
2. **Firebase/Google Cloud** - Hosts our backend API
3. **Stripe** - Processes optional tips (only if you choose to tip)

Each service has its own privacy policy governing their data practices.

## Data Sharing

We do not sell, trade, or otherwise transfer your data to third parties. Data is only shared with the third-party services listed above as necessary to provide the extension's functionality.

## Your Rights

You can:
- **Delete local data** by removing the extension from Chrome
- **Request data deletion** by contacting us (see below)

## Children's Privacy

This extension is not intended for children under 13 and we do not knowingly collect data from children.

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be reflected in the "Last updated" date above.

## Contact

If you have questions about this privacy policy, please open an issue on our GitHub repository:

https://github.com/aakash-pattabi/Flight-Delay-Checker

---

*This extension is open source. You can review the code at the GitHub link above.*
