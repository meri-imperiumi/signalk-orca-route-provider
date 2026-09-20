const test = require("node:test");
const assert = require("node:assert/strict");

const { OrcaCore, pickAddress } = require("../plugin/orca");

// Timings sized for tests — the defaults would make every wait minutes long.
const FAST = {
  fetchTimeoutMs: 1000,
  fetchRetryMs: 20,
  discoveryTimeoutMs: 50,
  discoveryRetryMs: 20,
  reconnectMinMs: 10,
  reconnectMaxMs: 20,
  routeDebounceMs: 20,
  rediscoverAfterFailures: 3,
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A route as the Core answers it, with a replaceable hash so tests can make
// "the app re-routed" happen.
const orcaBody = (hash) => ({
  value: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [-173.982161, -18.658274],
            [-173.985391, -18.657004],
          ],
        },
        properties: { hash, updatedAt: 1789868902005 },
      },
    ],
  },
});

const NO_ROUTE = { value: { type: "FeatureCollection", features: [] } };

const HASH_A = "dfb4ce6f465e7c4967e17ba0539ee2ac";
const HASH_B = "1e937d58e7393a5d2c5b28a9835e8313";

function fakeWebSocketFactory() {
  const sockets = [];
  // Mimics the built-in WHATWG WebSocket: addEventListener/dispatchEvent
  // instead of Node's EventEmitter, and no unhandled-error crash — a
  // dispatched error with no listener is simply dropped.
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      sockets.push(this);
    }
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) {
        this.listeners.set(type, new Set());
      }
      this.listeners.get(type).add(handler);
    }
    removeEventListener(type, handler) {
      this.listeners.get(type)?.delete(handler);
    }
    dispatchEvent(event) {
      for (const handler of this.listeners.get(event.type) || []) {
        handler(event);
      }
      return true;
    }
    // Test convenience: emit("open") or emit("message", data)
    emit(type, arg) {
      const event =
        arg instanceof Error
          ? { type, message: arg.message }
          : { type, data: arg };
      this.dispatchEvent(event);
    }
    close() {
      this.emit("close");
    }
  }
  return { FakeWebSocket, sockets };
}

// The body getter lets a test change what the Core answers mid-flight.
function fakeFetcher(getBody) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(url);
      const body = getBody();
      if (body instanceof Error) {
        throw body;
      }
      return { ok: true, json: async () => body };
    },
  };
}

function makeCore(options = {}) {
  const statuses = [];
  const core = new OrcaCore({
    host: "192.168.2.128",
    log: { debug: () => {}, error: () => {} },
    timings: FAST,
    onStatus: (message, isError) => statuses.push({ message, isError }),
    ...options,
  });
  return { core, statuses };
}

function syncEvent(type) {
  return JSON.stringify({
    sync: { type, masterId: "test", timestamp: Date.now() },
  });
}

test("connects to /v1/sync and reads the route on open", async () => {
  const { FakeWebSocket, sockets } = fakeWebSocketFactory();
  const fetcher = fakeFetcher(() => orcaBody(HASH_A));
  const { core } = makeCore({
    WebSocketImpl: FakeWebSocket,
    fetchImpl: fetcher.fetchImpl,
  });
  const routes = [];
  core.on("route", (route) => routes.push(route));

  core.start();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, "ws://192.168.2.128:8089/v1/sync");

  sockets[0].emit("open");
  await wait(10);

  assert.equal(fetcher.calls.length, 1);
  assert.equal(
    fetcher.calls[0],
    "http://192.168.2.128:8088/v1/navigation/route",
  );
  assert.equal(routes.length, 1);
  assert.equal(routes[0].hash, HASH_A);

  core.stop();
});

test("route change events trigger one debounced refetch", async () => {
  const { FakeWebSocket, sockets } = fakeWebSocketFactory();
  let body = orcaBody(HASH_A);
  const fetcher = fakeFetcher(() => body);
  const { core } = makeCore({
    WebSocketImpl: FakeWebSocket,
    fetchImpl: fetcher.fetchImpl,
  });
  const routes = [];
  core.on("route", (route) => routes.push(route));

  core.start();
  sockets[0].emit("open");
  await wait(10);
  assert.equal(routes.length, 1);

  // The Core sends STATE and FEATURE in a burst while building the route.
  body = orcaBody(HASH_B);
  sockets[0].emit("message", syncEvent("LIVE_ROUTE_STATE"));
  sockets[0].emit("message", syncEvent("LIVE_ROUTE_FEATURE"));
  await wait(60);

  assert.equal(fetcher.calls.length, 2);
  assert.equal(routes.length, 2);
  assert.equal(routes[1].hash, HASH_B);

  core.stop();
});

