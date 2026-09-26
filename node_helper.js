/* MMM-GlassDailyCalendar node_helper
 *  - Fetches ICS feeds using node-ical
 *  - Expands RRULE within provided date range
 */

const NodeHelper = require("node_helper");
const ical = require("node-ical");
// Private ICS addresses grant read access to the calendar; never write them to logs.
const maskUrl = (text) => String(text || "")
  .replace(/\/private-[^/\s]+\//g, "/private-<masked>/")
  .replace(/([?&](?:token|key|apikey)=)[^&\s]+/gi, "$1<masked>");
const errText = (err) => maskUrl(err && err.message ? err.message : String(err));

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CACHE_DIR = path.join(__dirname, "cache");
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [5000, 15000];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cacheFile = (url) =>
  path.join(CACHE_DIR, crypto.createHash("sha256").update(url).digest("hex").slice(0, 16) + ".ics");

// Fetch an ICS feed with a timeout and retries; if it still fails, fall back to the
// last good copy on disk so a network hiccup shows slightly stale events instead of
// an empty calendar. webcal:// is fetched as https://.
async function fetchIcsText(rawUrl, userAgent, tag) {
  const url = String(rawUrl).replace(/^webcal:\/\//i, "https://");
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": userAgent },
        signal: AbortSignal.timeout(30000)
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const text = await response.text();
      if (!text || text.indexOf("BEGIN:VCALENDAR") === -1) throw new Error("Invalid ICS content");
      try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cacheFile(url), text);
      } catch (err) {
        // cache is best-effort
      }
      return text;
    } catch (err) {
      lastErr = err;
      if (/^HTTP 40[13]$/.test(err.message)) break; // auth failures are not transient; 404/429 from Google can be
    }
  }
  try {
    const file = cacheFile(url);
    const ageMs = Date.now() - fs.statSync(file).mtimeMs;
    if (ageMs <= CACHE_MAX_AGE_MS) {
      console.warn(`[${tag}] ${maskUrl(url)}: fetch failed (${errText(lastErr)}); ` +
        `using cached copy from ${Math.round(ageMs / 60000)} min ago`);
      return fs.readFileSync(file, "utf8");
    }
  } catch (err) {
    // no usable cache
  }
  throw lastErr;
}
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const {
  resolveTimeZone,
  convertToTimeZone,
  convertFloatingToTimeZone,
  shiftToTimeZone
} = require("./lib/ics-timezone");

const isCancelled = (ev) =>
  ev && ev.status && String(ev.status).toUpperCase() === "CANCELLED";

const getRecurrenceKey = (date) => date.toISOString().slice(0, 10);

const getDisplayShiftMs = (date, timeZone) => {
  if (!date || !timeZone) return 0;
  const shifted = shiftToTimeZone(date, timeZone);
  return shifted.getTime() - date.getTime();
};

const normalizeEventDate = (date, tzid, allDay, hasTimeZone) => {
  if (!date || allDay || !tzid) return date;
  return hasTimeZone ? date : convertFloatingToTimeZone(date, tzid);
};

const applyDisplayTimeZone = (date, tzid, forceTimeZone, allDay) => {
  if (!date || allDay || !forceTimeZone || !tzid) return date;
  return shiftToTimeZone(date, tzid);
};

const isInRange = (start, end, rangeStart, rangeEnd) =>
  !!start && !!end && !(end < rangeStart || start > rangeEnd);

