const { EventEmitter } = require("node:events");
const { extractRoute, routeIdentity, routeLengthM, METRES_PER_NM } =
  require("./route");

const ROUTE_PATH = "/v1/navigation/route";
const SYNC_PATH = "/v1/sync";
const HTTP_SERVICE = "extractor-http";
const WS_SERVICE = "extractor-ws";

const DEFAULT_TIMINGS = {
  fetchTimeoutMs: 5000,
  fetchRetryMs: 10000,
  discoveryTimeoutMs: 10000,
  discoveryRetryMs: 15000,
  reconnectMinMs: 2000,
  reconnectMaxMs: 60000,
  routeDebounceMs: 2000,
  rediscoverAfterFailures: 5,
};

// Prefer a routable IPv4 address from the mDNS service records, falling back
// to the service host name — the Core resolves .local names too.
function pickAddress(...services) {
  for (const service of services) {
    const addresses = service?.addresses || [];
    const ipv4 = addresses.find(
      (a) => a.includes(".") && !a.startsWith("169.254."),
    );
    if (ipv4) {
      return ipv4;
    }
  }
  for (const service of services) {
    if (service && typeof service.host === "string" && service.host !== "") {
      return service.host;
    }
  }
  return null;
}

/**
 * Follows the Orca Core's active route.
 *
 * Resolves the Core over mDNS (or uses a configured address), reads the
 * active route over HTTP and keeps it current by listening to the Core's
 * /v1/sync WebSocket. Emits "route" with a parsed route whenever it changes,
 * and null when navigation ends. Every I/O implementation is injectable so
 * the whole client can be driven from tests without a network.
 */
class OrcaCore extends EventEmitter {
  constructor(options) {
    super();
    this.options = options || {};
    this.timings = { ...DEFAULT_TIMINGS, ...(this.options.timings || {}) };
    this.fetchImpl =
      this.options.fetchImpl || ((url, init) => globalThis.fetch(url, init));
    this.WebSocketImpl = this.options.WebSocketImpl;
    this.BonjourImpl = this.options.BonjourImpl;
    this.log = this.options.log || {
      debug: () => {},
      error: () => {},
    };
    this.onStatus = this.options.onStatus || (() => {});

    this._stopped = true;
    this._endpoint = null;
    this._ws = null;
    this._bonjour = null;
    this._describe = "";
    this._currentIdentity = undefined;
    this._wsFailures = 0;
    this._timers = {};
  }

  start() {
    this._stopped = false;
    if (this.options.host) {
      this._endpoint = {
        host: this.options.host,
        httpPort: this.options.httpPort || 8088,
        wsPort: this.options.wsPort || 8089,
      };
      this._connect();
    } else {
      this._discover();
    }
  }

  stop() {
    this._stopped = true;
    for (const key of Object.keys(this._timers)) {
      clearTimeout(this._timers[key]);
      delete this._timers[key];
    }
    if (this._bonjour) {
      this._destroyBonjour(this._bonjour);
      this._bonjour = null;
    }
    this._closeWs();
  }

  _status(message, isError) {
    if (this._stopped) {
      return;
    }
    this.onStatus(message, isError === true);
    this.emit("status", message, isError === true);
  }

  _destroyBonjour(bonjour) {
    try {
      bonjour.destroy();
    } catch (err) {
      this.log.debug(`mDNS shutdown: ${err.message}`);
    }
  }

  _closeWs() {
    if (!this._ws) {
      return;
    }
    const ws = this._ws;
    this._ws = null;
    // The WHATWG WebSocket has no terminate() — a plain close() is all we
    // can ask for. Listeners left behind are safe: the close handler ignores
    // a detached socket and the error handler only logs.
    try {
      ws.close();
    } catch (_err) {
      // nothing more to try
    }
  }

