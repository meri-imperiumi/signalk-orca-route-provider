const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const pluginFactory = require("../plugin/index");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A parsed route, as OrcaCore emits it.
const ROUTE = {
  hash: "dfb4ce6f465e7c4967e17ba0539ee2ac",
  updatedAt: 1789868902005,
  coordinates: [
    [-173.982161, -18.658274],
    [-173.985391, -18.657004],
    [-173.987876, -18.654836],
  ],
};

const OTHER_ROUTE = {
  hash: "1e937d58e7393a5d2c5b28a9835e8313",
  updatedAt: 1789868902005,
  coordinates: [
    [-173.982161, -18.658274],
    [-173.987876, -18.654836],
  ],
};

class FakeCore extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.started = false;
    this.stopped = false;
    FakeCore.instances.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}
FakeCore.instances = [];

function makeApp() {
  const state = {
    providers: [],
    statuses: [],
    errors: [],
    messages: [],
    activated: [],
    course: null,
    cleared: 0,
    selfPath: {},
    activateError: null,
  };
  const app = {
    debug: () => {},
    error: (message) => state.errors.push(message),
    setPluginStatus: (message) => state.statuses.push(message),
    setPluginError: (message) => state.errors.push(message),
    handleMessage: (id, delta, version) =>
      state.messages.push({ id, delta, version }),
    registerResourceProvider: (provider) => state.providers.push(provider),
    getSelfPath: (path) => state.selfPath[path],
    getCourse: async () => state.course,
    activateRoute: async (destination) => {
      state.activated.push(destination);
      if (state.activateError) {
        throw new Error(state.activateError);
      }
    },
    clearDestination: async () => {
      state.cleared += 1;
    },
  };
  return { app, state };
}

function startPlugin(state = {}) {
  const made = makeApp();
  Object.assign(made.state, state);
  const plugin = pluginFactory(made.app, { OrcaCoreImpl: FakeCore });
  plugin.start({ host: "192.168.2.128" });
  const core = FakeCore.instances.at(-1);
  return { plugin, core, ...made };
}

test("plugin has the required interface", () => {
  const { app } = makeApp();
  const plugin = pluginFactory(app, { OrcaCoreImpl: FakeCore });
  assert.equal(plugin.id, "signalk-orca-route-provider");
  assert.ok(plugin.name);
  assert.ok(plugin.description);
  assert.equal(typeof plugin.start, "function");
  assert.equal(typeof plugin.stop, "function");
  const schema = plugin.schema();
  assert.equal(schema.type, "object");
  assert.ok(schema.properties.host);
  assert.equal(schema.properties.activateCourse.default, true);
  assert.equal(
    schema.properties.activateCourse.title,
    "Automatically activate the Orca route",
  );
  // The config page groups the settings under section headers.
  assert.equal(schema.properties._courseHeader.title, "Signal K course");
  const uiSchema = plugin.uiSchema();
  assert.ok(uiSchema._courseHeader["ui:classNames"].includes("mt-4"));
});

test("start registers a routes provider and starts following the Core", () => {
  const { core, state } = startPlugin();
  assert.equal(core.started, true);
  assert.equal(core.options.host, "192.168.2.128");
  assert.equal(state.providers.length, 1);
  assert.equal(state.providers[0].type, "routes");
});

test("the route is served as a resource, activated and announced", async () => {
  const { plugin, core, state } = startPlugin();
  core.emit("route", ROUTE);
  const provider = state.providers[0];

  const list = await provider.methods.listResources({});
  const ids = Object.keys(list);
  assert.equal(ids.length, 1);
  const resource = list[ids[0]];
  assert.equal(resource.name, "Orca route");
  assert.ok(resource.distance > 0);
  assert.equal(resource.feature.geometry.type, "LineString");

  assert.equal(await provider.methods.getResource(ids[0]), resource);
  assert.deepEqual(
    await provider.methods.getResource(ids[0], "feature.geometry.type"),
    {
      value: "LineString",
    },
  );
  assert.deepEqual(await provider.methods.getResource(ids[0], "name"), {
    value: "Orca route",
  });

  await assert.rejects(
    () => provider.methods.getResource("not-the-id"),
    /No Orca route with id/,
  );

  // The route change is announced as a resource delta.
  assert.equal(state.messages.length, 1);
  const message = state.messages[0];
  assert.equal(message.id, "signalk-orca-route-provider");
  assert.equal(message.version, "v2");
  assert.equal(
    message.delta.updates[0].values[0].path,
    `resources.routes.${ids[0]}`,
  );
  assert.equal(message.delta.updates[0].values[0].value, resource);

  // And followed through the course API, from point 0 without a fix.
  assert.equal(state.activated.length, 1);
  assert.equal(state.activated[0].href, `/resources/routes/${ids[0]}`);
  assert.equal(state.activated[0].pointIndex, 0);

  plugin.stop();
});

