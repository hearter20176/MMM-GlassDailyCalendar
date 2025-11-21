/* MMM-GlassDailyCalendar node_helper
 *  - Fetches ICS feeds using node-ical
 *  - Expands RRULE within provided date range
 */

const NodeHelper = require("node_helper");
const ical = require("node-ical");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

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
          console.error("[MMM-GlassDailyCalendar] ICS fetch error for", source.url, err);
          this.sendSocketNotification("GLASSDAILYCALENDAR_ERROR", {
            url: source.url,
            message: err && err.message ? err.message : String(err)
          });
        }
      }

      this.sendSocketNotification("GLASSDAILYCALENDAR_EVENTS", { events: allEvents });
    } catch (err) {
      console.error("[MMM-GlassDailyCalendar] fetchCalendars fatal error", err);
      this.sendSocketNotification("GLASSDAILYCALENDAR_ERROR", {
        message: err && err.message ? err.message : String(err)
      });
    }
  },

  async fetchIcs(source, rangeStart, rangeEnd) {
    console.log("[MMM-GlassDailyCalendar] Fetching ICS:", source.url);

    const response = await fetch(source.url, {
      headers: { "User-Agent": "MagicMirror-GlassDailyCalendar" }
    });

    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }

    const text = await response.text();
    if (!text || text.indexOf("BEGIN:VCALENDAR") === -1) {
      throw new Error("Invalid ICS content");
    }

    let data;
    try {
      data = ical.sync.parseICS(text);
    } catch (err) {
      console.error("[MMM-GlassDailyCalendar] parseICS failed:", err);
      throw err;
    }

    const events = [];

    Object.keys(data).forEach(key => {
      const ev = data[key];
      if (!ev || ev.type !== "VEVENT") return;

      const start = ev.start;
      const end = ev.end || ev.start;
      if (!start) return;

      const allDay =
        ev.datetype === "date" ||
        (!ev.start.tz && ev.start.getUTCHours() === 0 && end.getUTCHours() === 0);

      if (ev.rrule) {
        const dates = ev.rrule.between(rangeStart, rangeEnd, true);
        dates.forEach(d => {
          const occurrenceEnd = new Date(d.getTime() + (end - start));
          events.push({
            title: ev.summary || "",
            calendarName: source.name || "",
            startDate: d.toISOString(),
            endDate: occurrenceEnd.toISOString(),
            allDay,
            color: source.color || null,
            colorSource: source.color || null
          });
        });
        return;
      }

      if (end < rangeStart || start > rangeEnd) return;

      events.push({
        title: ev.summary || "",
        calendarName: source.name || "",
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        allDay,
        color: source.color || null,
        colorSource: source.color || null
      });
    });

    console.log("[MMM-GlassDailyCalendar] Parsed", events.length, "events from", source.url);
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
        message: err && err.message ? err.message : String(err)
      });
    }
  }
});
