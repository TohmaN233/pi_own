// Course Builder integration: production builds must not download UI fonts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("application layout uses local font fallbacks without a build-time Google Fonts fetch", () => {
  const layout = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(layout, /from ["']next\/font\/google["']/);
  assert.match(layout, /--font-noto-mono/);
  assert.match(layout, /notranslate/);
});
