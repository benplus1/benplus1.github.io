/* hero-splats.js: the hero background, a slowly orbiting field of soft elliptical
   gaussian splats drawn as WebGL2 point sprites (all motion runs in the vertex shader).
   The static CSS composition stays in place without WebGL2 or under
   prefers-reduced-motion; the loop pauses while the hero is offscreen or the tab is
   hidden. With ?debug in the URL it logs its frame timing once. */
'use strict';
(() => {
  const canvas = document.getElementById('hero-canvas');
  const hero = canvas && canvas.closest('.hero');
  if (!hero) return;
  const anchor = hero.querySelector('.hero-portrait');
  const DEBUG = new URLSearchParams(location.search).has('debug');
  const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');

  const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec4 a_orb;   // orbit radius, start angle, height, angular speed
layout(location = 1) in vec4 a_look;  // size, phase, hue, kind (0 disk, 1 dust)
uniform float u_t, u_intro, u_px, u_maxPt, u_gain, u_spark;
uniform vec2 u_cam, u_center, u_scale;
uniform mat3 u_tilt;
uniform vec3 u_c0, u_c1, u_c2;
out vec4 v_col;
out vec3 v_shape;
const float F = 2.6, CAM = 6.2;
vec2 proj(vec3 v) { return v.xy * u_scale * (F / -v.z); }
void main() {
  float ph = a_look.y, kind = a_look.w;
  float ang = a_orb.y + a_orb.w * u_t;
  vec3 p = vec3(a_orb.x * cos(ang), a_orb.z, a_orb.x * sin(ang));
  p += mix(0.05, 0.22, kind) * vec3(sin(u_t * 0.21 + ph * 6.1), sin(u_t * 0.17 + ph * 4.3), cos(u_t * 0.19 + ph * 5.7));
  vec3 scatter = vec3(sin(ph * 11.0), cos(ph * 7.0), sin(ph * 5.0));
  p = mix(p * 1.7 + scatter, p, u_intro);
  vec3 v = u_tilt * p - vec3(u_cam, CAM);
  float z = -v.z;
  if (z < 0.6) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; v_col = vec4(0.0); v_shape = vec3(1.0, 0.0, 1.0); return; }
  vec2 s = proj(v);
  vec2 d = (proj(v + u_tilt * vec3(-sin(ang), 0.0, cos(ang)) * 0.06) - s) / u_scale;
  float rot = mix(atan(d.y, d.x), ph * 25.13, kind);
  float size = a_look.x * u_px / z;
  float alpha = u_gain * mix(1.0, 0.6, kind) * smoothstep(0.6, 2.4, z) * u_intro;
  alpha *= 1.0 / (1.0 + size / 16.0);
  alpha *= 0.74 + 0.26 * sin(u_t * (0.8 + 2.4 * fract(ph * 7.31)) + ph * 37.0);
  alpha *= clamp(size / 1.25, 0.0, 1.0);
  size = clamp(size, 1.25, u_maxPt);
  float h = a_look.z;
  vec3 col = h < 0.5 ? mix(u_c2, u_c0, h * 2.0) : mix(u_c0, u_c1, h * 2.0 - 1.0);
  col = mix(col, vec3(1.0), u_spark * (1.0 - smoothstep(1.5, 4.0, size)));
  gl_Position = vec4(s + u_center, 0.0, 1.0);
  gl_PointSize = size;
  v_col = vec4(col * alpha, alpha);
  v_shape = vec3(cos(rot), sin(rot), mix(mix(0.24, 0.5, fract(ph * 5.3)), mix(0.55, 1.0, fract(ph * 3.7)), kind));
}`;
  const FS = `#version 300 es
precision mediump float;
in vec4 v_col;
in vec3 v_shape;  // major-axis direction (cos, sin), minor/major ratio
out vec4 o;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  q.y = -q.y;
  vec2 u = vec2(dot(q, v_shape.xy), dot(q, vec2(-v_shape.y, v_shape.x)) / v_shape.z);
  float g = exp(-4.0 * dot(u, u)) - 0.0183;  // gaussian, cut to zero at the sprite edge
  if (g <= 0.0) discard;
  o = v_col * (g * 1.0187);
}`;

  let gl = null, prog = null, vao = null, U = {};
  let total = 0, count = 0, raf = 0, onScreen = true, state = '';
  let t = 0, lastDraw = 0, frames = 0;
  let W = 1, H = 1, dpr = 1, px = 1, scale = [1, 1], center = [0.5, 0], maxPt = 64;
  let colors = null, dark = true;
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  const samples = [];
  let cpuSum = 0, adapted = false;

  const setState = (s, why) => {
    if (s === state) return;
    state = s;
    canvas.dataset.state = s;
    hero.classList.toggle('splats-live', s === 'running' || s === 'paused');
    if (DEBUG) console.info('[hero-splats] ' + s + (why ? ': ' + why : ''));
  };
  window.heroSplats = { get state() { return state; }, get frames() { return frames; }, get splats() { return count; } };

  // deterministic PRNG (mulberry32) so the field has the same shape on every load
  let seed = 0x5eed;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(6.2832 * rnd());

  function field(n) {
    const d = new Float32Array(n * 8);
    for (let i = 0; i < n; i++) {
      let r, a, y, w, size, hue, kind;
      if (rnd() < 0.64) { // a three-armed disk around the portrait, inner orbits a little faster
        kind = 0;
        r = 0.16 + 2.1 * Math.pow(rnd(), 0.8);
        a = Math.floor(rnd() * 3) * 2.0944 + r * 1.35 + gauss() * (0.12 + 0.08 * r);
        y = gauss() * (0.05 + 0.04 * r);
        w = 0.05 + 0.03 / (0.5 + r);
        size = rnd() < 0.08 ? 0.1 + 0.2 * rnd() : 0.018 + 0.08 * rnd() * rnd();
        hue = rnd() < 0.15 ? rnd() : Math.min(1, Math.max(0, r / 2.25 + gauss() * 0.15));
      } else { // dust through the whole hero volume, with a few broad blooms
        kind = 1;
        r = 0.6 + 6.6 * Math.sqrt(rnd());
        a = rnd() * 6.2832;
        y = gauss() * 1.6;
        w = 0.012 + 0.02 * rnd();
        size = rnd() < 0.02 ? 0.25 + 0.35 * rnd() : 0.012 + 0.045 * rnd() * rnd();
        hue = rnd();
      }
      d.set([r, a, y, w, size, rnd(), hue, kind], i * 8);
    }
    return d;
  }

  function shader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader compile failed: ' + gl.getShaderInfoLog(s));
    return s;
  }

  // tilt the disk about x (seen at an angle), then about z (a diagonal lean); column-major mat3
  function tilt(ax, az) {
    const cx = Math.cos(ax), sx = Math.sin(ax), cz = Math.cos(az), sz = Math.sin(az);
    return new Float32Array([cz, sz, 0, -sz * cx, cz * cx, sx, sz * sx, -cz * sx, cx]);
  }
  const TILT = tilt(0.46, -0.32);

  const probe = document.createElement('canvas').getContext('2d');
  function cssColor(name) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!v) console.warn('[hero-splats] CSS variable ' + name + ' is not set');
    probe.fillStyle = '#000';
    probe.fillStyle = v;
    const c = probe.fillStyle;
    if (c[0] === '#') return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
    return c.match(/[\d.]+/g).slice(0, 3).map((v) => v / 255);
  }
  function readTheme() {
    dark = document.documentElement.getAttribute('data-theme') !== 'light';
    colors = ['--grad-a', '--grad-b', '--grad-c'].map(cssColor);
    if (gl) gl.blendFunc(gl.ONE, dark ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
  }

  function resize() {
    if (!gl) return;
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = Math.max(1, Math.round(r.width * dpr));
    H = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const m = Math.min(W, H);
    scale = [m / W, m / H];
    px = 1.3 * m;
    if (anchor && r.width && r.height) {
      const a = anchor.getBoundingClientRect();
      center = [((a.left + a.width / 2 - r.left) / r.width) * 2 - 1, 1 - ((a.top + a.height / 2 - r.top) / r.height) * 2];
    }
    gl.viewport(0, 0, W, H);
  }

  function init() {
    gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
    if (!gl) {
      console.warn('[hero-splats] WebGL2 is unavailable; the hero keeps its static background');
      setState('fallback', 'no WebGL2');
      return false;
    }
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('program link failed: ' + gl.getProgramInfoLog(prog));
    } catch (err) {
      console.error('[hero-splats] disabled, the hero keeps its static background:', err);
      gl = null;
      setState('fallback', 'shader error');
      return false;
    }
    ['u_t', 'u_intro', 'u_px', 'u_maxPt', 'u_gain', 'u_spark', 'u_cam', 'u_center', 'u_scale', 'u_tilt', 'u_c0', 'u_c1', 'u_c2']
      .forEach((n) => { U[n] = gl.getUniformLocation(prog, n); });
    resize();
    total = count = (W / dpr) * (H / dpr) > 600000 ? 26000 : 16000;
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, field(total), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16);
    maxPt = Math.min(gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1], 256);
    gl.enable(gl.BLEND);
    readTheme();
    return true;
  }

  function draw() {
    const c0 = performance.now();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    const e = 1 - Math.pow(1 - Math.min(t / 2.4, 1), 3); // intro: the splats gather over 2.4 s
    gl.uniform1f(U.u_t, t);
    gl.uniform1f(U.u_intro, e);
    gl.uniform1f(U.u_px, px);
    gl.uniform1f(U.u_maxPt, maxPt);
    gl.uniform1f(U.u_gain, dark ? 0.7 : 0.5);
    gl.uniform1f(U.u_spark, dark ? 0.2 : 0);
    gl.uniform2f(U.u_cam, mouse.x * 0.45 + Math.sin(t * 0.11) * 0.12, -mouse.y * 0.28 + Math.cos(t * 0.083) * 0.08);
    gl.uniform2f(U.u_center, center[0], center[1]);
    gl.uniform2f(U.u_scale, scale[0], scale[1]);
    gl.uniformMatrix3fv(U.u_tilt, false, TILT);
    gl.uniform3fv(U.u_c0, colors[0]);
    gl.uniform3fv(U.u_c1, colors[1]);
    gl.uniform3fv(U.u_c2, colors[2]);
    gl.drawArrays(gl.POINTS, 0, count);
    cpuSum += performance.now() - c0;
  }

  function frame(ts) {
    raf = requestAnimationFrame(frame);
    // about 60 fps is plenty for slow drift; ?debug runs uncapped so the log shows the real frame cost
    if (!DEBUG && lastDraw && ts - lastDraw < 12.5) return;
    const dt = lastDraw ? Math.min(ts - lastDraw, 50) : 16.7;
    lastDraw = ts;
    t += dt / 1000;
    const k = 1 - Math.exp(-dt / 240);
    mouse.x += (mouse.tx - mouse.x) * k;
    mouse.y += (mouse.ty - mouse.y) * k;
    draw();
    if (++frames === 1) setState('running');
    if (frames > 30 && samples.length < 240) {
      samples.push(dt);
      if (samples.length === 120 && !adapted) adapt();
      if (samples.length === 240 && DEBUG) report();
    }
  }

  // a weak GPU gets fewer splats instead of a stuttering hero
  function adapt() {
    adapted = true;
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    if (mean > 24) {
      count = Math.round(count * 0.6);
      console.warn('[hero-splats] mean frame ' + mean.toFixed(1) + ' ms; drawing ' + count + ' of ' + total + ' splats');
    }
  }

  function report() {
    const s = samples.slice().sort((a, b) => a - b);
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2);
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    console.log('[hero-splats] ' + count + ' splats, ' + W + 'x' + H + ' px (dpr ' + +dpr.toFixed(2) + '), ' + gpu +
      ': mean frame ' + mean.toFixed(2) + ' ms (' + (1000 / mean).toFixed(1) + ' fps), median ' + q(0.5) +
      ' ms, p95 ' + q(0.95) + ' ms over ' + s.length + ' frames; draw call CPU ' + (cpuSum / frames).toFixed(2) + ' ms per frame');
  }

  function sync() {
    const run = !!gl && onScreen && !document.hidden && !reduceMQ.matches;
    if (run && !raf) {
      lastDraw = 0;
      raf = requestAnimationFrame(frame);
      if (frames) setState('running');
    } else if (!run && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
      if (gl) setState(reduceMQ.matches ? 'fallback' : 'paused', reduceMQ.matches ? 'prefers-reduced-motion' : 'offscreen or hidden');
    }
  }

  function start() {
    if (reduceMQ.matches) { setState('fallback', 'prefers-reduced-motion'); return; }
    if (!gl && !init()) return;
    sync();
  }

  reduceMQ.addEventListener('change', () => {
    if (reduceMQ.matches) { sync(); setState('fallback', 'prefers-reduced-motion'); } else start();
  });
  new IntersectionObserver((entries) => { onScreen = entries[entries.length - 1].isIntersecting; sync(); }).observe(canvas);
  document.addEventListener('visibilitychange', sync);
  new ResizeObserver(resize).observe(hero);
  new MutationObserver(readTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    mouse.tx = (e.clientX / innerWidth) * 2 - 1;
    mouse.ty = (e.clientY / innerHeight) * 2 - 1;
  }, { passive: true });
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    gl = null;
    console.warn('[hero-splats] WebGL context lost; the hero keeps its static background');
    setState('fallback', 'context lost');
  });
  canvas.addEventListener('webglcontextrestored', start);

  // start after the first paint so the canvas never competes with the portrait (the LCP image)
  requestAnimationFrame(() => setTimeout(start, 0));
})();