module.exports = NodeHelper.create({
  start() {
    console.log("[MMM-GlassDailyCalendar] node_helper started");
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "GLASSDAILYCALENDAR_FETCH") {
      this.fetchCalendars(payload);
    } else if (notification === "GLASSDAILYCALENDAR_FORECAST") {
      this.fetchForecast(payload);
    }
  },

  async fetchCalendars(payload) {
    try {
      const icalSources = (payload && payload.icalSources) || [];
      const startRaw = payload && payload.rangeStart;
      const endRaw = payload && payload.rangeEnd;

      if (!Array.isArray(icalSources) || icalSources.length === 0) return;
      if (!startRaw || !endRaw) return;

      const rangeStart = new Date(startRaw);
      const rangeEnd = new Date(endRaw);
      if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime())) {
        return;
      }

      const allEvents = [];

      for (const source of icalSources) {
        if (!source || !source.url) continue;
        try {
          const events = await this.fetchIcs(source, rangeStart, rangeEnd);
          allEvents.push(...events);
        } catch (err) {
          console.error(`[MMM-GlassDailyCalendar] ICS fetch error for ${maskUrl(source.url)}: ${errText(err)}`);
          this.sendSocketNotification("GLASSDAILYCALENDAR_ERROR", {
            url: source.url,
            message: errText(err)
          });
        }
      }

      this.sendSocketNotification("GLASSDAILYCALENDAR_EVENTS", { events: allEvents });
    } catch (err) {
      console.error("[MMM-GlassDailyCalendar] fetchCalendars fatal error", err);
      this.sendSocketNotification("GLASSDAILYCALENDAR_ERROR", {
        message: errText(err)
      });
    }
  },

  async fetchIcs(source, rangeStart, rangeEnd) {
    console.log("[MMM-GlassDailyCalendar] Fetching ICS:", maskUrl(source.url));

    const text = await fetchIcsText(source.url, "MagicMirror-GlassDailyCalendar", "MMM-GlassDailyCalendar");

    let data;
    try {
      data = ical.sync.parseICS(text);
    } catch (err) {
      console.error(`[MMM-GlassDailyCalendar] parseICS failed: ${errText(err)}`);
      throw err;
    }

    const events = [];
    const forceTimeZone =
      !!(source && source.forceTimeZone && source.timeZone);
    const padMs =
      forceTimeZone && source.timeZone
        ? Math.max(
          Math.abs(getDisplayShiftMs(rangeStart, source.timeZone)),
          Math.abs(getDisplayShiftMs(rangeEnd, source.timeZone))
        )
        : 0;
    const rangeStartPadded = padMs
      ? new Date(rangeStart.getTime() - padMs)
      : rangeStart;
    const rangeEndPadded = padMs
      ? new Date(rangeEnd.getTime() + padMs)
      : rangeEnd;

    Object.keys(data).forEach(key => {
      const ev = data[key];
      if (!ev || ev.type !== "VEVENT") return;
      if (isCancelled(ev)) return;

      const start = ev.start;
      const end = ev.end || ev.start;
      if (!start) return;

      const allDay =
        ev.datetype === "date" ||
        (!ev.start.tz && ev.start.getHours() === 0 && end.getHours() === 0);

      const tzid = resolveTimeZone(ev, source);
      const normalizedStart = normalizeEventDate(
        start,
        tzid,
        allDay,
        !!(start && start.tz)
      );
      const normalizedEnd = normalizeEventDate(
        end,
        tzid,
        allDay,
        !!(end && end.tz)
      );

      if (!normalizedStart) return;

      const durationMs =
        normalizedStart && normalizedEnd
          ? Math.max(0, normalizedEnd - normalizedStart)
          : 0;

      if (ev.rrule) {
        const dates = ev.rrule.between(rangeStartPadded, rangeEndPadded, true);

        dates.forEach(d => {
          const recurrenceKey = getRecurrenceKey(d);
          if (ev.exdate && ev.exdate[recurrenceKey]) return;

          const recurrence =
            ev.recurrences && ev.recurrences[recurrenceKey];
          if (recurrence && isCancelled(recurrence)) return;

          let occurrenceStart;
          let occurrenceEnd;

          if (recurrence) {
            const recStart = recurrence.start || d;
            const recEnd = recurrence.end || null;
            occurrenceStart = normalizeEventDate(
              recStart,
              tzid,
              allDay,
              !!(recStart && recStart.tz)
            );
            occurrenceEnd = recEnd
              ? normalizeEventDate(
                recEnd,
                tzid,
                allDay,
                !!(recEnd && recEnd.tz)
              )
              : new Date(occurrenceStart.getTime() + durationMs);
          } else {
            occurrenceStart =
              !allDay && tzid ? convertToTimeZone(d, tzid) : d;
            occurrenceEnd = new Date(
              occurrenceStart.getTime() + durationMs
            );
          }

          const displayStart = applyDisplayTimeZone(
            occurrenceStart,
            tzid,
            forceTimeZone,
            allDay
          );
          const displayEnd = applyDisplayTimeZone(
            occurrenceEnd,
            tzid,
            forceTimeZone,
            allDay
          );

          if (!isInRange(displayStart, displayEnd, rangeStart, rangeEnd)) {
            return;
          }

          events.push({
            title: ev.summary || "",
            calendarName: source.name || "",
            startDate: displayStart.toISOString(),
            endDate: displayEnd.toISOString(),
            allDay,
            color: source.color || null,
            colorSource: source.color || null
          });
        });
        return;
      }

      const displayStart = applyDisplayTimeZone(
        normalizedStart,
        tzid,
        forceTimeZone,
        allDay
      );
      const displayEnd = applyDisplayTimeZone(
        normalizedEnd,
        tzid,
        forceTimeZone,
        allDay
      );

      if (!isInRange(displayStart, displayEnd, rangeStart, rangeEnd)) return;

      events.push({
        title: ev.summary || "",
        calendarName: source.name || "",
        startDate: displayStart.toISOString(),
        endDate: displayEnd.toISOString(),
        allDay,
        color: source.color || null,
        colorSource: source.color || null
      });
    });

    console.log("[MMM-GlassDailyCalendar] Parsed", events.length, "events from", maskUrl(source.url));
    return events;
  },

  async fetchForecast(payload) {
    try {
      const lat = payload && payload.latitude;
      const lon = payload && payload.longitude;
      if (lat === null || lon === null || typeof lat === "undefined" || typeof lon === "undefined") {
        return;
      }

      const ua = { "User-Agent": "MagicMirror-MMM-GlassDailyCalendar" };
      const pointRes = await fetch(`https://api.weather.gov/points/${lat},${lon}`, {
        headers: ua
      });
      if (!pointRes.ok) throw new Error("points HTTP " + pointRes.status);
      const pointJson = await pointRes.json();
      const forecastUrl = pointJson && pointJson.properties && pointJson.properties.forecast;
      if (!forecastUrl) throw new Error("No forecast URL from weather.gov");

      const fcRes = await fetch(forecastUrl, { headers: ua });
      if (!fcRes.ok) throw new Error("forecast HTTP " + fcRes.status);
      const fcJson = await fcRes.json();
      const periods = (fcJson && fcJson.properties && fcJson.properties.periods) || [];

      const byDate = new Map();
      periods.forEach((p) => {
        if (!p || !p.startTime) return;
        const dateKey = new Date(p.startTime).toISOString().slice(0, 10);
        const entry = byDate.get(dateKey) || {};
        if (p.isDaytime) {
          entry.high = typeof p.temperature === "number" ? p.temperature : entry.high;
          entry.shortForecast = p.shortForecast || entry.shortForecast;
          entry.icon = p.icon || entry.icon;
        } else {
          entry.low = typeof p.temperature === "number" ? p.temperature : entry.low;
        }
        byDate.set(dateKey, entry);
      });

      const days = Array.from(byDate.entries()).map(([date, data]) => ({
        date,
        high: data.high,
        low: data.low,
        shortForecast: data.shortForecast || "",
        icon: data.icon || null
      }));

      this.sendSocketNotification("GLASSDAILYCALENDAR_FORECAST", { days });
    } catch (err) {
      console.error("[MMM-GlassDailyCalendar] forecast error", err);
      this.sendSocketNotification("GLASSDAILYCALENDAR_ERROR", {
        message: errText(err)
      });
    }
  }
});