test("LIVE_ROUTE_CLEAR refetches at once", async () => {
  const { FakeWebSocket, sockets } = fakeWebSocketFactory();
  let body = orcaBody(HASH_A);
  const fetcher = fakeFetcher(() => body);
  const { core } = makeCore({
    WebSocketImpl: FakeWebSocket,
    fetchImpl: fetcher.fetchImpl,
  });
  const routes = [];
  core.on("route", (route) => routes.push(route));

  core.start();
  sockets[0].emit("open");
  await wait(10);
  assert.equal(routes.length, 1);

  body = NO_ROUTE;
  sockets[0].emit("message", syncEvent("LIVE_ROUTE_CLEAR"));
  await wait(10);

  assert.equal(routes.length, 2);
  assert.equal(routes[1], null);

  core.stop();
});

test("heartbeats and unknown events do not refetch", async () => {
  const { FakeWebSocket, sockets } = fakeWebSocketFactory();
  const fetcher = fakeFetcher(() => orcaBody(HASH_A));
  const { core } = makeCore({
    WebSocketImpl: FakeWebSocket,
    fetchImpl: fetcher.fetchImpl,
  });
  const routes = [];
  core.on("route", (route) => routes.push(route));

  core.start();
  sockets[0].emit("open");
  await wait(10);
  assert.equal(routes.length, 1);

  sockets[0].emit("message", syncEvent("LIVE_ROUTE_HEARTBEAT"));
  sockets[0].emit("message", syncEvent("SOMETHING_NEW"));
  sockets[0].emit("message", "not json at all");
  await wait(60);

  assert.equal(fetcher.calls.length, 1);
  assert.equal(routes.length, 1);

  core.stop();
});

test("an unchanged route is not re-emitted", async () => {
  const { FakeWebSocket, sockets } = fakeWebSocketFactory();
  const fetcher = fakeFetcher(() => orcaBody(HASH_A));
  const { core } = makeCore({
    WebSocketImpl: FakeWebSocket,
    fetchImpl: fetcher.fetchImpl,
  });
  const routes = [];
  core.on("route", (route) => routes.push(route));

  core.start();
  sockets[0].emit("open");
  await wait(10);

  sockets[0].emit("message", syncEvent("LIVE_ROUTE_STATE"));
  await wait(60);

  assert.equal(fetcher.calls.length, 2);
  assert.equal(routes.length, 1);

  core.stop();
});

test("a failed fetch is retried", async () => {
  const { FakeWebSocket, sockets } = fakeWebSocketFactory();
  let failing = true;
  const fetcher = fakeFetcher(() =>
    failing ? new Error("boom") : orcaBody(HASH_A),
  );
  const { core, statuses } = makeCore({
    WebSocketImpl: FakeWebSocket,
    fetchImpl: fetcher.fetchImpl,
  });
  const routes = [];
  core.on("route", (route) => routes.push(route));

  core.start();
  sockets[0].emit("open");
  await wait(60);
  assert.ok(
    statuses.some((s) => s.message.includes("Could not read the route")),
  );
  assert.equal(routes.length, 0);

  failing = false;
  await wait(60);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].hash, HASH_A);

  core.stop();
});

test("reconnects after losing the connection", async () => {
  const { FakeWebSocket, sockets } = fakeWebSocketFactory();
  const fetcher = fakeFetcher(() => orcaBody(HASH_A));
  const { core } = makeCore({
    WebSocketImpl: FakeWebSocket,
    fetchImpl: fetcher.fetchImpl,
  });

  core.start();
  sockets[0].emit("open");
  await wait(10);

  sockets[0].emit("close");
  await wait(40);
  assert.equal(sockets.length, 2);

  // The new connection re-reads the route.
  sockets[1].emit("open");
  await wait(10);
  assert.ok(fetcher.calls.length >= 2);

  core.stop();
});

