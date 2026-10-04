const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractRoute,
  legMetres,
  nearestPointIndex,
  routeIdentity,
  routeLengthM,
  routeUuid,
  toSignalKRoute,
} = require("../plugin/route");

// Captured off the wire from a real Core, GET /v1/navigation/route.
const orcaBody = {
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
            [-173.987876, -18.654836],
          ],
        },
        properties: {
          hash: "dfb4ce6f465e7c4967e17ba0539ee2ac",
          updatedAt: 1789868902005,
        },
      },
    ],
  },
};

// Tongatapu to Nadi, crossing the antimeridian mid-route.
const crossingBody = {
  value: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [-175.16, -21.14],
            [-178.0, -19.6],
            [177.42, -17.76],
          ],
        },
        properties: {
          hash: "1f0c15e0e56a4d0fb3fd6bd6dbb35d1e",
          updatedAt: 1789868902005,
        },
      },
    ],
  },
};

test("extractRoute understands the Core's HTTP payload", () => {
  const route = extractRoute(orcaBody);
  assert.ok(route);
  assert.equal(route.hash, "dfb4ce6f465e7c4967e17ba0539ee2ac");
  assert.equal(route.updatedAt, 1789868902005);
  assert.equal(route.coordinates.length, 3);
  assert.deepEqual(route.coordinates[0], [-173.982161, -18.658274]);
});

test("an unwrapped FeatureCollection is accepted too", () => {
  const route = extractRoute(orcaBody.value);
  assert.ok(route);
  assert.equal(route.hash, "dfb4ce6f465e7c4967e17ba0539ee2ac");
});

test("an empty FeatureCollection means no route", () => {
  assert.equal(
    extractRoute({ value: { type: "FeatureCollection", features: [] } }),
    null,
  );
  assert.equal(extractRoute(null), null);
  assert.equal(extractRoute({ value: {} }), null);
});

test("invalid geometry is rejected rather than served", () => {
  const body = JSON.parse(JSON.stringify(orcaBody));
  body.value.features[0].geometry.coordinates[1] = [200, -18.657];
  assert.equal(extractRoute(body), null);

  const single = JSON.parse(JSON.stringify(orcaBody));
  single.value.features[0].geometry.coordinates = [[11.8, 57.6]];
  assert.equal(extractRoute(single), null);
});

test("a route without a hash is identified by its geometry", () => {
  const body = JSON.parse(JSON.stringify(orcaBody));
  delete body.value.features[0].properties.hash;
  const route = extractRoute(body);
  assert.equal(route.hash, null);
  assert.match(routeIdentity(route), /^geom:/);

  const again = extractRoute(JSON.parse(JSON.stringify(body)));
  assert.equal(routeIdentity(again), routeIdentity(route));
});

test("routeUuid is a valid, stable v4 UUID that follows the route", () => {
  const route = extractRoute(orcaBody);
  const uuid = routeUuid(route);
  assert.match(
    uuid,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(routeUuid(extractRoute(orcaBody)), uuid);

  const changed = JSON.parse(JSON.stringify(orcaBody));
  changed.value.features[0].properties.hash =
    "1e937d58e7393a5d2c5b28a9835e8313";
  assert.notEqual(routeUuid(extractRoute(changed)), uuid);
});

test("toSignalKRoute builds a Signal K route resource", () => {
  const route = extractRoute(orcaBody);
  const resource = toSignalKRoute(route, "signalk-orca-route-provider");
  assert.equal(resource.name, "Orca route");
  assert.ok(resource.distance > 500);
  assert.equal(resource.feature.geometry.type, "LineString");
  assert.equal(resource.feature.geometry.coordinates, route.coordinates);
  assert.equal(resource.feature.properties.orcaHash, route.hash);
  assert.equal(resource.$source, "signalk-orca-route-provider");
  assert.equal(resource.timestamp, new Date(1789868902005).toISOString());
});

test("routeLengthM sums the legs", () => {
  assert.equal(
    routeLengthM([
      [11.0, 57.0],
      [11.0, 58.0],
    ]),
    111195,
  );
});

test("legMetres measures antimeridian crossings the short way round", () => {
  // 0.1° apart across the line, measured in both directions.
  assert.equal(Math.round(legMetres([179.95, 0], [-179.95, 0])), 11119);
  assert.equal(Math.round(legMetres([-179.95, 0], [179.95, 0])), 11119);

  // The same separation measured on one side of the line, for scale.
  assert.equal(Math.round(legMetres([179.9, 0], [180, 0])), 11119);

  // The east-west term scales with the cosine of the latitude.
  assert.equal(Math.round(legMetres([179.9, 60], [-179.9, 60])), 11119);
});

test("routeLengthM follows routes spanning the antimeridian", () => {
  // Two 0.2° legs, one of them crossing the line.
  assert.equal(
    routeLengthM([
      [179.9, 0],
      [-179.9, 0],
      [-179.7, 0],
    ]),
    44478,
  );
});

test("nearestPointIndex works across the antimeridian", () => {
  // The vessel is 0.1° west across the line from point 0; the other points
  // are on the vessel's side but roughly ten times farther away.
  const coordinates = [
    [179.95, 0],
    [-179.0, 0],
    [-178.9, 0],
  ];
  assert.equal(
    nearestPointIndex(coordinates, { longitude: -179.95, latitude: 0 }),
    0,
  );
});

test("a route spanning the antimeridian is served with a sane distance", () => {
  const route = extractRoute(crossingBody);
  assert.ok(route);
  assert.deepEqual(
    route.coordinates,
    crossingBody.value.features[0].geometry.coordinates,
  );

  // Tongatapu to Nadi is roughly 470 nm; measuring the longitude difference
  // unwrapped would report some 22,000 nm.
  const resource = toSignalKRoute(route, "signalk-orca-route-provider");
  assert.equal(resource.distance, 866039);
});

test("nearestPointIndex picks the closest point to the vessel", () => {
  const coordinates = [
    [-173.982161, -18.658274],
    [-173.985391, -18.657004],
    [-173.987876, -18.654836],
  ];
  assert.equal(
    nearestPointIndex(coordinates, {
      longitude: -173.985,
      latitude: -18.657,
    }),
    1,
  );
  assert.equal(nearestPointIndex(coordinates, null), 0);
  assert.equal(
    nearestPointIndex(coordinates, { longitude: null, latitude: -18.65 }),
    0,
  );
});
