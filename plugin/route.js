const { createHash } = require("node:crypto");

const EARTH_RADIUS_M = 6371000;
const METRES_PER_NM = 1852;

// Equirectangular approximation — plenty accurate over the length of a route
// leg, and cheap enough to run over every point pair.
function legMetres(a, b) {
  const la = (a[1] * Math.PI) / 180;
  const lb = (b[1] * Math.PI) / 180;
  const x = (((b[0] - a[0]) * Math.PI) / 180) * Math.cos((la + lb) / 2);
  const y = lb - la;
  return Math.sqrt(x * x + y * y) * EARTH_RADIUS_M;
}

// Total route length in metres, rounded — a display figure, not navigation data.
function routeLengthM(coordinates) {
  let total = 0;
  for (let i = 1; i < coordinates.length; i++) {
    total += legMetres(coordinates[i - 1], coordinates[i]);
  }
  return Math.round(total);
}

// GeoJSON position, [longitude, latitude].
function isPosition(c) {
  return (
    Array.isArray(c) &&
    c.length >= 2 &&
    Number.isFinite(c[0]) &&
    Number.isFinite(c[1]) &&
    c[0] >= -180 &&
    c[0] <= 180 &&
    c[1] >= -90 &&
    c[1] <= 90
  );
}

function geometryDigest(coordinates) {
  return createHash("sha256")
    .update(coordinates.map((c) => `${c[0]},${c[1]}`).join(";"))
    .digest("hex");
}

// Parse the body of GET /v1/navigation/route into
// { hash, updatedAt, coordinates }, or null when there is no route. An empty
// FeatureCollection — what the Core answers when navigation is cancelled —
// lands here as null too.
function extractRoute(body) {
  const value = body && body.value !== undefined ? body.value : body;
  if (!value || typeof value !== "object") {
    return null;
  }

  let feature = null;
  if (value.type === "FeatureCollection" && Array.isArray(value.features)) {
    feature =
      value.features.find(
        (f) => f?.geometry && f.geometry.type === "LineString",
      ) || null;
  } else if (value.type === "Feature") {
    feature = value;
  }
  if (feature?.geometry?.type !== "LineString") {
    return null;
  }

  const coordinates = feature.geometry.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return null;
  }
  if (!coordinates.every(isPosition)) {
    return null;
  }

  const props = feature.properties || {};
  return {
    hash: typeof props.hash === "string" ? props.hash : null,
    updatedAt: Number.isFinite(props.updatedAt) ? props.updatedAt : null,
    coordinates: coordinates.map((c) => [c[0], c[1]]),
  };
}

// The Orca app considers the hash the route's identity; the geometry digest
// covers payloads that arrive without one.
function routeIdentity(route) {
  return route.hash
    ? `orca:${route.hash}`
    : `geom:${geometryDigest(route.coordinates)}`;
}

// Deterministic UUID v4 derived from the route identity: the same Orca route
// keeps its resource id across fetches and restarts, while a re-route in the
// app becomes a distinct resource, so clients never see one route silently
// morph into another under a stale id.
function routeUuid(route) {
  const hex = createHash("sha1")
    .update(`signalk-orca-route-provider:${routeIdentity(route)}`)
    .digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

// Signal K route resource. The name is fixed on purpose: this is the live
// route the app is navigating right now, not a library entry to curate.
function toSignalKRoute(route, sourceId) {
  return {
    name: "Orca route",
    description: "The route the Orca app is currently navigating",
    distance: routeLengthM(route.coordinates),
    feature: {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: route.coordinates,
      },
      properties: {
        orcaHash: route.hash,
        orcaUpdatedAt: route.updatedAt,
      },
    },
    timestamp: new Date(route.updatedAt ?? Date.now()).toISOString(),
    $source: sourceId,
  };
}

// Index of the route point closest to the vessel — the best guess at where
// the app's navigation stands, used as the starting pointIndex when the route
// is activated. Without a position, navigation starts from point 0.
function nearestPointIndex(coordinates, position) {
  if (
    !position ||
    !Number.isFinite(position.latitude) ||
    !Number.isFinite(position.longitude)
  ) {
    return 0;
  }
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < coordinates.length; i++) {
    const distance = legMetres(
      [position.longitude, position.latitude],
      coordinates[i],
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

module.exports = {
  extractRoute,
  geometryDigest,
  legMetres,
  METRES_PER_NM,
  nearestPointIndex,
  routeIdentity,
  routeLengthM,
  routeUuid,
  toSignalKRoute,
};
