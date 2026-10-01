/* Lifecycle tests for MMM-GlassDailyCalendar.js: Lottie players must be bound to the exact
 * container elements built by getDom(), never leak across re-renders, ignore stale timers, and
 * honour MagicMirror suspend()/resume(). Uses a minimal fake DOM, fake Lottie and a fake clock -
 * there is no browser here. document.getElementById deliberately throws: id lookups bind to the
 * outgoing DOM that MagicMirror keeps attached during a fade, which is how the leak happens.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const MODULE_PATH = path.join(__dirname, "..", "MMM-GlassDailyCalendar.js");
const moment = require("moment");

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentNode = null;
    this.attached = false; // only meaningful on a root node
    this.classes = new Set();
    this.styleProps = {};
    this.style = { setProperty: (k, v) => (this.styleProps[k] = v) };
    this.attributes = {};
    this.textContent = "";
    this.innerHTML = "";
    const owner = this;
    this.classList = {
      add: (...names) => names.forEach((n) => owner.classes.add(n)),
      remove: (...names) => names.forEach((n) => owner.classes.delete(n)),
      toggle(name, force) {
        const on = force === undefined ? !owner.classes.has(name) : force;
        if (on) owner.classes.add(name);
        else owner.classes.delete(name);
        return on;
      },
      contains: (n) => owner.classes.has(n)
    };
  }
  get className() {
    return [...this.classes].join(" ");
  }
  set className(v) {
    this.classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  setAttribute(k, v) {
    this.attributes[k] = v;
  }
  addEventListener() {}
  querySelectorAll(sel) {
    const cls = String(sel).replace(/^\./, "");
    const out = [];
    this.children.forEach((c) =>
      c.walk((n) => {
        if (n.classes.has(cls)) out.push(n);
      })
    );
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  get clientWidth() {
    return this.classes.has("glass-marquee") ? 100 : 0;
  }
  get scrollWidth() {
    return this.classes.has("glass-marquee-track") ? 300 : 0;
  }
  animate() {
    const anim = {
      track: this,
      state: "running",
      cancelled: false,
      cancel() {
        this.cancelled = true;
        this.state = "idle";
      },
      pause() {
        if (!this.cancelled) this.state = "paused";
      },
      play() {
        if (!this.cancelled) this.state = "running";
      }
    };
    if (this.onAnimate) this.onAnimate(anim);
    return anim;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n.attached === true;
  }
  walk(fn) {
    fn(this);
    this.children.forEach((c) => c.walk(fn));
  }
}

const ANIM_DATA = { v: "5.7.0", layers: [] };

function setup(configOverrides = {}, { withLottie = true } = {}) {
  const clock = { now: 0, timers: new Map(), seq: 0 };
  const live = new Set(); // every non-destroyed fake player
  const created = [];
  const warnings = [];
  const scripts = []; // <script> elements appended to the body
  const optsSeen = [];
  const marquees = []; // every Animation created by track.animate()
  const observers = [];
  FakeElement.prototype.onAnimate = (anim) => marquees.push(anim);
  const body = new FakeElement("body");
  body.appendChild = (child) => {
    if (child.tagName === "script") scripts.push(child);
    return FakeElement.prototype.appendChild.call(body, child);
  };
  const fakeLottie = {
    loadAnimation(opts) {
      assert.ok(opts.container.isConnected, "player created for a detached container");
      optsSeen.push(opts);
      const player = {
        container: opts.container,
        paused: opts.autoplay === false,
        destroyed: false,
        destroy() {
          // Real Lottie empties the container on destroy; this is what makes a destroyed-but-
          // still-visible player show up as a blank icon.
          this.container.cleared = true;
          this.destroyed = true;
          live.delete(this);
        },
        pause() {
          this.paused = true;
        },
        play() {
          this.paused = false;
        }
      };
      live.add(player);
      created.push(player);
      return player;
    }
  };
  const sandbox = {
    Module: { register: (name, def) => (sandbox.def = def) },
    Log: { info() {}, log() {}, warn: (...a) => warnings.push(a.join(" ")), error() {} },
    config: {},
    moment,
    window: undefined,
    navigator: undefined,
    console,
    document: {
      body,
      createElement: (tag) => new FakeElement(tag),
      createTextNode: (text) => {
        const node = new FakeElement("#text");
        node.textContent = String(text);
        return node;
      },
      getElementById() {
        throw new Error("getElementById must not be used to bind players");
      }
    },
    setTimeout(fn, ms) {
      const id = ++clock.seq;
      clock.timers.set(id, { fn, at: clock.now + (ms || 0) });
      return id;
    },
    clearTimeout(id) {
      clock.timers.delete(id);
    },
    setInterval() {
      return ++clock.seq;
    },
    clearInterval() {},
    ResizeObserver: class {
      constructor(cb) {
        this.cb = cb;
        this.boxes = [];
        this.disconnected = false;
        observers.push(this);
      }
      observe(el) {
        this.boxes.push(el);
      }
      disconnect() {
        this.disconnected = true;
      }
    }
  };
  if (withLottie) sandbox.lottie = fakeLottie;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MODULE_PATH, "utf8"), sandbox, { filename: MODULE_PATH });
  const inst = Object.assign({}, sandbox.def, {
    name: "MMM-GlassDailyCalendar",
    identifier: "module_1_MMM-GlassDailyCalendar",
    config: Object.assign(
      { performanceProfile: "full", reduceMotion: false, theme: "dark", icalSources: [] },
      sandbox.def.defaults,
      { performanceProfile: "full", reduceMotion: false, theme: "dark", icalSources: [] },
      configOverrides
    ),
    file: (f) => `/modules/MMM-GlassDailyCalendar/${f}`,
    sendSocketNotification() {},
    sendNotification() {},
    updateDom() {}
  });
  inst.start();
  inst.loaded = true;
  if (configOverrides.marqueeEvents) {
    const t0 = moment().startOf("day").add(9, "hours");
    inst.events = [1, 2, 3].map((i) => ({
      title: `A very long event title number ${i} that needs a marquee`,
      startDate: t0.clone().add(i, "hours"),
      endDate: t0.clone().add(i + 1, "hours"),
      calendarName: "Cal",
      allDay: false
    }));
  }
  inst.weatherSummary = { condition: "Sunny", temperature: 70, isDaytime: true };
  const day = (n) => moment().add(n, "days").format("YYYY-MM-DD");
  inst.forecastDays = [1, 2, 3, 4, 5, 6].map((n) => ({
    date: day(n),
    shortForecast: n % 2 ? "Rain Showers" : "Mostly Sunny",
    high: 60 + n
  }));
  const tick = (ms) => {
    const end = clock.now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of clock.timers) {
        if (t.at <= end && (!next || t.at < next.t.at)) next = { id, t };
      }
      if (!next) break;
      clock.timers.delete(next.id);
      clock.now = Math.max(clock.now, next.t.at);
      next.t.fn();
    }
    clock.now = end;
  };
  // Runs each live observer's callback for its attached boxes (a layout pass in the browser).
  const layout = () =>
    observers.forEach((o) => {
      if (o.disconnected) return;
      const entries = o.boxes.filter((b) => b.isConnected).map((b) => ({ target: b }));
      if (entries.length) o.cb(entries);
    });
  return {
    inst, sandbox, fakeLottie, live, created, clock, tick, warnings, scripts, optsSeen,
    marquees, observers, layout
  };
}

function iconContainers(root) {
  const out = [];
  root.walk((n) => {
    if (n.classes.has("glass-weather-lottie")) out.push(n);
  });
  return out;
}

// Mimics MagicMirror updateDom: the new tree is built while the old one is attached, then swapped.
function swapIn(prev, next) {
  if (prev) prev.attached = false;
  next.attached = true;
}

test("sanity: the fixture renders several weather icon containers", () => {
  const { inst } = setup();
  const dom = inst.getDom();
  assert.ok(iconContainers(dom).length >= 3);
});

test("after N re-renders live players equal icons on screen, none on detached containers", () => {
  const { inst, live, tick } = setup();
  let current = null;
  for (let i = 0; i < 8; i++) {
    const next = inst.getDom();
    tick(300); // old DOM still attached during the fade; new DOM not yet
    swapIn(current, next);
    inst.notificationReceived("MODULE_DOM_UPDATED");
    tick(200);
    current = next;
  }
  const icons = iconContainers(current);
  assert.ok(icons.length >= 3);
  assert.equal(live.size, icons.length);
  const bound = new Set();
  for (const p of live) {
    assert.ok(p.container.isConnected, "player bound to a detached container");
    assert.ok(icons.includes(p.container));
    assert.ok(!bound.has(p.container), "two players for one container");
    bound.add(p.container);
  }
});

test("players are not created before the new DOM is attached", () => {
  const { inst, live, created, tick } = setup();
  inst.getDom();
  tick(5000);
  assert.equal(created.length, 0);
  assert.equal(live.size, 0);
});

test("old players keep running during the fade and are destroyed once the swap happens", () => {
  const { inst, live, created, tick } = setup();
  const first = inst.getDom();
  swapIn(null, first);
  tick(200);
  const n = iconContainers(first).length;
  assert.equal(live.size, n);
  const second = inst.getDom();
  tick(300); // fade in progress: old tree still attached, icons must not blink out
  assert.equal(live.size, n);
  assert.ok(created.every((p) => !p.container.cleared));
  swapIn(first, second);
  inst.notificationReceived("MODULE_DOM_UPDATED");
  assert.equal(live.size, n);
  assert.equal(created.filter((p) => p.destroyed).length, n);
  for (const p of live) assert.ok(p.container.isConnected);
});

test("when MagicMirror skips the swap the old players stay alive and nothing leaks", () => {
  const { inst, live, created, tick } = setup();
  const first = inst.getDom();
  swapIn(null, first);
  tick(200);
  const n = iconContainers(first).length;
  for (let i = 0; i < 5; i++) {
    inst.getDom(); // new tree is never attached: MM saw identical markup and kept the old DOM
    inst.notificationReceived("MODULE_DOM_UPDATED"); // MM still reports the (skipped) update
    tick(10000);
  }
  assert.equal(live.size, n);
  assert.equal(created.length, n);
  for (const p of live) {
    assert.ok(p.container.isConnected);
    assert.ok(!p.container.cleared, "visible icon was blanked");
  }
  // A later real swap recovers cleanly.
  const next = inst.getDom();
  swapIn(first, next);
  inst.notificationReceived("MODULE_DOM_UPDATED");
  assert.equal(live.size, n);
  const icons = iconContainers(next);
  for (const p of live) assert.ok(icons.includes(p.container));
});

test("swap landing after the poll gives up is reaped and bound on MODULE_DOM_UPDATED", () => {
  const { inst, live, created, tick } = setup();
  const a = inst.getDom();
  swapIn(null, a);
  tick(200);
  const n = iconContainers(a).length;
  const b = inst.getDom();
  tick(6000); // poll exhausted while the old tree is still attached
  swapIn(a, b);
  inst.notificationReceived("MODULE_DOM_UPDATED");
  assert.equal(live.size, n);
  const icons = iconContainers(b);
  for (const p of live) {
    assert.ok(p.container.isConnected, "orphaned player on a detached container");
    assert.ok(icons.includes(p.container));
    assert.ok(!p.paused);
  }
  assert.equal(created.filter((p) => p.destroyed).length, n);
});

test("the start retry loop for a never-attached tree is bounded", () => {
  const { inst, clock, tick, warnings } = setup();
  inst.getDom();
  tick(60000);
  assert.equal(clock.timers.size, 0);
  assert.ok(warnings.some((w) => /Gave up waiting/.test(w)));
});

test("pending timers from an older render do nothing", () => {
  const { inst, live, tick } = setup();
  const stale = inst.getDom(); // superseded before MagicMirror swapped it in
  tick(150);
  const fresh = inst.getDom();
  // Even if the stale tree becomes attached, its timers must not bind players to it.
  stale.attached = true;
  tick(1000);
  stale.attached = false;
  swapIn(null, fresh);
  tick(1000);
  const freshIcons = iconContainers(fresh);
  assert.equal(live.size, freshIcons.length);
  for (const p of live) assert.ok(freshIcons.includes(p.container));
});

test("hidden renders create nothing: renders while suspended bind no players until resume", () => {
  const { inst, live, clock, tick } = setup();
  inst.suspend();
  inst.hidden = true;
  let current = null;
  for (let i = 0; i < 5; i++) {
    const next = inst.getDom(); // MM swaps immediately while hidden
    swapIn(current, next);
    inst.notificationReceived("MODULE_DOM_UPDATED");
    tick(3000);
    current = next;
  }
  assert.equal(live.size, 0);
  assert.equal(clock.timers.size, 0);
  inst.hidden = false;
  inst.resume();
  assert.equal(live.size, iconContainers(current).length);
  assert.ok([...live].every((p) => p.container.isConnected && !p.paused));
});

test("suspend pauses all players and stops pending timers; resume plays them", () => {
  const { inst, live, clock, tick } = setup();
  const dom = inst.getDom();
  swapIn(null, dom);
  tick(200);
  assert.ok(live.size >= 3);
  inst.getDom(); // leaves a pending poll for the never-attached tree
  assert.ok(clock.timers.size >= 1);
  inst.suspend();
  assert.ok([...live].every((p) => p.paused));
  assert.equal(clock.timers.size, 0);
  inst.resume();
  assert.ok([...live].every((p) => !p.paused));
});

test("resume after a DOM swap that happened while suspended binds to the new tree", () => {
  const { inst, live } = setup();
  const a = inst.getDom();
  swapIn(null, a);
  inst.notificationReceived("MODULE_DOM_UPDATED");
  inst.suspend();
  const b = inst.getDom();
  swapIn(a, b);
  inst.resume();
  const icons = iconContainers(b);
  assert.equal(live.size, icons.length);
  for (const p of live) assert.ok(icons.includes(p.container));
});

test("resume plays previous-render players left on screen by a dropped swap", () => {
  const { inst, live, tick, warnings } = setup();
  const a = inst.getDom();
  swapIn(null, a);
  tick(200);
  const n = live.size;
  inst.getDom(); // swap dropped (module hidden within the fade)
  tick(200);
  inst.suspend();
  assert.ok([...live].every((p) => p.paused));
  inst.resume();
  assert.equal(live.size, n);
  assert.ok([...live].every((p) => !p.paused));
  tick(10000);
  assert.ok(!warnings.some((w) => /Gave up waiting/.test(w)), "spurious warning for a benign skipped swap");
});

test("dropped resume(): a render while MM reports the module visible still binds players", () => {
  const { inst, live, tick } = setup();
  const a = inst.getDom();
  swapIn(null, a);
  tick(200);
  inst.suspend();
  inst.hidden = false; // MM started showing the module; its resume() call was then dropped
  const b = inst.getDom();
  swapIn(a, b);
  inst.notificationReceived("MODULE_DOM_UPDATED");
  tick(200);
  assert.equal(live.size, iconContainers(b).length);
  assert.ok([...live].every((p) => p.container.isConnected && !p.paused));
});

test("hidden module stays suspended: no players are created while MM reports hidden", () => {
  const { inst, live, tick } = setup();
  inst.suspend();
  inst.hidden = true;
  const dom = inst.getDom();
  swapIn(null, dom);
  inst.notificationReceived("MODULE_DOM_UPDATED");
  tick(2000);
  assert.equal(live.size, 0);
});

test("animationData (object) sources are tracked, bound and reaped like path sources", () => {
  const { inst, live, optsSeen, created, tick } = setup();
  inst.getLottieForCondition = () => ANIM_DATA;
  const a = inst.getDom();
  swapIn(null, a);
  tick(200);
  const n = iconContainers(a).length;
  assert.equal(live.size, n);
  assert.ok(optsSeen.every((o) => o.animationData === ANIM_DATA && o.path === undefined));
  const b = inst.getDom();
  swapIn(a, b);
  inst.notificationReceived("MODULE_DOM_UPDATED");
  assert.equal(live.size, n);
  assert.equal(created.filter((p) => p.destroyed).length, n);
  for (const p of live) assert.ok(p.container.isConnected);
});

test("string sources resolve through resolveLottiePath", () => {
  const { inst, optsSeen, tick } = setup();
  const a = inst.getDom();
  swapIn(null, a);
  tick(200);
  assert.ok(optsSeen.length >= 3);
  assert.ok(optsSeen.every((o) => /^\/modules\/MMM-AmbientWeather\/animations\//.test(o.path)));
});

test("lazy script load: one injection, players bound to the current tree on load", () => {
  const { inst, sandbox, fakeLottie, live, scripts, tick } = setup({}, { withLottie: false });
  const a = inst.getDom();
  swapIn(null, a);
  inst.notificationReceived("MODULE_DOM_UPDATED");
  inst.notificationReceived("MODULE_DOM_UPDATED");
  tick(500);
  assert.equal(scripts.length, 1, "lottie script injected more than once");
  assert.equal(live.size, 0);
  sandbox.lottie = fakeLottie; // the script has executed
  scripts[0].onload();
  const icons = iconContainers(a);
  assert.equal(live.size, icons.length);
  assert.ok([...live].every((p) => p.container.isConnected && !p.paused));
});

test("lazy script load race: a container that detached while loading never gets a player", () => {
  const { inst, sandbox, fakeLottie, live, scripts, tick } = setup({}, { withLottie: false });
  const a = inst.getDom();
  swapIn(null, a);
  inst.notificationReceived("MODULE_DOM_UPDATED");
  assert.equal(scripts.length, 1);
  const b = inst.getDom(); // supersedes a; a is swapped out while the script loads
  swapIn(a, b);
  sandbox.lottie = fakeLottie;
  scripts[0].onload(); // fakeLottie asserts every container it receives is connected
  const icons = iconContainers(b);
  assert.equal(live.size, icons.length);
  for (const p of live) assert.ok(icons.includes(p.container));
  tick(1000);
  assert.equal(scripts.length, 1);
});

test("lazy script load while suspended creates nothing until resume", () => {
  const { inst, sandbox, fakeLottie, live, scripts } = setup({}, { withLottie: false });
  const a = inst.getDom();
  swapIn(null, a);
  inst.notificationReceived("MODULE_DOM_UPDATED");
  inst.suspend();
  inst.hidden = true;
  sandbox.lottie = fakeLottie;
  scripts[0].onload();
  assert.equal(live.size, 0);
  inst.hidden = false;
  inst.resume();
  assert.equal(live.size, iconContainers(a).length);
});

test("a failed lazy script load is not retried on every render", () => {
  const { inst, scripts } = setup({}, { withLottie: false });
  const a = inst.getDom();
  swapIn(null, a);
  inst.notificationReceived("MODULE_DOM_UPDATED");
  scripts[0].onerror();
  for (let i = 0; i < 3; i++) {
    const next = inst.getDom();
    swapIn(a, next);
    inst.notificationReceived("MODULE_DOM_UPDATED");
  }
  assert.equal(scripts.length, 1);
});

test("reduced motion never creates players or timers and renders static icons", () => {
  const { inst, live, clock, scripts } = setup({ reduceMotion: true });
  const dom = inst.getDom();
  swapIn(null, dom);
  inst.notificationReceived("MODULE_DOM_UPDATED");
  assert.equal(iconContainers(dom).length, 0);
  assert.equal(live.size, 0);
  assert.equal(clock.timers.size, 0);
  assert.equal(scripts.length, 0);
});

test("a throwing lottie.loadAnimation is contained and not retried", () => {
  const { inst, fakeLottie, live, tick } = setup();
  let calls = 0;
  fakeLottie.loadAnimation = () => {
    calls++;
    throw new Error("bad animation");
  };
  const dom = inst.getDom();
  swapIn(null, dom);
  tick(1000);
  const n = calls;
  assert.ok(n >= 3);
  tick(5000);
  assert.equal(calls, n);
  assert.equal(live.size, 0);
});

// ---- Title marquee (Web Animations) lifecycle ------------------------------------------------

const MQ = { marqueeEvents: true };

function marqueeTracks(root) {
  const out = [];
  root.walk((n) => {
    if (n.classes.has("glass-marquee-track")) out.push(n);
  });
  return out;
}

const running = (marquees) => marquees.filter((a) => !a.cancelled);

test("marquee: N re-renders keep only on-screen animations, detached ones are cancelled", () => {
  const { inst, marquees, layout, tick } = setup(MQ);
  let current = null;
  for (let i = 0; i < 8; i++) {
    const next = inst.getDom();
    tick(300);
    swapIn(current, next);
    layout();
    inst.notificationReceived("MODULE_DOM_UPDATED");
    current = next;
  }
  const tracks = marqueeTracks(current);
  assert.ok(tracks.length >= 3);
  const live = running(marquees);
  assert.equal(live.length, tracks.length);
  for (const a of live) {
    assert.ok(a.track.isConnected, "live marquee on a detached track");
    assert.ok(tracks.includes(a.track));
  }
  assert.equal(marquees.length, tracks.length * 8);
});

test("marquee: a skipped swap keeps the visible titles animating", () => {
  const { inst, marquees, layout, tick } = setup(MQ);
  const a = inst.getDom();
  swapIn(null, a);
  layout();
  const n = running(marquees).length;
  assert.ok(n >= 3);
  for (let i = 0; i < 4; i++) {
    inst.getDom(); // never attached
    layout();
    inst.notificationReceived("MODULE_DOM_UPDATED");
    tick(10000);
  }
  assert.equal(running(marquees).length, n);
  assert.ok(running(marquees).every((x) => x.track.isConnected && x.state === "running"));
});

test("marquee: swap landing after the poll gave up is reaped on MODULE_DOM_UPDATED", () => {
  const { inst, marquees, layout, tick } = setup(MQ);
  const a = inst.getDom();
  swapIn(null, a);
  layout();
  const b = inst.getDom();
  tick(6000);
  swapIn(a, b);
  layout();
  inst.notificationReceived("MODULE_DOM_UPDATED");
  const tracks = marqueeTracks(b);
  assert.equal(running(marquees).length, tracks.length);
  assert.ok(running(marquees).every((x) => tracks.includes(x.track)));
});

test("marquee: a resize re-measure replaces the track's animation without leaking", () => {
  const { inst, marquees, layout } = setup(MQ);
  const a = inst.getDom();
  swapIn(null, a);
  layout();
  const n = running(marquees).length;
  layout();
  layout();
  assert.equal(running(marquees).length, n);
  assert.equal(inst.marqueeAnims.length, n);
});

test("marquee: suspend pauses, resume plays, and animations created while hidden stay paused", () => {
  const { inst, marquees, layout } = setup(MQ);
  const a = inst.getDom();
  swapIn(null, a);
  layout();
  inst.suspend();
  assert.ok(running(marquees).every((x) => x.state === "paused"));
  inst.resume();
  assert.ok(running(marquees).every((x) => x.state === "running"));
  inst.suspend();
  inst.hidden = true;
  const b = inst.getDom();
  swapIn(a, b);
  layout();
  inst.notificationReceived("MODULE_DOM_UPDATED");
  const tracks = marqueeTracks(b);
  assert.equal(running(marquees).length, tracks.length);
  assert.ok(running(marquees).every((x) => x.state === "paused"));
  inst.hidden = false;
  inst.resume();
  assert.ok(running(marquees).every((x) => x.state === "running"));
});

test("marquee: dropped resume() (hidden === false) plays animations on the next update", () => {
  const { inst, marquees, layout } = setup(MQ);
  const a = inst.getDom();
  swapIn(null, a);
  layout();
  inst.suspend();
  inst.hidden = false;
  const b = inst.getDom();
  swapIn(a, b);
  layout();
  inst.notificationReceived("MODULE_DOM_UPDATED");
  assert.ok(running(marquees).length >= 3);
  assert.ok(running(marquees).every((x) => x.state === "running"));
});

test("marquee: with Lottie disabled detached marquees are still reaped, suspend/resume still work", () => {
  const { inst, marquees, layout } = setup(MQ);
  inst.enableLottie = false;
  let current = null;
  for (let i = 0; i < 5; i++) {
    const next = inst.getDom();
    swapIn(current, next);
    layout();
    inst.notificationReceived("MODULE_DOM_UPDATED");
    current = next;
  }
  const tracks = marqueeTracks(current);
  assert.equal(running(marquees).length, tracks.length);
  assert.ok(running(marquees).every((x) => x.track.isConnected));
  inst.suspend();
  assert.ok(running(marquees).every((x) => x.state === "paused"));
  inst.resume();
  assert.ok(running(marquees).every((x) => x.state === "running"));
});

test("marquee: the previous render's ResizeObserver is disconnected on every getDom()", () => {
  const { inst, observers } = setup(MQ);
  inst.getDom();
  inst.getDom();
  inst.getDom();
  assert.equal(observers.length, 3);
  assert.ok(observers.slice(0, 2).every((o) => o.disconnected));
  assert.ok(!observers[2].disconnected);
});
