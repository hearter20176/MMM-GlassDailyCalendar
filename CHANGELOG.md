# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `package.json`: repository, homepage, bugs, license and keywords fields.
- README: Update section and trailing commas in the config examples.
- Node built-ins are imported with the `node:` scheme (for example `node:https`).
- ESLint (flat config) with an `npm run lint` script.
- Added CHANGELOG, CODE_OF_CONDUCT and a Dependabot configuration.

### Changed

- ESLint 10, with `defineConfig` in `eslint.config.mjs`; `npm run lint` runs `eslint` without the trailing `.`.
- `node_helper.js` uses Node's built-in `fetch`; the `node-fetch` dependency is removed. `fetchForecast` now has network-independent unit tests.

## [1.0.0]

Released before this changelog was started. Commit history, newest first:

### 2026-10-03

- README: current screenshot and documentation review
- Replace README screenshot with a demo using sample events

### 2026-10-01

- Make long event titles actually scroll
- Stop leaking weather-icon players and marquee animations

### 2026-09-29

- Follow page theme, render event and forecast text safely, mask ICS URLs, show fetch and forecast errors

### 2026-09-25

- Readable, independent title scrolling
- Support sources that list several feeds (url array)
- Make ICS fetching resilient: retries, cache fallback, webcal support

### 2026-09-24

- Mask private calendar URLs in logs and trim fetch error output
- Add ICS timezone handling and performance profile (from deployed Pi)

### 2025-11-29

- modified:   MMM-GlassDailyCalendar.js 	modified:   README.md

### 2025-11-23

- Use cloud-sun icon for partly/mostly cloudy
- Ensure weather text uses glass ink color

### 2025-11-21

- Trim README screenshots section
- Add screenshot placeholders to README
- Initial release of MMM-GlassDailyCalendar
