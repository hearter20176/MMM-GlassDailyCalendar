const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The marquee track is a <span>. If a broader `.glass-marquee span` rule makes it
// inline, it measures 0 wide (no overflow is ever detected) and ignores transforms,
// so long titles never scroll. Guard the selectors that keep it inline-block.
const css = fs.readFileSync(path.join(__dirname, "..", "MMM-GlassDailyCalendar.css"), "utf8");

test("marquee track is inline-block via a selector that outranks `.glass-marquee span`", () => {
  const m = css.match(/\.glass-marquee\s*>\s*\.glass-marquee-track\s*\{([^}]*)\}/);
  const body = m && m[1];
  assert.ok(body, "expected a `.glass-marquee > .glass-marquee-track` rule");
  assert.match(body, /display:\s*inline-block/);
});

test("the inline reset for title text never targets the track itself", () => {
  assert.doesNotMatch(css, /\.glass-marquee span\s*[,{]/, "bare `.glass-marquee span` would also match the track");
  assert.match(css, /\.glass-marquee span:not\(\.glass-marquee-track\)/);
});
