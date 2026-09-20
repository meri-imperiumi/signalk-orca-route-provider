// Runs the real client against a real Orca Core on the local network, with
// the real mDNS, WebSocket and HTTP stacks. Self-skips when no Core answers —
// it is a live gate for the boat, not a unit test.

const test = require("node:test");
const assert = require("node:assert/strict");

const { OrcaCore } = require("../plugin/orca");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function coreWithRoute(timings) {
  const routes = [];
  const statuses = [];
  const core = new OrcaCore({
    timings,
    log: {
      debug: () => {},
      error: (message) => statuses.push(message),
    },
    onStatus: (message) => statuses.push(message),
  });
  core.on("route", (route) => routes.push(route));
  core.start();
  return { core, routes, statuses };
}

test("follows the route of a real Orca Core", async (t) => {
  // Discovery alone must not take the whole suite down — a CI host or a
  // laptop off the boat simply has no Core to find.
  const { core, routes } = await coreWithRoute({
    discoveryTimeoutMs: 4000,
    discoveryRetryMs: 60 * 60 * 1000,
  });
  t.after(() => core.stop());

  // With no Core, stop here: skipped, not failed.
  for (let i = 0; i < 40 && routes.length === 0; i++) {
    const settled = core._currentIdentity !== undefined;
    if (settled) {
      break;
    }
    await wait(500);
  }
  if (core._currentIdentity === undefined) {
    t.diagnostic("no Orca Core found — skipping the live check");
    return;
  }

  assert.equal(routes.length, 1);
  const route = routes[0];
  if (route) {
    assert.ok(Array.isArray(route.coordinates));
    assert.ok(route.coordinates.length >= 2);
    assert.ok(route.hash !== undefined);
    t.diagnostic(`live route: ${route.coordinates.length} points`);
  } else {
    t.diagnostic("live Core reports no active route");
  }
});
