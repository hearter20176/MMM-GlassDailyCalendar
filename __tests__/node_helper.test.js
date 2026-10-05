const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("node:path");

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

// fetchForecast uses Node's built-in fetch, so stubbing globalThis.fetch keeps
// these tests network-independent.
test("fetchForecast: folds weather.gov day/night periods into per-day highs and lows, with timeouts on both calls", async (t) => {
  const calls = [];
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const body = String(url).includes("/points/")
      ? { properties: { forecast: "https://api.weather.gov/gridpoints/X/1,1/forecast" } }
      : { properties: { periods: [
          { startTime: "2026-10-05T06:00:00-04:00", isDaytime: true, temperature: 70, shortForecast: "Sunny", icon: "i" },
          { startTime: "2026-10-05T18:00:00-04:00", isDaytime: false, temperature: 50 }
        ] } };
    return { ok: true, status: 200, json: async () => body };
  };

  const helper = makeHelper();
  const sent = [];
  helper.sendSocketNotification = (notification, payload) => sent.push({ notification, payload });

  await helper.fetchForecast({ identifier: "day-1", latitude: 40, longitude: -75 });

  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.opts.signal instanceof AbortSignal));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].notification, "GLASSDAILYCALENDAR_FORECAST");
  assert.deepEqual(sent[0].payload.days, [{ date: "2026-10-05", high: 70, low: 50, shortForecast: "Sunny", icon: "i" }]);
});

test("fetchForecast: an HTTP failure is reported as a forecast-kind error", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });

  const helper = makeHelper();
  const sent = [];
  helper.sendSocketNotification = (notification, payload) => sent.push({ notification, payload });
  const realError = console.error;
  t.after(() => { console.error = realError; });
  console.error = () => {};

  await helper.fetchForecast({ identifier: "day-1", latitude: 40, longitude: -75 });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].notification, "GLASSDAILYCALENDAR_ERROR");
  assert.equal(sent[0].payload.kind, "forecast");
});

test("fetchForecast: does nothing (and sends nothing) when latitude/longitude are absent", async () => {
  const helper = makeHelper();
  const sent = [];
  helper.sendSocketNotification = (notification, payload) => sent.push({ notification, payload });

  await helper.fetchForecast({ identifier: "day-1", latitude: null, longitude: null });

  assert.equal(sent.length, 0);
});
