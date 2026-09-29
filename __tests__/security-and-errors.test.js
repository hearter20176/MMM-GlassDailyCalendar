const test = require("node:test");
const assert = require("node:assert/strict");

global.Module = { register: (_name, def) => { global.__mod2 = def; } };
global.Log = { info: () => {}, warn: () => {}, error: () => {} };
global.config = {};
global.moment = require("moment");

function makeElement(tag) {
  const el = {
    tagName: tag,
    _html: "",
    children: [],
    attributes: {},
    style: {},
    classListSet: new Set(),
    get textContent() {
      return this._text || "";
    },
    set textContent(v) {
      this._text = v;
      this._html = String(v);
    },
    get innerHTML() {
      return this._html;
    },
    set innerHTML(v) {
      this._html = String(v);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener() {},
    get classList() {
      const set = this.classListSet;
      return {
        add: (c) => set.add(c),
        contains: (c) => set.has(c),
        toggle: (c, force) => {
          const has = set.has(c);
          const shouldHave = force === undefined ? !has : force;
          if (shouldHave) set.add(c);
          else set.delete(c);
        }
      };
    },
    set className(v) {
      this._className = v;
    },
    get className() {
      return this._className || "";
    }
  };
  return el;
}

global.document = {
  createElement: (tag) => makeElement(tag),
  createTextNode: (text) => {
    const node = makeElement("#text");
    node.textContent = text;
    return node;
  },
  body: makeElement("body")
};

require("../MMM-GlassDailyCalendar.js");
const mod = global.__mod2;

test("renderEventRow: a marquee-worthy ICS title is set via textContent, never parsed as HTML", () => {
  const malicious = '<img src=x onerror="alert(1)">Evil Meeting Title Long Enough To Marquee';
  const ctx = {
    performanceTuning: { allowMarquee: true },
    config: { marqueeThreshold: 5 },
    shouldMarquee: mod.shouldMarquee,
    cleanAllDayTitle: mod.cleanAllDayTitle,
    formatEventTime: () => "",
    getEventIcon: () => null,
    applyAlpha: () => null,
    darkenColor: () => null,
    getContrastColor: () => "#000"
  };
  const row = mod.renderEventRow.call(ctx, { title: malicious, allDay: false });
  // row.children: [dot, title, time]; title is a .glass-event-title.glass-marquee
  const titleEl = row.children.find((c) => c.className.includes("glass-event-title"));
  const track = titleEl.children[0];
  const primary = track.children[0];
  assert.equal(primary.textContent, malicious);
});

test("renderEventRow: a short ICS title (no marquee) is set via textContent, never parsed as HTML", () => {
  const malicious = "<script>alert(1)</script>";
  const ctx = {
    performanceTuning: { allowMarquee: false },
    config: { marqueeThreshold: 26 },
    shouldMarquee: mod.shouldMarquee,
    cleanAllDayTitle: mod.cleanAllDayTitle,
    formatEventTime: () => "",
    getEventIcon: () => null,
    applyAlpha: () => null,
    darkenColor: () => null,
    getContrastColor: () => "#000"
  };
  const row = mod.renderEventRow.call(ctx, { title: malicious, allDay: false });
  const titleEl = row.children.find((c) => c.className.includes("glass-event-title"));
  assert.equal(titleEl.textContent, malicious);
});

test("socketNotificationReceived: GLASSDAILYCALENDAR_ERROR records an ICS error and triggers a re-render", () => {
  let updateCalls = 0;
  const ctx = {
    identifier: "id1",
    config: { animationSpeed: 400 },
    fetchErrors: { ics: [], forecast: [] },
    queueDomUpdate: () => { updateCalls++; }
  };
  mod.socketNotificationReceived.call(ctx, "GLASSDAILYCALENDAR_ERROR", {
    identifier: "id1",
    kind: "ics",
    url: "Work Calendar",
    message: "HTTP 404"
  });
  assert.equal(ctx.fetchErrors.ics.length, 1);
  assert.equal(ctx.fetchErrors.forecast.length, 0);
  assert.equal(updateCalls, 1);
});

test("socketNotificationReceived: an error for a different module instance is ignored", () => {
  let updateCalls = 0;
  const ctx = {
    identifier: "id1",
    config: { animationSpeed: 400 },
    fetchErrors: { ics: [], forecast: [] },
    queueDomUpdate: () => { updateCalls++; }
  };
  mod.socketNotificationReceived.call(ctx, "GLASSDAILYCALENDAR_ERROR", {
    identifier: "some-other-instance",
    kind: "ics",
    url: "Work Calendar",
    message: "HTTP 404"
  });
  assert.equal(ctx.fetchErrors.ics.length, 0);
  assert.equal(updateCalls, 0);
});

test("renderHeader: shows a visible failure count instead of looking like an empty/free calendar", () => {
  const ctx = {
    config: { header: "Daily", icalSources: [{ url: "a" }, { url: "b" }] },
    loaded: true,
    lastFetch: new Date(),
    fetchErrors: { ics: [{ source: "a" }], forecast: [] },
    countConfiguredSources: mod.countConfiguredSources
  };
  const range = { start: mod.getRange.call({ config: { startDayOffset: 0, daysToShow: 3 } }).start, end: mod.getRange.call({ config: { startDayOffset: 0, daysToShow: 3 } }).end };
  const header = mod.renderHeader.call(ctx, range);
  const metaSpan = header.children[1];
  assert.ok(metaSpan.classList.contains("glass-daily-meta-warning"));
  assert.match(metaSpan.textContent, /1 of 2 calendars? failed/);
});

test("renderHeader: while loading with an ICS error already in hand, shows 'Calendar unavailable' instead of the loading spinner", () => {
  const ctx = {
    config: { header: "Daily", icalSources: [{ url: "a" }] },
    loaded: false,
    lastFetch: null,
    fetchErrors: { ics: [{ source: "a" }], forecast: [] },
    countConfiguredSources: mod.countConfiguredSources
  };
  const range = mod.getRange.call({ config: { startDayOffset: 0, daysToShow: 1 } });
  const header = mod.renderHeader.call(ctx, range);
  const metaSpan = header.children[1];
  assert.equal(metaSpan.textContent, "Calendar unavailable");
});

test("renderHeader: a single configured source with a url array counts each URL, so '2 of 1' can never be shown", () => {
  const ctx = {
    config: { header: "Daily", icalSources: [{ url: ["u1", "u2"], name: "multi" }] },
    loaded: true,
    lastFetch: new Date(),
    fetchErrors: { ics: [{ source: "multi" }, { source: "multi" }], forecast: [] },
    countConfiguredSources: mod.countConfiguredSources
  };
  const range = mod.getRange.call({ config: { startDayOffset: 0, daysToShow: 1 } });
  const header = mod.renderHeader.call(ctx, range);
  const metaSpan = header.children[1];
  assert.match(metaSpan.textContent, /2 of 2 calendars failed/);
  assert.doesNotMatch(metaSpan.textContent, /of 1 calendar/);
});

test("renderDayWeather: a forecast-only failure shows a visible 'Forecast unavailable' notice instead of a blank cell", () => {
  const ctx = {
    forecastDays: [],
    weatherSummary: null,
    config: { weatherGov: { enabled: true, latitude: 1, longitude: 2 } },
    fetchErrors: { ics: [], forecast: [{ message: "points HTTP 500" }] },
    enableLottie: false,
    normalizeCondition: mod.normalizeCondition,
    mapWeatherToIcon: mod.mapWeatherToIcon,
    getLottieForCondition: mod.getLottieForCondition,
    isDaytimeFromSummary: mod.isDaytimeFromSummary,
    loadLottieAnimation: () => {}
  };
  const chip = mod.renderDayWeather.call(ctx, moment().add(2, "days"), moment());
  assert.ok(chip, "expected a visible chip instead of null");
  // The test DOM shim doesn't aggregate descendant textContent onto the
  // parent, so check the actual text-bearing child node.
  assert.match(chip.children[0].textContent, /forecast unavailable/i);
});

test("renderDayWeather: no forecast error and no data still renders nothing (unchanged behavior)", () => {
  const ctx = {
    forecastDays: [],
    weatherSummary: null,
    config: { weatherGov: { enabled: true, latitude: 1, longitude: 2 } },
    fetchErrors: { ics: [], forecast: [] },
    enableLottie: false,
    normalizeCondition: mod.normalizeCondition,
    mapWeatherToIcon: mod.mapWeatherToIcon,
    getLottieForCondition: mod.getLottieForCondition,
    isDaytimeFromSummary: mod.isDaytimeFromSummary,
    loadLottieAnimation: () => {}
  };
  const chip = mod.renderDayWeather.call(ctx, moment().add(2, "days"), moment());
  assert.equal(chip, null);
});