test("the course starts from the point nearest the vessel", async () => {
  const { plugin, core, state } = startPlugin();
  state.selfPath["navigation.position"] = {
    value: { latitude: -18.657, longitude: -173.985 },
  };
  core.emit("route", ROUTE);

  assert.equal(state.activated[0].pointIndex, 1);
  plugin.stop();
});

test("the served route is read-only", async () => {
  const { plugin, core, state } = startPlugin();
  core.emit("route", ROUTE);
  const provider = state.providers[0];
  await assert.rejects(
    () => provider.methods.setResource("any", {}),
    /managed by the Orca app/,
  );
  await assert.rejects(
    () => provider.methods.deleteResource("any"),
    /managed by the Orca app/,
  );
  plugin.stop();
});

test("ending the route clears the course only when it is ours", async () => {
  const { plugin, core, state } = startPlugin();
  core.emit("route", ROUTE);
  const ids = Object.keys(await state.providers[0].methods.listResources({}));

  state.course = { activeRoute: { href: `/resources/routes/${ids[0]}` } };
  core.emit("route", null);
  await wait(10);

  assert.deepEqual(await state.providers[0].methods.listResources({}), {});
  assert.equal(state.cleared, 1);
  // Removal is announced too.
  const last = state.messages.at(-1);
  assert.equal(
    last.delta.updates[0].values[0].path,
    `resources.routes.${ids[0]}`,
  );
  assert.equal(last.delta.updates[0].values[0].value, null);

  // Someone else's course is left alone.
  state.course = {
    activeRoute: { href: "/resources/routes/someone-elses" },
  };
  core.emit("route", ROUTE);
  await wait(10);
  core.emit("route", null);
  await wait(10);
  assert.equal(state.cleared, 1);

  plugin.stop();
});

test("a re-route activates the new route", async () => {
  const { plugin, core, state } = startPlugin();
  core.emit("route", ROUTE);
  core.emit("route", OTHER_ROUTE);
  await wait(10);

  const list = await state.providers[0].methods.listResources({});
  const ids = Object.keys(list);
  assert.equal(ids.length, 1);
  assert.equal(state.activated.at(-1).href, `/resources/routes/${ids[0]}`);
  assert.equal(state.activated.length, 2);

  plugin.stop();
});

test("a failed activation is retried and reported", async () => {
  const { plugin, core, state } = startPlugin();
  state.activateError = "Unable to retrieve vessel position";
  core.emit("route", ROUTE);
  await wait(10);

  assert.equal(state.activated.length, 1);
  assert.ok(
    state.statuses.some((s) => s.includes("course activation pending")),
  );

  plugin.stop();
});

test("course activation can be disabled", async () => {
  const made = makeApp();
  const plugin = pluginFactory(made.app, { OrcaCoreImpl: FakeCore });
  plugin.start({ activateCourse: false });
  const core = FakeCore.instances.at(-1);
  core.emit("route", ROUTE);
  await wait(10);

  assert.equal(made.state.activated.length, 0);
  const list = await made.state.providers[0].methods.listResources({});
  assert.equal(Object.keys(list).length, 1);

  plugin.stop();
});

test("stop stops following the Core and clears our course", async () => {
  const { plugin, core, state } = startPlugin();
  core.emit("route", ROUTE);
  const ids = Object.keys(await state.providers[0].methods.listResources({}));
  state.course = { activeRoute: { href: `/resources/routes/${ids[0]}` } };

  plugin.stop();
  await wait(10);

  assert.equal(core.stopped, true);
  assert.equal(state.cleared, 1);

  // A second lifecycle still works.
  plugin.start({ host: "192.168.2.128" });
  const second = FakeCore.instances.at(-1);
  assert.equal(second.started, true);
  plugin.stop();
  assert.equal(second.stopped, true);
});
