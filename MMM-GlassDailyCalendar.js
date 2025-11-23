/* MMM-GlassDailyCalendar
 * Liquid glass daily calendar strip for MagicMirror²
 * Daily, horizontal layout sized for bottom_bar.
 */

/* global Module, Log, config, moment */

Module.register("MMM-GlassDailyCalendar", {
  // ---------------------------------------------------------------------------
  // Defaults
  // ---------------------------------------------------------------------------
  defaults: {
    header: "Daily Calendar",
    locale:
      typeof config !== "undefined" && config.locale ? config.locale : "en",

    // Layout
    daysToShow: 5,
    startDayOffset: 0, // days from today to start the strip
    highlightToday: true,
    dimPastDays: true,
    marqueeEvents: false,
    marqueeThreshold: 26, // min characters before marquee kicks in

    // Sources
    useCalendarModule: false,
    useMyAgenda: true,
    useAmbientWeather: true,
    showWeatherRow: true,
    weatherGov: {
      enabled: true,
      latitude: null,
      longitude: null
    },
    icalSources: [],

    // Events per day
    maxEventsPerDay: 4,
    showOverflowIndicator: true,

    // Backgrounds by date or rule
    dayBackgrounds: {}, // { "YYYY-MM-DD": "url('/path')" }
    dayBackgroundRules: [], // [{ calendar: "Holidays", keyword: "snow", image: "/img/bg.jpg" }]

    // Keyword icon mapping
    eventIcons: {}, // { "birthday": { type: "fa", icon: "fa-solid fa-cake-candles" } }
    calendarVisibility: {}, // { "Work": true, "School": false }

    // Theme: "dark" | "light" | "auto" | "autoSun"
    theme: "autoSun",
    sunriseHour: 7,
    sunsetHour: 19,

    // Intervals
    updateInterval: 10 * 60 * 1000,
    animationSpeed: 400
  },

  // ---------------------------------------------------------------------------
  // Assets
  // ---------------------------------------------------------------------------
  getScripts() {
    return [
      this.file("node_modules/moment/min/moment-with-locales.min.js"),
      this.file("node_modules/iconify-icon/dist/iconify-icon.min.js"),
      this.file("vendor/lottie.min.js")
    ];
  },

  getStyles() {
    return [
      "MMM-GlassDailyCalendar.css",
      this.file("node_modules/@fortawesome/fontawesome-free/css/all.min.css"),
      this.file("node_modules/boxicons/css/boxicons.min.css"),
      this.file("lib/iconoir/iconoir.css")
    ];
  },

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  start() {
    if (typeof moment === "undefined") {
      if (!this._momentRequested) {
        this._momentRequested = true;
        const script = document.createElement("script");
        script.src = this.file(
          "node_modules/moment/min/moment-with-locales.min.js"
        );
        script.onload = () => this.start();
        document.body.appendChild(script);
      }
      return;
    }

    Log.info(`[${this.name}] starting`);
    this.loaded = false;
    this.events = [];
    this.weatherSummary = null;
    this.forecastDays = [];
    this.lastFetch = null;
    this.hiddenCalendars = new Set();

    moment.locale(this.config.locale);

    Object.keys(this.config.calendarVisibility || {}).forEach((name) => {
      if (this.config.calendarVisibility[name] === false) {
        this.hiddenCalendars.add(name);
      }
    });

    if (this.config.icalSources && this.config.icalSources.length > 0) {
      this.scheduleFetch();
    } else {
      this.updateDom();
    }

    if (
      this.config.weatherGov &&
      this.config.weatherGov.enabled &&
      this.config.weatherGov.latitude !== null &&
      this.config.weatherGov.longitude !== null
    ) {
      this.scheduleForecastFetch();
    }
  },

  // ---------------------------------------------------------------------------
  // Fetch ICS
  // ---------------------------------------------------------------------------
  scheduleFetch() {
    const range = this.getRange();

    this.sendSocketNotification("GLASSDAILYCALENDAR_FETCH", {
      icalSources: this.config.icalSources,
      rangeStart: range.start.toISOString(),
      rangeEnd: range.end.toISOString()
    });

    setTimeout(() => this.scheduleFetch(), this.config.updateInterval);
  },

  scheduleForecastFetch() {
    this.sendSocketNotification("GLASSDAILYCALENDAR_FORECAST", {
      latitude: this.config.weatherGov.latitude,
      longitude: this.config.weatherGov.longitude
    });
    setTimeout(() => this.scheduleForecastFetch(), this.config.updateInterval);
  },

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------
  notificationReceived(notification, payload, sender) {
    if (notification === "CALENDAR_EVENTS" && this.config.useCalendarModule) {
      this.handleCalendarEvents(payload || []);
    }

    if (
      notification === "AMBIENT_WEATHER_DATA" &&
      this.config.useAmbientWeather
    ) {
      this.handleAmbientWeather(payload);
    }

    if (notification === "MYAGENDA_EVENTS" && this.config.useMyAgenda) {
      this.handleMyAgendaEvents(payload || []);
    }
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "GLASSDAILYCALENDAR_EVENTS") {
      this.handleIcalEvents(payload);
    } else if (notification === "GLASSDAILYCALENDAR_ERROR") {
      Log.error(`[${this.name}] node_helper error`, payload);
    } else if (notification === "GLASSDAILYCALENDAR_FORECAST") {
      this.forecastDays = payload && Array.isArray(payload.days) ? payload.days : [];
      this.updateDom(this.config.animationSpeed);
    }
  },

  // ---------------------------------------------------------------------------
  // Data handlers
  // ---------------------------------------------------------------------------
  handleCalendarEvents(events) {
    if (!Array.isArray(events)) return;
    this.pruneEventsBySource("calendar");
    this.mergeEvents(events, "calendar");
  },

  handleIcalEvents(payload) {
    if (!payload || !Array.isArray(payload.events)) return;
    this.pruneEventsBySource("ical");
    this.mergeEvents(payload.events, "ical");
    this.lastFetch = new Date();
  },

  handleMyAgendaEvents(events) {
    if (!Array.isArray(events)) return;
    this.pruneEventsBySource("myagenda");
    this.mergeEvents(events, "myagenda");
  },

  handleAmbientWeather(payload) {
    this.weatherSummary = payload || null;
    this.updateDom(this.config.animationSpeed);
  },

  // ---------------------------------------------------------------------------
  // Normalization & merge
  // ---------------------------------------------------------------------------
  getRange() {
    const start = moment()
      .add(this.config.startDayOffset, "days")
      .startOf("day");
    const end = start.clone().add(this.config.daysToShow - 1, "days").endOf("day");
    return { start, end };
  },

  mergeEvents(events, sourceType) {
    if (!Array.isArray(events)) return;
    const range = this.getRange();

    const normalized = events
      .map((ev) => {
        const startRaw = ev.startDate || ev.start || ev.date;
        const endRaw = ev.endDate || ev.end || startRaw;
        if (!startRaw) return null;

        const mStart = moment(startRaw);
        const mEnd = moment(endRaw);
        if (!mStart.isValid() || !mEnd.isValid()) return null;
        if (mEnd.isBefore(range.start) || mStart.isAfter(range.end)) return null;

        const title = (ev.title || ev.summary || "")
          .replace(/\s+/g, " ")
          .trim();

        const allDay =
          ev.allDay ||
          ev.fullDayEvent ||
          ev.datetype === "date" ||
          (!mStart.tz && mStart.hours() === 0 && mEnd.hours() === 0);

        const baseColor =
          ev.bgColor ||
          ev.backgroundColor ||
          ev.color ||
          ev.calendarColor ||
          ev.colorSource ||
          null;

        return {
          title,
          calendarName: ev.calendarName || ev.calendar || "",
          startDate: mStart,
          endDate: mEnd,
          allDay: !!allDay,
          color: baseColor,
          bgColor: ev.bgColor || ev.backgroundColor || null,
          source: sourceType
        };
      })
      .filter(Boolean);

    this.events = this.events.concat(normalized);
    this.pruneDayDuplicates(range.start, range.end);
    this.loaded = true;
    this.updateDom(this.config.animationSpeed);
  },

  pruneEventsBySource(sourceType) {
    if (!this.events || !this.events.length) return;
    this.events = this.events.filter((ev) => ev.source !== sourceType);
  },

  normalizeTitle(raw) {
    if (!raw) return "";
    let t = raw
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"');

    t = t.replace(/['"'""\---:,.;!?/\\()[\]{}<>*_~`^|]/g, " ");
    t = t.replace(/\b(\w+)'s\b/g, "$1");
    t = t.replace(/[^\w\s]/g, " ");

    const stop = [
      "the",
      "of",
      "for",
      "and",
      "a",
      "an",
      "mr",
      "mrs",
      "ms",
      "life",
      "celebration",
      "service",
      "memorial",
      "meeting",
      "event"
    ];

    t = t
      .split(/\s+/)
      .filter((w) => w && !stop.includes(w))
      .join(" ");

    t = t.split(/\s+/).sort().join(" ");
    return t.trim();
  },

  pruneDayDuplicates(rangeStart, rangeEnd) {
    if (!this.events || !this.events.length) return;
    const seen = new Set();

    this.events = this.events.filter((ev) => {
      const normTitle = this.normalizeTitle(ev.title);
      if (!normTitle) return true;

      const dayKey = moment
        .max(ev.startDate.clone().startOf("day"), rangeStart)
        .format("YYYY-MM-DD");
      const startBucket = ev.allDay
        ? "all"
        : ev.startDate
            .clone()
            .minutes(Math.floor(ev.startDate.minutes() / 15) * 15)
            .seconds(0)
            .milliseconds(0)
            .format("HH:mm");
      const durationBucket = ev.allDay
        ? "allday"
        : Math.round((ev.endDate.diff(ev.startDate, "minutes") || 0) / 15) * 15;

      const key = `${dayKey}|${normTitle}|${startBucket}|${durationBucket}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },

  // ---------------------------------------------------------------------------
  // Rendering root
  // ---------------------------------------------------------------------------
  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "glass-daily-wrapper";

    const card = document.createElement("div");
    card.className = "glass-daily-card";

    const themeName =
      this.config.theme === "auto"
        ? this.determineThemeAuto()
        : this.config.theme === "autoSun"
          ? this.determineThemeSun()
          : this.config.theme;

    card.classList.add(
      "glass-theme-" + (themeName === "light" ? "light" : "dark")
    );

    const range = this.getRange();
    card.appendChild(this.renderHeader(range));

    card.appendChild(this.renderDayStrip(range));
    wrapper.appendChild(card);
    return wrapper;
  },

  renderHeader(range) {
    const header = document.createElement("div");
    header.className = "glass-daily-header";

    const titleSpan = document.createElement("span");
    titleSpan.className = "glass-daily-title";
    const bullet =
      '<span class="glass-separator" aria-hidden="true">&bull;</span>';
    titleSpan.innerHTML =
      (this.config.header || "") +
      (this.config.header ? " " + bullet + " " : "") +
      range.start.format("MMM D") +
      (range.start.isSame(range.end, "day")
        ? ""
        : " - " + range.end.format("MMM D"));

    const metaSpan = document.createElement("span");
    metaSpan.className = "glass-daily-meta";

    if (
      !this.loaded &&
      this.config.icalSources &&
      this.config.icalSources.length > 0
    ) {
      const spin = document.createElement("span");
      spin.className = "glass-spinner";
      metaSpan.appendChild(spin);
      const txt = document.createElement("span");
      txt.className = "loading-text";
      txt.innerHTML = "Loading calendars...";
      metaSpan.appendChild(txt);
    } else if (this.lastFetch) {
      metaSpan.innerHTML = "Updated " + moment(this.lastFetch).fromNow();
    } else {
      metaSpan.innerHTML = "";
    }

    header.appendChild(titleSpan);
    header.appendChild(metaSpan);
    return header;
  },

  renderWeatherRow() {
    const row = document.createElement("div");
    row.className = "glass-daily-weather";

    if (!this.weatherSummary) {
      row.innerHTML = '<span class="muted">Weather unavailable</span>';
      return row;
    }

    const iconSpan = document.createElement("span");
    const iconClass = this.mapWeatherToIcon(this.weatherSummary);
    iconSpan.className = "weather-icon " + (iconClass || "fa-solid fa-cloud");

    const textSpan = document.createElement("span");
    textSpan.className = "weather-text";

    const t = this.weatherSummary.temperature;
    const cond = this.weatherSummary.condition || "";
    const aqi = this.weatherSummary.aqi;
    const uv = this.weatherSummary.uv;
    const parts = [];
    if (typeof t !== "undefined") parts.push(Math.round(t) + "&deg;");
    if (cond) parts.push(cond);
    if (typeof aqi !== "undefined") parts.push("AQI " + aqi);
    if (typeof uv !== "undefined") parts.push("UV " + uv);
    textSpan.innerHTML = parts.join(" &bull; ");

    row.appendChild(iconSpan);
    row.appendChild(textSpan);
    return row;
  },

  renderDayStrip(range) {
    const wrapper = document.createElement("div");
    wrapper.className = "glass-day-strip-wrapper";

    if (this.config.showWeatherRow) {
      const weatherRow = document.createElement("div");
      weatherRow.className = "glass-day-weather-row";

      const today = moment();
      for (let i = 0; i < this.config.daysToShow; i++) {
        const dayMoment = range.start.clone().add(i, "days");
        const cell = document.createElement("div");
        cell.className = "glass-day-weather-cell";
        const weatherChip = this.renderDayWeather(dayMoment, today);
        if (weatherChip) {
          cell.appendChild(weatherChip);
        }
        weatherRow.appendChild(cell);
      }
      wrapper.appendChild(weatherRow);
    }

    const strip = document.createElement("div");
    strip.className = "glass-day-strip";

    const today = moment();
    for (let i = 0; i < this.config.daysToShow; i++) {
      const dayMoment = range.start.clone().add(i, "days");
      const dayCard = this.renderDay(dayMoment, today);
      strip.appendChild(dayCard);
    }

    wrapper.appendChild(strip);
    return wrapper;
  },

  renderDay(dayMoment, today) {
    const dayStart = dayMoment.clone().startOf("day");
    const dayEnd = dayMoment.clone().endOf("day");
    const events = this.getEventsForDay(dayStart, dayEnd);
    const busyScore = this.getBusyScoreForDay(events);

    const day = document.createElement("div");
    day.className = "glass-day-card";

    if (this.config.highlightToday && dayMoment.isSame(today, "day")) {
      day.classList.add("today");
    } else if (this.config.dimPastDays && dayMoment.isBefore(today, "day")) {
      day.classList.add("past-day");
    }

    if (busyScore > 0) {
      day.style.setProperty("--busy-level", busyScore.toFixed(2));
    }

    const bg = this.getDayBackground(dayMoment, events);
    if (bg) {
      day.style.setProperty("--day-bg-image", bg);
      day.classList.add("has-bg");
    }

    const top = document.createElement("div");
    top.className = "glass-day-top";

    const nameSpan = document.createElement("div");
    nameSpan.className = "glass-day-name";
    nameSpan.innerHTML = dayMoment.format("ddd");

    const dateSpan = document.createElement("div");
    dateSpan.className = "glass-day-date";
    dateSpan.innerHTML = dayMoment.format("D");

    const countSpan = document.createElement("div");
    countSpan.className = "glass-day-count";
    countSpan.innerHTML = events.length ? events.length + " events" : "Free";

    top.appendChild(nameSpan);
    top.appendChild(dateSpan);
    top.appendChild(countSpan);

    const list = document.createElement("div");
    list.className = "glass-day-events";

    if (!events.length) {
      const empty = document.createElement("div");
      empty.className = "glass-day-empty";
      empty.innerHTML = "No events";
      list.appendChild(empty);
    } else {
      const limited = events.slice(0, this.config.maxEventsPerDay);
      limited.forEach((ev) => list.appendChild(this.renderEventRow(ev)));

      if (this.config.showOverflowIndicator && events.length > limited.length) {
        const more = document.createElement("div");
        more.className = "glass-day-more";
        more.innerHTML = `+${events.length - limited.length} more`;
        list.appendChild(more);
      }
    }

    const heat = document.createElement("div");
    heat.className = "glass-day-heatbar";
    heat.style.setProperty(
      "--busy-pct",
      Math.min(1, busyScore || 0).toString()
    );

    day.appendChild(top);
    day.appendChild(list);
    day.appendChild(heat);
    return day;
  },

  renderEventRow(ev) {
    const row = document.createElement("div");
    row.className = "glass-event-row";
    if (ev.allDay) row.classList.add("allday");

    const dot = document.createElement("span");
    dot.className = "glass-event-dot";
    if (ev.color) {
      dot.style.backgroundColor = ev.color;
      dot.style.boxShadow = `0 0 10px ${ev.color}`;
    }

    const icon = this.getEventIcon(ev);
    if (icon) {
      row.appendChild(icon);
    } else {
      row.appendChild(dot);
    }

    let title;
    const needsMarquee =
      this.config.marqueeEvents &&
      this.shouldMarquee(ev.title || "", this.config.marqueeThreshold);

    if (needsMarquee) {
      title = document.createElement("span");
      title.className = "glass-event-title glass-marquee";
      const inner = document.createElement("span");
      inner.innerHTML = this.cleanAllDayTitle(ev.title) || "(no title)";
      title.appendChild(inner);
    } else {
      title = document.createElement("span");
      title.className = "glass-event-title";
      title.innerHTML = this.cleanAllDayTitle(ev.title) || "(no title)";
    }

    const time = document.createElement("span");
    time.className = "glass-event-time";
    time.innerHTML = this.formatEventTime(ev);
    if (!time.innerHTML) time.style.display = "none";

    // Color timed events per calendar color
    if (ev.color && !ev.allDay) {
      row.style.color = ev.color;
      time.style.color = ev.color;
    }

    if (ev.allDay && ev.color) {
      const bg = this.applyAlpha(ev.color, 0.2);
      const border = this.applyAlpha(ev.color, 0.35);
      const ink = this.darkenColor(ev.color, 0.4) || this.getContrastColor(ev.color, "#0f172a");
      if (bg) row.style.background = bg;
      if (border) row.style.boxShadow = `inset 0 0 0 1px ${border}`;
      if (ink) row.style.color = ink;
    }

    row.appendChild(title);
    row.appendChild(time);
    return row;
  },

  renderDayWeather(dayMoment, today = moment()) {
    let info = null;

    const forecastMatch = this.forecastDays.find(
      (d) => d.date === dayMoment.format("YYYY-MM-DD")
    );

    if (dayMoment.isSame(today, "day")) {
      if (this.weatherSummary) {
        const cond = this.normalizeCondition(
          this.weatherSummary.condition,
          this.weatherSummary.conditionCode
        );
        info = {
          label: this.weatherSummary.condition || cond || "",
          temp:
            typeof this.weatherSummary.temperature !== "undefined"
              ? Math.round(this.weatherSummary.temperature)
              : null,
          icon: this.mapWeatherToIcon(this.weatherSummary),
          lottie:
            this.weatherSummary.lottie ||
            this.weatherSummary.lottieAnim ||
            this.getLottieForCondition(
              cond,
              this.isDaytimeFromSummary(this.weatherSummary)
            )
        };
      } else if (forecastMatch) {
        const cond = this.normalizeCondition(forecastMatch.shortForecast);
        info = {
          label: forecastMatch.shortForecast || "",
          temp:
            typeof forecastMatch.high !== "undefined"
              ? Math.round(forecastMatch.high)
              : null,
          icon: this.mapWeatherToIcon({ condition: forecastMatch.shortForecast }),
          lottie: this.getLottieForCondition(cond, true)
        };
      }
    } else if (forecastMatch) {
      const cond = this.normalizeCondition(forecastMatch.shortForecast);
      info = {
        label: forecastMatch.shortForecast || "",
        temp:
          typeof forecastMatch.high !== "undefined"
            ? Math.round(forecastMatch.high)
            : null,
        icon: this.mapWeatherToIcon({ condition: forecastMatch.shortForecast }),
        lottie: this.getLottieForCondition(cond, true)
      };
    }

    if (!info) return null;

    const chip = document.createElement("div");
    chip.className = "glass-day-weather";

    if (info.lottie) {
      const anim = document.createElement("div");
      anim.className = "glass-weather-lottie";
      chip.appendChild(anim);
      this.loadLottieAnimation(anim, info.lottie);
    } else if (info.icon) {
      const iconEl = document.createElement("i");
      iconEl.className = "weather-icon " + info.icon;
      chip.appendChild(iconEl);
    }

    const txt = document.createElement("span");
    txt.className = "weather-text";
    const parts = [];
    if (info.temp !== null && !Number.isNaN(info.temp)) {
      parts.push(info.temp + "&deg;");
    }
    if (info.label) parts.push(info.label);
    txt.innerHTML = parts.join(" &bull; " );
    chip.appendChild(txt);
    return chip;
  },

  loadLottieAnimation(container, src) {
    if (!container || !src) return;

    if (typeof lottie === "undefined") {
      if (!this._lottieLoading) {
        this._lottieLoading = true;
        const script = document.createElement("script");
        script.src = this.file("vendor/lottie.min.js");
        script.onload = () => {
          this._lottieLoading = false;
          this.loadLottieAnimation(container, src);
        };
        script.onerror = () => {
          this._lottieLoading = false;
        };
        document.body.appendChild(script);
      }
      return;
    }

    const opts = {
      container,
      renderer: "svg",
      loop: true,
      autoplay: true
    };
    if (typeof src === "string") {
      opts.path = this.resolveLottiePath(src);
    } else {
      opts.animationData = src;
    }
    try {
      lottie.loadAnimation(opts);
    } catch (e) {
      // ignore if lottie fails
    }
  },

  resolveLottiePath(src) {
    if (!src) return src;
    if (/^https?:\/\/|^data:/i.test(src)) return src;
    if (src.startsWith("/")) return src;
    // Default to AmbientWeather animations directory
    return `/modules/MMM-AmbientWeather/animations/${src}`;
  },

  formatEventTime(ev) {
    if (ev.allDay) return "";
    if (!ev.startDate) return "";
    let t = ev.startDate.format("LT");
    if (ev.endDate && !ev.endDate.isSame(ev.startDate, "minute")) {
      t += " - " + ev.endDate.format("LT");
    }
    return t;
  },

  cleanAllDayTitle(raw) {
    if (!raw) return raw;
    return raw.replace(/\s*\ball[-\s]?day\b\s*/gi, " ").replace(/\s{2,}/g, " ").trim();
  },

  shouldMarquee(title, threshold) {
    if (!title) return false;
    const limit = typeof threshold === "number" ? threshold : 26;
    return title.length > limit;
  },

  getEventsForDay(start, end) {
    const sameDayEvents = this.events.filter((ev) => {
      if (
        this.hiddenCalendars &&
        this.hiddenCalendars.has(ev.calendarName || "Calendar")
      ) {
        return false;
      }
      return ev.startDate.isBefore(end) && ev.endDate.isAfter(start);
    });

    const seen = new Set();
    const result = [];

    sameDayEvents.forEach((ev) => {
      const normTitle = this.normalizeTitle(ev.title);
      const dayKey = start.format("YYYY-MM-DD");
      const key = `event|${normTitle}|${dayKey}`;
      if (seen.has(key)) return;

      const isDuplicate = result.some((existing) =>
        this.isDuplicateEventForDay(ev, existing, start)
      );

      if (!isDuplicate) {
        seen.add(key);
        result.push(ev);
      }
    });

    result.sort((a, b) => {
      if (a.allDay && !b.allDay) return -1;
      if (!a.allDay && b.allDay) return 1;
      return a.startDate.valueOf() - b.startDate.valueOf();
    });

    return result;
  },

  isDuplicateEventForDay(evA, evB, dayStart) {
    const titleA = this.normalizeTitle(evA.title);
    const titleB = this.normalizeTitle(evB.title);
    if (!titleA || !titleB) return false;

    const titleScore = this.titleSimilarity(titleA, titleB);
    if (titleScore < 0.7) return false;

    if (evA.allDay || evB.allDay) return true;

    const diffMinutes = Math.abs(evA.startDate.diff(evB.startDate, "minutes"));
    if (diffMinutes > 45) return false;

    return (
      evA.startDate.isSame(dayStart, "day") ||
      evB.startDate.isSame(dayStart, "day")
    );
  },

  titleSimilarity(a, b) {
    const tokensA = a.split(/\s+/).filter(Boolean);
    const tokensB = b.split(/\s+/).filter(Boolean);
    if (!tokensA.length || !tokensB.length) return 0;

    const setA = new Set(tokensA);
    const setB = new Set(tokensB);
    let intersect = 0;
    setA.forEach((t) => {
      if (setB.has(t)) intersect += 1;
    });

    const denom = Math.max(setA.size, setB.size);
    return denom === 0 ? 0 : intersect / denom;
  },

  getBusyScoreForDay(events) {
    if (!events || !events.length) return 0;
    const timed = events.filter((ev) => !ev.allDay);
    const allDay = events.length - timed.length;
    return Math.min(1.2, timed.length * 0.2 + allDay * 0.35);
  },

  getDayBackground(dayMoment, events) {
    const key = dayMoment.format("YYYY-MM-DD");
    if (this.config.dayBackgrounds && this.config.dayBackgrounds[key]) {
      return this.wrapUrl(this.config.dayBackgrounds[key]);
    }

    const rules = this.config.dayBackgroundRules || [];
    for (const rule of rules) {
      const match = events.some((ev) => {
        const calOk = !rule.calendar
          ? true
          : (ev.calendarName || "")
              .toLowerCase()
              .includes((rule.calendar || "").toLowerCase());
        const keywordOk = !rule.keyword
          ? true
          : (ev.title || "")
              .toLowerCase()
              .includes((rule.keyword || "").toLowerCase());
        return calOk && keywordOk;
      });
      if (match && rule.image) {
        return this.wrapUrl(rule.image);
      }
    }

    return null;
  },

  wrapUrl(img) {
    if (!img) return null;
    const trimmed = img.toString().trim();
    if (/^url\(/i.test(trimmed)) return trimmed;
    return `url('${trimmed}')`;
  },

  // ---------------------------------------------------------------------------
  // Icon helpers
  // ---------------------------------------------------------------------------
  getEventIcon(ev) {
    const title = (ev.title || "").toLowerCase();
    for (let key in this.config.eventIcons || {}) {
      if (title.includes(key.toLowerCase())) {
        const mapping = this.config.eventIcons[key];
        return this.renderIcon(mapping);
      }
    }
    return null;
  },

  renderIcon(mapping) {
    if (!mapping) return null;
    const { type, icon } = mapping;

    if (type === "fa" || type === "box") {
      const el = document.createElement("i");
      el.className = icon + " glass-event-icon";
      return el;
    }

    if (type === "iconoir") {
      const name = (icon || "").replace(/^iconoir-/, "").replace(/\\.svg$/i, "");
      const img = document.createElement("img");
      img.src = this.file(`lib/iconoir/${name}.svg`);
      img.alt = "";
      img.classList.add("glass-event-icon", "iconoir-img");
      img.onerror = () => {
        const fallback = document.createElement("i");
        fallback.className = `iconoir-${name} glass-event-icon iconoir-css-fallback`;
        img.replaceWith(fallback);
      };
      return img;
    }

    if (type === "iconify") {
      const el = document.createElement("iconify-icon");
      el.setAttribute("icon", icon);
      el.classList.add("glass-event-icon");
      return el;
    }

    return null;
  },

  // ---------------------------------------------------------------------------
  // Weather icon mapping
  // ---------------------------------------------------------------------------
  mapWeatherToIcon(summary) {
    if (!summary) return null;
    if (summary.icon) return summary.icon;

    const code = summary.conditionCode;
    const cond = (summary.condition || "").toLowerCase();

    if (typeof code === "number") {
      if (code >= 200 && code < 300) return "fa-solid fa-cloud-bolt";
      if (code >= 300 && code < 600) return "fa-solid fa-cloud-rain";
      if (code >= 600 && code < 700) return "fa-solid fa-snowflake";
      if (code >= 700 && code < 800) return "fa-solid fa-smog";
      if (code === 800) return "fa-solid fa-sun";
      if (code > 800) return "fa-solid fa-cloud-sun";
    }

    if (cond.includes("thunder")) return "fa-solid fa-cloud-bolt";
    if (cond.includes("rain")) return "fa-solid fa-cloud-showers-heavy";
    if (cond.includes("snow")) return "fa-solid fa-snowflake";
    if (cond.includes("fog") || cond.includes("mist"))
      return "fa-solid fa-smog";
    if (cond.includes("partly") || cond.includes("mostly"))
      return "fa-solid fa-cloud-sun";
    if (cond.includes("sun") || cond.includes("clear"))
      return "fa-solid fa-sun";
    if (cond.includes("cloud")) return "fa-solid fa-cloud-sun";

    return "fa-solid fa-cloud";
  },

  normalizeCondition(text, code) {
    if (!text && typeof code !== "number") return "";
    const t = (text || "").toLowerCase();
    if (code) {
      if (code >= 200 && code < 300) return "thunderstorm";
      if (code >= 300 && code < 600) return "rain";
      if (code >= 600 && code < 700) return "snow";
      if (code >= 700 && code < 800) return "fog";
      if (code === 800) return "clear";
      if (code > 800) return "cloud";
    }
    if (t.includes("thunder")) return "thunderstorm";
    if (t.includes("lightning")) return "thunderstorm";
    if (t.includes("freezing")) return "freezing_rain";
    if (t.includes("sleet")) return "sleet";
    if (t.includes("snow")) return "snow";
    if (t.includes("fog") || t.includes("mist")) return "fog";
    if (t.includes("rain") || t.includes("shower")) return "rain";
    if (t.includes("partly") || t.includes("mostly")) return "partly_cloudy";
    if (t.includes("cloud")) return "cloud";
    if (t.includes("clear") || t.includes("sun")) return "clear";
    return t || "";
  },

  getLottieForCondition(cond, isDay = true) {
    const map = {
      clear: { day: "clear_isDay.json", night: "clear_night.json" },
      partly_cloudy: {
        day: "partly-cloudy_isDay.json",
        night: "partly-cloudy-night.json"
      },
      cloud: { day: "overcast_isDay.json", night: "overcast-night.json" },
      rain: {
        day: "overcast-rain_isDay.json",
        night: "overcast-night-rain.json"
      },
      thunderstorm: {
        day: "thunderstorms-rain_isDay.json",
        night: "thunderstorms-night-rain.json"
      },
      fog: { day: "fog_isDay.json", night: "fog-night.json" },
      snow: { day: "overcast-snow_isDay.json", night: "overcast-night-snow.json" },
      sleet: { day: "overcast-sleet_isDay.json", night: "overcast-night-sleet.json" },
      freezing_rain: {
        day: "freezing_rain.json",
        night: "overcast-night-sleet.json"
      }
    };

    const key = cond || "clear";
    const entry = map[key] || map.partly_cloudy || map.clear;
    const file = entry[isDay ? "day" : "night"] || entry.day;
    return file;
  },

  isDaytimeFromSummary(summary) {
    if (!summary) return true;
    if (typeof summary.isDaytime === "boolean") return summary.isDaytime;
    if (summary.sunrise && summary.sunset) {
      try {
        const now = moment();
        const sr = moment(summary.sunrise);
        const ss = moment(summary.sunset);
        return now.isBetween(sr, ss, null, "[)");
      } catch (e) {
        // ignore parse issues
      }
    }
    const hour = moment().hour();
    return hour >= 6 && hour < 20;
  },

  // ---------------------------------------------------------------------------
  // Theme helpers
  // ---------------------------------------------------------------------------
  determineThemeAuto() {
    return "dark";
  },

  determineThemeSun() {
    let sunrise = this.config.sunriseHour;
    let sunset = this.config.sunsetHour;

    if (
      this.weatherSummary &&
      this.weatherSummary.sunrise &&
      this.weatherSummary.sunset
    ) {
      try {
        sunrise = moment(this.weatherSummary.sunrise).hour();
        sunset = moment(this.weatherSummary.sunset).hour();
      } catch (e) {
        // ignore
      }
    }

    const now = moment().hour();
    if (now >= sunrise && now < sunset) {
      return "light";
    }
    return "dark";
  },

  // ---------------------------------------------------------------------------
  // Color helpers
  // ---------------------------------------------------------------------------
  getContrastColor(color, fallback) {
    const fb = fallback || "#7dd3fc";
    const parsed = this.parseColor(color);
    if (!parsed) return fb;

    const { r, g, b } = parsed;
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const { h, s, l } = this.rgbToHsl(r, g, b);

    const targetL = luminance > 0.55 ? 0.25 : 0.82;
    const clampedS = Math.min(0.9, Math.max(0.35, s));
    return this.hslToHex(h, clampedS, targetL);
  },

  parseColor(input) {
    if (!input) return null;
    let str = input.toString().trim();
    if (str.startsWith("#")) {
      const hex = str.slice(1);
      if (hex.length === 3) {
        const r = parseInt(hex[0] + hex[0], 16);
        const g = parseInt(hex[1] + hex[1], 16);
        const b = parseInt(hex[2] + hex[2], 16);
        if ([r, g, b].some((v) => Number.isNaN(v))) return null;
        return { r, g, b };
      }
      if (hex.length === 6 || hex.length === 8) {
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        if ([r, g, b].some((v) => Number.isNaN(v))) return null;
        return { r, g, b };
      }
      return null;
    }
    if (str.startsWith("rgb")) {
      const nums = str
        .replace(/[rgba()]/g, " ")
        .split(/[,\\s]+/)
        .filter(Boolean)
        .slice(0, 3)
        .map((n) => parseInt(n, 10));
      if (nums.length === 3 && nums.every((v) => !Number.isNaN(v))) {
        return { r: nums[0], g: nums[1], b: nums[2] };
      }
    }
    return null;
  },

  rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h, s;
    const l = (max + min) / 2;

    if (max === min) {
      h = s = 0;
    } else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r:
          h = (g - b) / d + (g < b ? 6 : 0);
          break;
        case g:
          h = (b - r) / d + 2;
          break;
        default:
          h = (r - g) / d + 4;
      }
      h /= 6;
    }
    return { h, s, l };
  },

  hslToHex(h, s, l) {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    let r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }

    const toHex = (x) => {
      const v = Math.round(x * 255)
        .toString(16)
        .padStart(2, "0");
      return v;
    };

    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  },

  applyAlpha(color, alpha) {
    const parsed = this.parseColor(color);
    if (!parsed) return null;
    const { r, g, b } = parsed;
    const a = Math.max(0, Math.min(1, alpha));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  },

  darkenColor(color, factor) {
    const parsed = this.parseColor(color);
    if (!parsed) return null;
    const { h, s, l } = this.rgbToHsl(parsed.r, parsed.g, parsed.b);
    const f = typeof factor === "number" ? factor : 0.5;
    const nl = Math.max(0, Math.min(1, l * f));
    return this.hslToHex(h, s, nl);
  }
});
