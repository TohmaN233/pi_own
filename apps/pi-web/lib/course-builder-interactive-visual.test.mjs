import assert from "node:assert/strict";
import test from "node:test";
import { validateStandaloneInteractiveVisual } from "./course-builder-interactive-visual.ts";

test("accepts an offline standalone visualization with controls and a live plot", () => {
  const html=`<!doctype html><html><head><meta charset="utf-8"><title>LCG Explorer</title></head><body>
  <label>M <input id="m" type="range" min="2" max="64"></label><canvas id="plot"></canvas>
  <script>const c=document.querySelector('#plot');document.querySelector('#m').addEventListener('input',()=>c.getContext('2d').clearRect(0,0,c.width,c.height));</script>
  </body></html>`;
  const result=validateStandaloneInteractiveVisual(new TextEncoder().encode(html),"lcg-explorer.html");
  assert.equal(result.title,"LCG Explorer");
  assert.equal(result.hasControls,true);
  assert.equal(result.hasLiveGraphic,true);
});

test("rejects static pages and external runtime dependencies", () => {
  assert.throws(()=>validateStandaloneInteractiveVisual(new TextEncoder().encode("<!doctype html><html><head><title>Static trace</title></head><body><table><tr><td>trace output only</td></tr></table></body></html>"),"trace.html"),/inline JavaScript|interactive control/i);
  assert.throws(()=>validateStandaloneInteractiveVisual(new TextEncoder().encode("<html><body><input><canvas></canvas><script src='https://cdn.example/x.js'></script></body></html>"),"remote.html"),/external/i);
  assert.throws(()=>validateStandaloneInteractiveVisual(new TextEncoder().encode("<html><body><input><canvas></canvas><script>draw()</script></body></html>"),"wrong.txt"),/\.html/i);
});
