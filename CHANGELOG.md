# Changelog

## [Unreleased]
### Changed
- Replaced the `ws` WebSocket client with Node's built-in `WebSocket` (WHATWG API), removing the only runtime dependency besides `bonjour-service`. Requires Node 22.4 or newer (was 18)

## [0.1.0] - 2026-09-21
### Added
- Initial version. Discovers an Orca Core on the network via mDNS (`_extractor-http._tcp` / `_extractor-ws._tcp`) or a configured address, reads its active route over HTTP (`GET /v1/navigation/route`) and follows route changes over the Core's WebSocket sync channel (`/v1/sync` — `LIVE_ROUTE_CLEAR`, `LIVE_ROUTE_STATE`, `LIVE_ROUTE_FEATURE`, `LIVE_ROUTE_HEARTBEAT`). The active route is served as a Signal K `routes` resource under a deterministic UUID and activated through the Signal K Course API, so Freeboard and other clients show it as the active route. Course activation starts from the route point nearest the vessel and can be disabled in configuration