test("stop() halts timers, sockets and callbacks", async () => {
  const { FakeWebSocket, sockets } = fakeWebSocketFactory();
  const fetcher = fakeFetcher(() => orcaBody(HASH_A));
  const { core } = makeCore({
    WebSocketImpl: FakeWebSocket,
    fetchImpl: fetcher.fetchImpl,
  });
  const routes = [];
  core.on("route", (route) => routes.push(route));

  core.start();
  sockets[0].emit("open");
  await wait(10);
  assert.equal(routes.length, 1);

  core.stop();

  // The old socket was detached — nothing it fires reaches the client.
  sockets[0].emit("message", syncEvent("LIVE_ROUTE_STATE"));
  sockets[0].emit("close");
  await wait(60);
  assert.equal(routes.length, 1);
  assert.equal(fetcher.calls.length, 1);
  assert.equal(sockets.length, 1);
});

test("stop() swallows socket errors fired after teardown", async () => {
  const { FakeWebSocket, sockets } = fakeWebSocketFactory();
  const fetcher = fakeFetcher(() => orcaBody(HASH_A));
  const { core } = makeCore({
    WebSocketImpl: FakeWebSocket,
    fetchImpl: fetcher.fetchImpl,
  });

  core.start();
  sockets[0].emit("open");
  await wait(10);

  core.stop();

  // The Core's reply to our close can surface as an error event on the
  // detached socket — that must not throw or crash anything.
  sockets[0].emit("error", new Error("invalid close code"));
});

function fakeBonjourFactory() {
  const instances = [];
  class FakeBonjour {
    constructor(_options, onError) {
      this.onError = onError;
      this.found = [];
      this.destroyed = false;
      instances.push(this);
    }
    find(options, onUp) {
      this.found.push({ options, onUp });
      return {};
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return { FakeBonjour, instances };
}

test("discovers the Core via mDNS and connects", async () => {
  const { FakeBonjour, instances } = fakeBonjourFactory();
  const { FakeWebSocket, sockets } = fakeWebSocketFactory();
  const fetcher = fakeFetcher(() => orcaBody(HASH_A));
  const { core, statuses } = makeCore({
    host: undefined,
    BonjourImpl: FakeBonjour,
    WebSocketImpl: FakeWebSocket,
    fetchImpl: fetcher.fetchImpl,
  });

  core.start();
  assert.equal(instances.length, 1);
  const bonjour = instances[0];
  assert.equal(bonjour.found.length, 2);

  // The HTTP service alone is not enough — the ports come as a pair.
  bonjour.found[0].onUp({
    name: "orca-b1d270 ORCA",
    port: 8088,
    addresses: ["192.168.2.128"],
    host: "orca-b1d270.local",
  });
  assert.equal(sockets.length, 0);

  bonjour.found[1].onUp({
    name: "orca-b1d270 ORCA",
    port: 8089,
    addresses: [],
    host: "orca-b1d270.local",
  });
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, "ws://192.168.2.128:8089/v1/sync");
  assert.ok(bonjour.destroyed);

  sockets[0].emit("open");
  await wait(10);
  assert.equal(
    fetcher.calls[0],
    "http://192.168.2.128:8088/v1/navigation/route",
  );
  assert.ok(
    statuses.some((s) => s.message.includes("Connected to the Orca Core")),
  );

  core.stop();
});

test("keeps searching when no Core answers", async () => {
  const { FakeBonjour, instances } = fakeBonjourFactory();
  const { FakeWebSocket, sockets } = fakeWebSocketFactory();
  const { core } = makeCore({
    host: undefined,
    BonjourImpl: FakeBonjour,
    WebSocketImpl: FakeWebSocket,
    fetchImpl: fakeFetcher(() => orcaBody(HASH_A)).fetchImpl,
  });

  core.start();
  await wait(150);

  assert.ok(instances.length >= 2);
  assert.ok(instances[0].destroyed);
  assert.equal(sockets.length, 0);

  core.stop();
});

test("pickAddress prefers IPv4 over link-local and host names", () => {
  assert.equal(pickAddress({ addresses: ["192.168.2.128"] }), "192.168.2.128");
  assert.equal(
    pickAddress({ addresses: ["169.254.1.2"], host: "orca.local" }),
    "orca.local",
  );
  assert.equal(
    pickAddress({ addresses: [] }, { host: "orca-b1d270.local" }),
    "orca-b1d270.local",
  );
});
