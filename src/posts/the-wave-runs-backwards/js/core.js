/* ============================================================================
   core.js — shared traffic-flow model
   ----------------------------------------------------------------------------
   Longitudinal motion is the Intelligent Driver Model (Treiber, Hennecke &
   Helbing 2000). Everything else here is scaffolding: a seeded RNG so two
   scenarios can be compared against an identical arrival sequence, a linear
   regression for pulling saturation headway out of stop-line crossings, and
   the congestion colour ramp.
   ========================================================================== */
(function (global) {
  'use strict';

  var T = (global.Traffic = global.Traffic || {});

  /* -- constants ----------------------------------------------------------- */

  T.CAR_LEN = 4.8;          // metres, bumper to bumper
  T.KMH = 3.6;              // m/s -> km/h

  /* -- small utilities ----------------------------------------------------- */

  T.clamp = function (x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); };

  /* mulberry32: tiny, fast, and deterministic given a seed. Determinism is
     load-bearing — the merge comparison is only fair if every strategy sees
     the same vehicles arriving at the same instants. */
  T.rng = function (seed) {
    var s = seed >>> 0;
    var f = function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    /* Box-Muller, cached second variate */
    var spare = null;
    f.normal = function (mean, sd) {
      if (spare !== null) { var v = spare; spare = null; return mean + sd * v; }
      var u1 = Math.max(f(), 1e-12), u2 = f();
      var r = Math.sqrt(-2 * Math.log(u1));
      spare = r * Math.sin(2 * Math.PI * u2);
      return mean + sd * r * Math.cos(2 * Math.PI * u2);
    };
    /* exponential gap — turns a flow rate into Poisson arrivals */
    f.exponential = function (rate) {
      return -Math.log(Math.max(f(), 1e-12)) / rate;
    };
    return f;
  };

  /* least-squares fit of y = slope*x + intercept */
  T.linfit = function (xs, ys) {
    var n = xs.length;
    if (n < 2) return null;
    var sx = 0, sy = 0, sxx = 0, sxy = 0, i;
    for (i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
    var d = n * sxx - sx * sx;
    if (Math.abs(d) < 1e-9) return null;
    var slope = (n * sxy - sx * sy) / d;
    return { slope: slope, intercept: (sy - slope * sx) / n };
  };

  /* -- the car-following model -------------------------------------------- */

  /**
   * IDM acceleration.
   * @param v    own speed (m/s)
   * @param dv   approach rate, v - vLeader (positive = closing)
   * @param gap  clear distance to the object ahead (m)
   * @param p    {v0, T, a, b, s0}
   */
  T.idmAccel = function (v, dv, gap, p) {
    var sStar = p.s0 + Math.max(0, v * p.T + (v * dv) / (2 * Math.sqrt(p.a * p.b)));
    var g = Math.max(gap, 0.25);
    var ratio = sStar / g;
    var free = 1 - Math.pow(v / p.v0, 4);
    /* -9 m/s^2 is roughly a panic stop; the floor keeps a near-zero gap from
       producing an unphysical impulse that would fling cars backwards. */
    return T.clamp(p.a * (free - ratio * ratio), -9, p.a);
  };

  /* Default driver parameters. v0 is overwritten per-scenario. */
  T.defaultDriver = function () {
    return { v0: 13.9, T: 1.2, a: 1.8, b: 2.4, s0: 2.0 };
  };

  /* -- vehicle ------------------------------------------------------------- */

  var nextId = 1;

  T.Vehicle = function (x, v, p) {
    this.id = nextId++;
    this.x = x;               // front bumper, metres
    this.v = v;
    this.a = 0;
    this.p = p;               // driver parameters (may be per-vehicle)
    this.lane = 0;
    /* start-up bookkeeping */
    this.queued = false;      // has come to rest and is waiting
    this.launchAt = null;     // time this driver is permitted to move again
    this.movedAt = null;      // time speed first exceeded MOVING
    this.xAtCue = null;       // position when the release cue arrived
    /* trip bookkeeping */
    this.enteredAt = 0;
    this.crossedAt = null;
    /* merge bookkeeping */
    this.mergeAt = null;      // x at which this driver intends to change lanes
    this.merged = false;
    this.waiting = 0;         // seconds spent stuck at the taper
  };

  T.STOPPED = 0.15;   // m/s — below this a vehicle counts as queued
  T.MOVING = 0.35;    // m/s — above this the driver behind perceives motion

  /* ------------------------------------------------------------------------
     Start-up release.

     This is the mechanism the whole first half of the post is about. A stopped
     driver does not accelerate the instant their path clears; they accelerate
     `tau` seconds later. Which cue they are waiting on depends on what is
     actually blocking them — the signal, or the car in front.

     Setting tau to 0 gives the physically-possible-but-humanly-impossible case
     where an entire queue launches as one body.
     ---------------------------------------------------------------------- */
  T.updateRelease = function (car, t, tau, leaderGap, signalGap, leader, signalGreenAt) {
    /* Re-arm once the vehicle has come to rest. */
    if (!car.queued && car.v < T.STOPPED) {
      car.queued = true;
      car.launchAt = null;
      car.movedAt = null;
      car.xAtCue = null;
    }
    if (car.queued && car.v > 0.5) car.queued = false;
    if (!car.queued) {
      if (car.movedAt === null && car.v > T.MOVING) car.movedAt = t;
      return true;
    }

    if (car.launchAt === null) {
      var cue = null;
      if (leader && leaderGap <= signalGap) {
        /* the car ahead is the binding constraint — wait for it to move */
        if (leader.movedAt !== null) cue = leader.movedAt;
      } else if (signalGreenAt !== null) {
        /* the signal is the binding constraint. Note the `leader &&` above:
           on green both gaps are Infinity, and without it the front vehicle
           would take the leader branch, find no leader, and never launch. */
        cue = signalGreenAt;
      }
      if (cue !== null) {
        car.launchAt = cue + tau;
        car.xAtCue = car.x;
      }
    }

    var free = car.launchAt !== null && t >= car.launchAt;
    if (free && car.movedAt === null && car.v > T.MOVING) car.movedAt = t;
    return free;
  };

  /* -- congestion colour ramp ---------------------------------------------
     Speed is a magnitude, so this is a sequential ramp, not a categorical one.
     It runs neutral -> amber -> deep red as speed falls: "nothing wrong" reads
     as an ordinary silver car, and trouble glows. Deliberately NOT red/green —
     that pair collapses to a delta-E of 4 under deuteranopia. Analogous warm
     hues survive it, because the difference is carried by lightness.
     Always shipped with a scale legend, and never the only cue: the numeric
     speed readout carries the same information. */
  var RAMP_LIGHT = [
    [0.00, [176, 46, 34]],    // stopped
    [0.35, [214, 122, 44]],
    [0.70, [196, 172, 120]],
    [1.00, [176, 183, 189]]   // free flow — reads as "just a car"
  ];
  var RAMP_DARK = [
    [0.00, [198, 58, 44]],
    [0.35, [226, 138, 52]],
    [0.70, [176, 152, 104]],
    [1.00, [124, 133, 142]]
  ];

  T.congestionColor = function (ratio, dark) {
    var stops = dark ? RAMP_DARK : RAMP_LIGHT;
    var r = T.clamp(ratio, 0, 1), i;
    for (i = 0; i < stops.length - 1; i++) {
      if (r <= stops[i + 1][0]) {
        var t0 = stops[i][0], t1 = stops[i + 1][0];
        var f = (r - t0) / (t1 - t0);
        var c0 = stops[i][1], c1 = stops[i + 1][1];
        return 'rgb(' + Math.round(c0[0] + f * (c1[0] - c0[0])) + ',' +
                        Math.round(c0[1] + f * (c1[1] - c0[1])) + ',' +
                        Math.round(c0[2] + f * (c1[2] - c0[2])) + ')';
      }
    }
    var last = stops[stops.length - 1][1];
    return 'rgb(' + last[0] + ',' + last[1] + ',' + last[2] + ')';
  };

  /* -- canvas helper ------------------------------------------------------- */

  T.fitCanvas = function (canvas) {
    var dpr = global.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  };

  /* Reads the live CSS custom properties so the canvases follow the page theme
     without duplicating the palette in JS. Cached, because this runs once per
     canvas per frame and getComputedStyle forces layout; boot.js invalidates
     it whenever the theme actually changes. */
  var themeCache = null;
  T.invalidateTheme = function () { themeCache = null; };

  T.theme = function (el) {
    if (themeCache) return themeCache;
    var cs = getComputedStyle(document.documentElement);
    var get = function (n, fb) { return (cs.getPropertyValue(n) || '').trim() || fb; };
    themeCache = {
      dark: get('--dark-flag', '0') === '1',
      ink: get('--ink', '#14181b'),
      inkSoft: get('--ink-2', '#565e64'),
      muted: get('--ink-3', '#828b92'),
      surface: get('--surface', '#f7f8f8'),
      grid: get('--rule', '#d3d8da'),
      asphalt: get('--asphalt', '#3a3f44'),
      asphaltEdge: get('--asphalt-edge', '#4c5257'),
      accent: get('--accent', '#00694a'),
      s1: get('--s1', '#2a78d6'),
      s2: get('--s2', '#eb6834'),
      s3: get('--s3', '#1baf7a'),
      marking: get('--marking', '#e8e2c8'),
      cone: get('--cone', '#e8630a'),
      go: get('--sig-go', '#22a06b'),
      caution: get('--sig-caution', '#e0a010'),
      stop: get('--sig-stop', '#cc332b')
    };
    return themeCache;
  };

  /* rounded rect that works without ctx.roundRect (older Safari) */
  T.roundRect = function (ctx, x, y, w, h, r) {
    var rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  };

  T.reducedMotion = function () {
    return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  };

})(window);
