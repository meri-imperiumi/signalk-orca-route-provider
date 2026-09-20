# Orca Core route provider for Signal K

This plugin connects to the locally-running Orca Core and provides the current route there as a Signal K active route.

## Why do we need this?

* Orca Core publishes only the next couple of waypoints via N2K, not the whole route
* Tools like [signalk-corridor-tile-downloader](https://github.com/meri-imperiumi/signalk-corridor-tile-downloader) would benefit from having a full route available