  // Browse for the Core's two service types and connect once a pair with the
  // same instance name is seen — the HTTP service gives the REST port, the
  // WebSocket service the sync port.
  _discover() {
    if (this._stopped) {
      return;
    }
    this._status(
      `Discovering the Orca Core via mDNS (${HTTP_SERVICE} / ${WS_SERVICE})…`,
    );
    const Bonjour = this.BonjourImpl || require("bonjour-service").Bonjour;
    let bonjour;
    try {
      bonjour = new Bonjour({}, (err) => {
        this.log.debug(`mDNS: ${err.message}`);
      });
    } catch (err) {
      this.log.error(`Could not start mDNS discovery: ${err.message}`);
      this._timers.discoveryRetry = setTimeout(
        () => this._discover(),
        this.timings.discoveryRetryMs,
      );
      return;
    }
    this._bonjour = bonjour;

    const http = new Map();
    const ws = new Map();
    const tryResolve = () => {
      if (this._stopped || !this._bonjour) {
        return;
      }
      for (const [name, httpService] of http) {
        const wsService = ws.get(name);
        if (!wsService) {
          continue;
        }
        const host = pickAddress(httpService, wsService);
        if (!host) {
          continue;
        }
        this._finishDiscovery({
          host,
          httpPort: httpService.port,
          wsPort: wsService.port,
          name,
        });
        return;
      }
    };

    bonjour.find({ type: HTTP_SERVICE }, (service) => {
      http.set(service.name, service);
      tryResolve();
    });
    bonjour.find({ type: WS_SERVICE }, (service) => {
      ws.set(service.name, service);
      tryResolve();
    });

    this._timers.discovery = setTimeout(() => {
      delete this._timers.discovery;
      if (this._stopped) {
        return;
      }
      this._bonjour = null;
      this._destroyBonjour(bonjour);
      this._status("No Orca Core found via mDNS, retrying…", true);
      this._timers.discoveryRetry = setTimeout(
        () => this._discover(),
        this.timings.discoveryRetryMs,
      );
    }, this.timings.discoveryTimeoutMs);
  }

  _finishDiscovery(endpoint) {
    clearTimeout(this._timers.discovery);
    delete this._timers.discovery;
    clearTimeout(this._timers.discoveryRetry);
    delete this._timers.discoveryRetry;
    if (this._bonjour) {
      this._destroyBonjour(this._bonjour);
      this._bonjour = null;
    }
    this._endpoint = endpoint;
    this.log.debug(
      `Orca Core "${endpoint.name}" found at ${endpoint.host} (HTTP ${endpoint.httpPort}, WebSocket ${endpoint.wsPort})`,
    );
    this._wsFailures = 0;
    this._connect();
  }

