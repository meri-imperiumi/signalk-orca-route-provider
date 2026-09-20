/**
 * Signal K plugin serving the Orca Core's active route.
 *
 * @param {import("@signalk/server-api").ServerAPI} app
 * @param {object} [deps] Test seam — overrides for the Orca Core client.
 * @returns {import("@signalk/server-api").Plugin}
 */
const { OrcaCore } = require("./orca");
const { nearestPointIndex, routeUuid, toSignalKRoute } = require("./route");

const PLUGIN_ID = "signalk-orca-route-provider";
const ACTIVATION_RETRY_MS = 30000;

function propertyValue(object, path) {
  return path
    .split(".")
    .reduce(
      (value, key) =>
        value && typeof value === "object" ? value[key] : undefined,
      object,
    );
}

module.exports = (app, deps = {}) => {
  const plugin = {};

  let core = null;
  let currentRoute = null;
  let activationTimer = null;
  let coreStatus = "";
  let activationStatus = "";
  let activateCourse = true;

  plugin.id = PLUGIN_ID;
  plugin.name = "Orca Route Provider";
  plugin.description =
    "Serves the Orca Core's active route as the Signal K active route";

  plugin.schema = () => ({
    type: "object",
    properties: {
      _connectionHeader: {
        type: "null",
        title: "Connection",
      },
      host: {
        type: "string",
        title: "Orca Core address",
        description:
          "Leave empty to discover the Core on the network via mDNS " +
          "(_extractor-http._tcp / _extractor-ws._tcp). Set a hostname or IP " +
          "to use a specific Core without discovery.",
        default: "",
      },
      httpPort: {
        type: "number",
        title: "Orca Core HTTP port",
        default: 8088,
      },
      wsPort: {
        type: "number",
        title: "Orca Core WebSocket port",
        default: 8089,
      },
      _courseHeader: {
        type: "null",
        title: "Signal K course",
      },
      activateCourse: {
        type: "boolean",
        title: "Automatically activate the Orca route",
        description:
          "Follow the Core's active route through the Signal K Course API, " +
          "so chart plotters such as Freeboard show it as the active route " +
          "(navigation.course.activeRoute). Starts from the route point " +
          "nearest the vessel. Disable when something else should own the " +
          "course — the route is still served as a routes resource.",
        default: true,
      },
    },
  });

  plugin.uiSchema = () => ({
    _connectionHeader: { "ui:classNames": "mt-4" },
    _courseHeader: { "ui:classNames": "mt-4" },
  });

  const publishStatus = () => {
    const parts = [coreStatus, activationStatus].filter((part) => part !== "");
    if (parts.length === 0) {
      return;
    }
    app.setPluginStatus(parts.join(" — "));
  };

  // What the server itself does when a stored resource changes — this keeps
  // the full data model current for clients that subscribe instead of
  // re-listing over REST.
  const emitResourceDelta = (id, value) => {
    app.handleMessage(
      PLUGIN_ID,
      {
        updates: [
          {
            values: [{ path: `resources.routes.${id}`, value }],
          },
        ],
      },
      "v2",
    );
  };

  const vesselPosition = () => {
    const position =
      typeof app.getSelfPath === "function"
        ? app.getSelfPath("navigation.position")
        : null;
    const value =
      position && typeof position === "object" && "value" in position
        ? position.value
        : position;
    if (
      value &&
      Number.isFinite(value.latitude) &&
      Number.isFinite(value.longitude)
    ) {
      return value;
    }
    return null;
  };

  const hrefFor = (id) => `/resources/routes/${id}`;

  // Only ever clear a course this plugin set — someone else's navigation
  // must survive the Orca route ending.
  const clearCourseIfOurs = async (route) => {
    if (!route) {
      return;
    }
    try {
      const course = await app.getCourse();
      if (course?.activeRoute?.href === hrefFor(route.id)) {
        await app.clearDestination();
      }
    } catch (err) {
      app.debug(
        `Could not clear the course after the Orca route ended: ${err.message}`,
      );
    }
  };

  const clearActivationRetry = () => {
    if (activationTimer) {
      clearTimeout(activationTimer);
      activationTimer = null;
    }
  };

  // Activating needs the vessel position (the course API builds a previous
  // point from it), which is not always there at the moment the route
  // arrives — keep trying until it is or the route changes.
  const activateCurrentRoute = () => {
    if (!activateCourse || !currentRoute) {
      return;
    }
    clearActivationRetry();
    const attempt = async () => {
      if (!activateCourse || !currentRoute) {
        return;
      }
      try {
        const coordinates = currentRoute.resource.feature.geometry.coordinates;
        await app.activateRoute({
          href: hrefFor(currentRoute.id),
          pointIndex: nearestPointIndex(coordinates, vesselPosition()),
        });
        activationStatus = "";
        publishStatus();
      } catch (err) {
        app.debug(
          `Could not activate the Orca route as the course: ${err.message}`,
        );
        activationStatus = `course activation pending (${err.message})`;
        publishStatus();
        clearActivationRetry();
        activationTimer = setTimeout(attempt, ACTIVATION_RETRY_MS);
      }
    };
    attempt();
  };

  const onRoute = (route) => {
    const previous = currentRoute;
    clearActivationRetry();
    if (!route) {
      currentRoute = null;
      if (previous) {
        emitResourceDelta(previous.id, null);
      }
      clearCourseIfOurs(previous);
      return;
    }
    const id = routeUuid(route);
    currentRoute = { id, resource: toSignalKRoute(route, PLUGIN_ID) };
    emitResourceDelta(id, currentRoute.resource);
    activateCurrentRoute();
  };

  plugin.start = (options) => {
    const settings = options || {};
    activateCourse = settings.activateCourse !== false;

    // Serves the Core's live route as a read-only resource, alongside
    // whatever else provides routes — the server merges providers.
    app.registerResourceProvider({
      type: "routes",
      methods: {
        listResources: async () =>
          currentRoute ? { [currentRoute.id]: currentRoute.resource } : {},

        getResource: async (id, property) => {
          if (!currentRoute || id !== currentRoute.id) {
            throw new Error(`No Orca route with id ${id}`);
          }
          if (property) {
            const value = propertyValue(currentRoute.resource, property);
            if (value === undefined) {
              throw new Error(`No property ${property} on the Orca route`);
            }
            return { value };
          }
          return currentRoute.resource;
        },

        setResource: async () => {
          throw new Error(
            "The active Orca route is managed by the Orca app and cannot be written from Signal K",
          );
        },

        deleteResource: async () => {
          throw new Error(
            "The active Orca route is managed by the Orca app and cannot be deleted from Signal K",
          );
        },
      },
    });

    const OrcaCoreImpl = deps.OrcaCoreImpl || OrcaCore;
    core = new OrcaCoreImpl({
      host: (settings.host || "").trim(),
      httpPort: settings.httpPort,
      wsPort: settings.wsPort,
      log: {
        debug: (...args) => app.debug(args.join(" ")),
        error: (...args) => app.error(args.join(" ")),
      },
      onStatus: (message) => {
        coreStatus = message;
        publishStatus();
      },
    });
    core.on("route", onRoute);
    core.start();
  };

  plugin.stop = () => {
    clearActivationRetry();
    if (core) {
      core.stop();
      core = null;
    }
    const route = currentRoute;
    currentRoute = null;
    coreStatus = "";
    activationStatus = "";
    // The course we activated points at a resource that is about to stop
    // being served — clear it so clients are not left navigating a ghost.
    if (activateCourse) {
      clearCourseIfOurs(route);
    }
  };

  return plugin;
};

module.exports.PLUGIN_ID = PLUGIN_ID;
