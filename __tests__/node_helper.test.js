const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("path");

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "node_helper") {
    return path.join(__dirname, "stubs", "fake-node_helper.js");
  }
  return originalResolveFilename.call(this, request, ...rest);
};

const helperModule = require("../node_helper.js");

const makeHelper = () => Object.create(helperModule);

test("fetchCalendars: a per-source fetch error never leaks the raw private ICS URL to the front end, and identifies the failure as an ICS error", async () => {
  const helper = makeHelper();
  const sent = [];
  helper.sendSocketNotification = (notification, payload) => {
    sent.push({ notification, payload });
  };
  helper.fetchIcs = async () => {
    throw new Error("HTTP 404");
  };

  await helper.fetchCalendars({
    identifier: "day-1",
    rangeStart: new Date().toISOString(),
    rangeEnd: new Date(Date.now() + 86400000).toISOString(),
    icalSources: [
      {
        url: "https://calendar.google.com/calendar/ical/private-verysecrettoken1234/basic.ics",
        name: "Work"
      }
    ]
  });

  const errorCall = sent.find((s) => s.notification === "GLASSDAILYCALENDAR_ERROR");
  assert.ok(errorCall);
  assert.equal(errorCall.payload.kind, "ics");
  assert.equal(errorCall.payload.identifier, "day-1");
  assert.ok(
    !errorCall.payload.url.includes("verysecrettoken1234"),
    `raw private ICS URL leaked to the front end: ${errorCall.payload.url}`
  );
});

test("fetchCalendars: EVENTS payload echoes back the requesting instance's identifier", async () => {
  const helper = makeHelper();
  const sent = [];
  helper.sendSocketNotification = (notification, payload) => {
    sent.push({ notification, payload });
  };
  helper.fetchIcs = async () => [];

  await helper.fetchCalendars({
    identifier: "day-2",
    rangeStart: new Date().toISOString(),
    rangeEnd: new Date(Date.now() + 86400000).toISOString(),
    icalSources: [{ url: "https://example.com/basic.ics" }]
  });

  const eventsCall = sent.find((s) => s.notification === "GLASSDAILYCALENDAR_EVENTS");
  assert.ok(eventsCall);
  assert.equal(eventsCall.payload.identifier, "day-2");
});

// fetchForecast's weather.gov calls go through node-fetch via a dynamic
// import() inside node_helper.js, which isn't interceptable the way
// require("node_helper") is above (ESM dynamic import has its own resolver).
// AbortSignal.timeout(30000) on both weather.gov calls, and the
// kind: "forecast" tag on the resulting error, are covered by direct source
// inspection (see node_helper.js) rather than a network-independent unit
// test here; fetchForecast's early-return / no-coordinates guard is the
// piece that's practical to unit test without hitting the network.
test("fetchForecast: does nothing (and sends nothing) when latitude/longitude are absent", async () => {
  const helper = makeHelper();
  const sent = [];
  helper.sendSocketNotification = (notification, payload) => sent.push({ notification, payload });

  await helper.fetchForecast({ identifier: "day-1", latitude: null, longitude: null });

  assert.equal(sent.length, 0);
});