  _connect() {
    if (this._stopped || !this._endpoint) {
      return;
    }
    // The built-in WHATWG WebSocket client (Node 22.4+). The constructor
    // never throws; failures arrive as error and close events.
    const WebSocket = this.WebSocketImpl || globalThis.WebSocket;
    const { host, wsPort } = this._endpoint;
    this._describe = `${host}:${wsPort}`;
    this._status(`Connecting to the Orca Core at ${this._describe}…`);
    let ws;
    try {
      ws = new WebSocket(`ws://${host}:${wsPort}${SYNC_PATH}`);
    } catch (err) {
      this.log.debug(`Could not open the sync connection: ${err.message}`);
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;

    ws.addEventListener("open", () => {
      if (this._ws !== ws) {
        return;
      }
      this._wsFailures = 0;
      this._status(`Connected to the Orca Core at ${this._describe}`);
      this._fetchRoute();
    });
    ws.addEventListener("message", async (event) => {
      if (this._ws !== ws) {
        return;
      }
      let data = event.data;
      // Binary frames arrive as Blobs unless binaryType is changed; the
      // sync channel speaks JSON text frames, but be tolerant either way.
      if (data && typeof data.text === "function") {
        data = await data.text();
      }
      this._onSyncMessage(data);
    });
    ws.addEventListener("error", (event) => {
      this.log.debug(
        `Orca Core sync connection error: ${event.message || "connection failed"}`,
      );
    });
    ws.addEventListener("close", () => {
      if (this._ws !== ws) {
        return;
      }
      this._ws = null;
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this._stopped) {
      return;
    }
    this._wsFailures += 1;
    const delay = Math.min(
      this.timings.reconnectMinMs * 1.5 ** (this._wsFailures - 1),
      this.timings.reconnectMaxMs,
    );
    const rediscover =
      !this.options.host &&
      this._wsFailures >= this.timings.rediscoverAfterFailures;
    this._status(
      rediscover
        ? "Orca Core connection lost, searching the network again…"
        : `Orca Core connection lost, reconnecting in ${Math.round(delay / 1000)} s…`,
      true,
    );
    this._timers.reconnect = setTimeout(() => {
      delete this._timers.reconnect;
      if (this._stopped) {
        return;
      }
      if (rediscover) {
        this._wsFailures = 0;
        this._discover();
      } else {
        this._connect();
      }
    }, delay);
  }

  // Sync events arrive as {"sync":{type,…}}. The live-route events say the
  // route changed in some way; the full route is then read over HTTP. STATE
  // and FEATURE arrive in a burst when a route is (re)built, so their fetch
  // is debounced — by the last feature the whole route is available.
  _onSyncMessage(data) {
    let message;
    try {
      message = JSON.parse(typeof data === "string" ? data : data.toString());
    } catch (_err) {
      this.log.debug("Ignoring a non-JSON sync message");
      return;
    }
    const sync = message?.sync;
    if (!sync || typeof sync.type !== "string") {
      this.log.debug("Ignoring a sync message without a type");
      return;
    }
    switch (sync.type) {
      case "LIVE_ROUTE_CLEAR":
        this._fetchRoute();
        break;
      case "LIVE_ROUTE_STATE":
      case "LIVE_ROUTE_FEATURE":
        this._debounceFetch();
        break;
      case "LIVE_ROUTE_HEARTBEAT":
        break;
      default:
        this.log.debug(`Orca sync event not handled: ${sync.type}`);
    }
  }

  _debounceFetch() {
    if (this._stopped) {
      return;
    }
    if (this._timers.debounce) {
      clearTimeout(this._timers.debounce);
    }
    this._timers.debounce = setTimeout(() => {
      delete this._timers.debounce;
      this._fetchRoute();
    }, this.timings.routeDebounceMs);
  }

  async _fetchRoute() {
    if (this._stopped || !this._endpoint) {
      return;
    }
    if (this._timers.fetchRetry) {
      clearTimeout(this._timers.fetchRetry);
      delete this._timers.fetchRetry;
    }
    const url = `http://${this._endpoint.host}:${this._endpoint.httpPort}${ROUTE_PATH}`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.timings.fetchTimeoutMs,
    );
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const body = await response.json();
      if (this._stopped) {
        return;
      }
      this._applyRoute(extractRoute(body));
    } catch (err) {
      clearTimeout(timeout);
      if (this._stopped) {
        return;
      }
      this._status(
        `Could not read the route from the Orca Core: ${err.message}`,
        true,
      );
      this._timers.fetchRetry = setTimeout(() => {
        delete this._timers.fetchRetry;
        this._fetchRoute();
      }, this.timings.fetchRetryMs);
      return;
    }
    clearTimeout(timeout);
  }

  // Only a route whose identity actually changed is emitted — heartbeats and
  // intermediate sync bursts do not re-announce the same route.
  _applyRoute(route) {
    const identity = route ? routeIdentity(route) : null;
    if (identity === this._currentIdentity) {
      return;
    }
    this._currentIdentity = identity;
    if (route) {
      const nm = (routeLengthM(route.coordinates) / METRES_PER_NM).toFixed(1);
      this._status(
        `Connected to the Orca Core at ${this._describe} — active route: ${route.coordinates.length} points, ${nm} nm`,
      );
    } else {
      this._status(
        `Connected to the Orca Core at ${this._describe} — no active route`,
      );
    }
    this.emit("route", route);
  }
}

module.exports = { OrcaCore, DEFAULT_TIMINGS, pickAddress };
