/* ============================================================================
   light-sim.js — start-up waves at a signalised intersection
   ----------------------------------------------------------------------------
   Two identical streams of traffic meet the same signal with the same arrivals.
   The only difference is reaction time: one stream is human, the other releases
   the whole queue the instant the light changes. Everything the post claims
   about start-up lost time falls out of that one parameter.
   ========================================================================== */
(function (global) {
  'use strict';

  var T = global.Traffic;
  var CAR_LEN = T.CAR_LEN;

  var X_SPAWN = -1600;  // metres upstream of the stop line
  var X_EXIT = 160;     // metres downstream, where vehicles are retired
  var VIEW_MIN = -300;  // visible window
  var VIEW_MAX = 60;
  var TRACE_WINDOW = 100; // seconds retained by the space-time diagram

  /* The gap a driver keeps once rolling, and how close the first vehicle parks
     to the stop line. Both are separate from the gap a driver leaves when
     *parking* behind a stationary car, which is the slider. Conflating those two
     is the difference between "I left room so I can go" and "I permanently drive
     four metres further back", and only the first is what the reader is asking
     about. */
  var MOVE_GAP = 2.0;
  var LINE_GAP = 1.0;

  /* ------------------------------------------------------------------------
     A Stream is one lane: a queue of vehicles, its own reaction time, and its
     own tally of what got through.
     ---------------------------------------------------------------------- */

  function Stream(tau, label, lockstep) {
    this.tau = tau;
    this.label = label;
    /* A lockstep stream is the physically impossible ideal: the whole standing
       queue accelerates as one body the instant the light changes, holding its
       stopped spacing. Nobody waits to react, and — unlike the zero-reaction
       stream — nobody waits for room to open either. It is what a train does. */
    this.lockstep = !!lockstep;
    this.cars = [];        // ordered downstream -> upstream (index 0 leads)
    this.platoon = [];     // stop-line crossing times in the current green
    this.launches = [];    // {x, t} release events in the current green
    this.history = [];     // last few completed greens
    this.delays = [];      // rolling per-vehicle delay samples
    this.traces = new Map();
    this.crossedTotal = 0;
  }

  Stream.prototype.reset = function () {
    this.cars.length = 0;
    this.platoon.length = 0;
    this.launches.length = 0;
    this.history.length = 0;
    this.delays.length = 0;
    this.traces.clear();
    this.crossedTotal = 0;
  };

  /* Queue length in metres: distance from the stop line back to the last
     stopped vehicle. */
  Stream.prototype.queueLength = function () {
    var back = 0;
    for (var i = 0; i < this.cars.length; i++) {
      var c = this.cars[i];
      if (c.v < 1.0 && c.x < 2) back = Math.min(back, c.x);
    }
    return -back;
  };

  /* Mean centre-to-centre spacing of consecutive stopped vehicles. This is the
     clean geometric quantity: queue length divided by queue count is unstable,
     because a single vehicle stopping far behind a cleared queue inflates the
     length without adding to the count. */
  Stream.prototype.queuePitch = function () {
    var xs = [], i;
    for (i = 0; i < this.cars.length; i++) {
      var c = this.cars[i];
      if (c.v < 1.0 && c.x < 2) xs.push(c.x);
    }
    if (xs.length < 3) return null;
    xs.sort(function (a, b) { return b - a; });
    var gaps = [];
    for (i = 1; i < xs.length; i++) {
      var d = xs[i - 1] - xs[i];
      if (d > 0 && d < 40) gaps.push(d);   // skip breaks between separate queues
    }
    if (!gaps.length) return null;
    var s = 0;
    for (i = 0; i < gaps.length; i++) s += gaps[i];
    return s / gaps.length;
  };

  Stream.prototype.queueCount = function () {
    var n = 0;
    for (var i = 0; i < this.cars.length; i++) {
      if (this.cars[i].v < 1.0 && this.cars[i].x < 2) n++;
    }
    return n;
  };

  /* Close out a green and fold its numbers into the rolling history.

     Saturation headway and start-up lost time come from the textbook
     construction: regress crossing time against queue position over the
     saturated part of the platoon (vehicle 5 onward), then read the slope as
     the headway and extrapolate back to vehicle zero for the lost time. */
  Stream.prototype.closeGreen = function (greenStart) {
    var p = this.platoon;
    var rec = { count: p.length, h: null, l1: null, wave: null };

    /* Regress over the *saturated* part only: the leading run of vehicles that
       were actually stopped in the queue. Once the queue clears, the remaining
       crossings are free-flow arrivals at the arrival headway, and including
       them inflates the measured saturation headway toward 1/demand. */
    var run = 0;
    while (run < p.length && p[run].q) run++;

    if (run >= 7) {
      var ns = [], ts = [], i;
      for (i = 4; i < run; i++) { ns.push(i + 1); ts.push(p[i].t); }
      var fit = T.linfit(ns, ts);
      if (fit && fit.slope > 0.4 && fit.slope < 6) {
        rec.h = fit.slope;
        rec.l1 = fit.intercept - greenStart;
      }
    }

    /* Wave speed as a Theil-Sen estimate — the median over all pairwise slopes.
       Robust where a least-squares fit is not: a single stray release drags a
       regression badly, and at long reaction times that was reporting
       single-digit km/h for a wave plainly moving several times faster.

       Restricted to the front 30 vehicles of the queue, nearest the stop line.
       In an oversaturated queue the whole backlog creeps forward a little each
       cycle, so almost every vehicle technically "releases"; those creep events
       are not the start-up wave and including them measures nothing. */
    var L = [];
    for (var m = 0; m < this.launches.length; m++) {
      if (this.launches[m].x >= -250) L.push(this.launches[m]);
    }
    L.sort(function (a, b) { return b.x - a.x; });
    if (L.length > 30) L.length = 30;

    if (L.length >= 5) {
      var slopes = [], j, k;
      for (j = 0; j < L.length; j++) {
        for (k = j + 1; k < L.length; k++) {
          var dt = L[k].t - L[j].t;
          if (Math.abs(dt) > 0.4) slopes.push((L[k].x - L[j].x) / dt);
        }
      }
      if (slopes.length >= 6) {
        slopes.sort(function (a, b) { return a - b; });
        var med = slopes[Math.floor(slopes.length / 2)];
        if (med < -0.3 && med > -30) rec.wave = -med;
      }
    }

    this.history.push(rec);
    if (this.history.length > 6) this.history.shift();
    this.platoon = [];
    this.launches = [];
  };

  Stream.prototype.avg = function (key) {
    var s = 0, n = 0;
    for (var i = 0; i < this.history.length; i++) {
      var v = this.history[i][key];
      if (v !== null && isFinite(v)) { s += v; n++; }
    }
    return n ? s / n : null;
  };

  /* ------------------------------------------------------------------------
     The simulation
     ---------------------------------------------------------------------- */

  function LightSim() {
    this.params = {
      tau: 1.2, s0: 2.0, accel: 1.8, headway: 1.2,
      green: 30, demand: 1400, limit: 50
    };
    this.YELLOW = 3.5;
    this.RED = 24;
    this.human = new Stream(this.params.tau, 'Human reaction');
    this.ideal = new Stream(0, 'Zero reaction');
    this.rigid = new Stream(0, 'Moves as one body', true);
    this.streams = [this.human, this.ideal, this.rigid];
    this.speed = 2;
    this.manual = false;
    this.reset();
  }

  LightSim.prototype.driver = function () {
    return this.drivers().move;
  };

  /* Three parameter sets, differing only in the minimum gap each implies.
       park  behind a stationary car — this is the slider
       move  behind a moving car, and free driving
       line  at the stop line itself, which nobody parks four metres short of */
  LightSim.prototype.drivers = function () {
    var p = this.params;
    var base = { v0: p.limit / T.KMH, T: p.headway, a: p.accel, b: 2.6 };
    var withGap = function (g) {
      return { v0: base.v0, T: base.T, a: base.a, b: base.b, s0: g };
    };
    return { park: withGap(p.s0), move: withGap(MOVE_GAP), line: withGap(LINE_GAP) };
  };

  LightSim.prototype.reset = function () {
    this.t = 0;
    this.phase = 'red';
    this.phaseEnds = 4;
    this.greenStartedAt = null;
    this.rand = T.rng(20260731);
    this.nextArrival = 0;
    this.manual = false;
    for (var s = 0; s < this.streams.length; s++) this.streams[s].reset();
    this.human.tau = this.params.tau;
    this.cyclesDone = 0;

    /* Start with a queue already standing at the line, sized to a full cycle's
       arrivals so the very first green is saturated. Seeding only a red's worth
       leaves the first green under-subscribed, and the first green is the one
       every reader watches. */
    var drv = this.driver();
    /* Roughly two cycles' worth of arrivals. One cycle's worth leaves the first
       few greens demand-limited rather than capacity-limited, and until the
       approach is saturated the three lanes all clear everything and the
       comparison reads as a flat zero. */
    var n = T.clamp(
      Math.round((this.params.demand / 3600) * (this.RED + this.params.green) * 1.9),
      8, 80);
    for (var k = 0; k < this.streams.length; k++) this.seedQueue(this.streams[k], n, drv);
  };

  LightSim.prototype.seedQueue = function (stream, n, drv) {
    var pitch = CAR_LEN + this.params.s0;
    for (var i = 0; i < n; i++) {
      var car = new T.Vehicle(-1 - i * pitch, 0, drv);
      car.enteredAt = 0;
      car.yellowCall = null;
      car.launchLogged = false;
      car.queued = true;
      car.everQueued = true;
      stream.cars.push(car);
    }
  };

  LightSim.prototype.advanceSignal = function () {
    if (this.manual || this.t < this.phaseEnds) return;
    if (this.phase === 'red') {
      this.startGreen();
    } else if (this.phase === 'green') {
      this.phase = 'yellow';
      this.phaseEnds = this.t + this.YELLOW;
    } else {
      this.startRed();
      this.phaseEnds = this.t + this.RED;
    }
  };

  LightSim.prototype.startGreen = function () {
    this.phase = 'green';
    this.phaseEnds = this.t + this.params.green;
    this.greenStartedAt = this.t;
  };

  LightSim.prototype.startRed = function () {
    if (this.greenStartedAt !== null) {
      for (var i = 0; i < this.streams.length; i++) {
        this.streams[i].closeGreen(this.greenStartedAt);
        this.rearm(this.streams[i]);
      }
      this.cyclesDone++;
    }
    this.phase = 'red';
  };

  /* Manual control of the signal. Holding a phase indefinitely is the fastest
     way to see what the wave actually does — stop the light on red, let the
     queue build, then release it and watch. */
  LightSim.prototype.forcePhase = function (p) {
    this.manual = true;
    if (p === this.phase) return;
    if (p === 'green') this.startGreen();
    else this.startRed();
    this.phaseEnds = Infinity;
  };

  LightSim.prototype.resumeAuto = function () {
    this.manual = false;
    this.phaseEnds = this.t + (this.phase === 'green' ? this.params.green : this.RED);
  };

  /* A vehicle deep in an oversaturated queue can be granted a release during a
     green it never reaches the front of. Its launch time is then in the past
     when the next green arrives, so it would start with no reaction delay at
     all — which quietly deletes the wave for everything behind it. Re-arm the
     still-stationary part of the queue at every red. */
  LightSim.prototype.rearm = function (stream) {
    for (var i = 0; i < stream.cars.length; i++) {
      var c = stream.cars[i];
      if (c.queued && c.v < T.STOPPED) {
        c.launchAt = null;
        c.launchLogged = false;
        c.xAtCue = null;
      }
    }
  };

  /* Whether an approaching driver treats the current indication as "stop".
     The yellow decision is sticky: once a driver commits to going, they go. */
  LightSim.prototype.signalStops = function (car, drv) {
    if (this.phase === 'green') { car.yellowCall = null; return false; }
    if (car.x >= 0) return false;               // already over the line
    if (this.phase === 'red') { car.yellowCall = null; return true; }
    if (car.yellowCall === null || car.yellowCall === undefined) {
      var stopDist = (car.v * car.v) / (2 * drv.b);
      car.yellowCall = (-car.x) > stopDist ? 'stop' : 'go';
    }
    return car.yellowCall === 'stop';
  };

  /* Release rule for the lockstep stream: on green, every stopped vehicle goes
     at once, together. There is no cue to wait for and no gap to wait for. */
  function lockstepRelease(car, t, greenAt) {
    if (!car.queued && car.v < T.STOPPED) {
      car.queued = true;
      car.launchAt = null;
      car.movedAt = null;
      car.xAtCue = null;
      car.lockstepping = false;
    }
    if (car.queued && car.v > 0.5) car.queued = false;

    if (car.queued) {
      if (greenAt === null) return false;
      if (car.launchAt === null) { car.launchAt = greenAt; car.xAtCue = car.x; }
      car.lockstepping = true;
    }
    if (car.movedAt === null && car.v > T.MOVING) car.movedAt = t;
    return true;
  }

  LightSim.prototype.stepStream = function (stream, dt, d) {
    var drv = d.move;
    var cars = stream.cars, i;

    for (i = 0; i < cars.length; i++) {
      var car = cars[i];
      var leader = i > 0 ? cars[i - 1] : null;

      var leaderGap = leader ? (leader.x - CAR_LEN - car.x) : Infinity;
      var leaderDv = leader ? (car.v - leader.v) : 0;
      var stops = this.signalStops(car, drv);
      var signalGap = stops ? (0 - car.x) : Infinity;

      var greenAt = (this.phase === 'green') ? this.greenStartedAt : null;
      var wasQueued = car.queued;
      var free = stream.lockstep
        ? lockstepRelease(car, this.t, greenAt)
        : T.updateRelease(car, this.t, stream.tau, leaderGap, signalGap,
                          leader, greenAt);

      /* Record the release event the first time it is granted, for the
         wave-speed regression. */
      if (car.queued) car.everQueued = true;

      if (wasQueued && free && car.launchAt !== null && !car.launchLogged) {
        car.launchLogged = true;
        if (car.xAtCue !== null && car.xAtCue < 2) {
          stream.launches.push({ x: car.xAtCue, t: car.launchAt });
        }
      }
      if (!car.queued) car.launchLogged = false;

      if (!free) { car.v = 0; car.a = 0; continue; }

      /* A vehicle moving as part of the launching body just accelerates. It
         deliberately does NOT run the car-following model against the vehicle
         ahead: they are accelerating identically, so the gap never changes, and
         IDM would read the closing-speed-zero-but-tiny-gap situation as an
         emergency. It still yields to anything that is not part of the body. */
      if (car.lockstepping) {
        var la = car.v >= drv.v0 ? 0 : drv.a;
        if (leader && !leader.lockstepping) {
          la = Math.min(la, T.idmAccel(car.v, leaderDv, leaderGap, drv));
        }
        if (signalGap < Infinity) {
          la = Math.min(la, T.idmAccel(car.v, car.v, signalGap, d.line));
        }
        car.a = la;
        continue;
      }

      /* Follow whichever constraint binds: the car ahead, or the stop line.
         Behind a *stationary* car the driver is aiming for their parking gap;
         the instant that car moves, the binding minimum drops back to the
         in-motion one — which is the whole point. A driver who parked a car
         length and a half back already has the room to pull away, and does not
         have to wait for it to be made for them. */
      var follow = (leader && leader.v < T.MOVING) ? d.park : d.move;
      var a;
      if (signalGap < leaderGap) {
        a = T.idmAccel(car.v, car.v, signalGap, d.line);
      } else if (leader) {
        a = T.idmAccel(car.v, leaderDv, leaderGap, follow);
      } else {
        a = T.idmAccel(car.v, 0, 1e5, d.move);
      }
      car.a = a;
    }

    /* Integrate, then retire vehicles past the exit. */
    for (i = cars.length - 1; i >= 0; i--) {
      var c = cars[i];
      if (c.v === 0 && c.a === 0 && c.queued) continue;
      var vNew = Math.max(0, c.v + c.a * dt);
      var prevX = c.x;
      c.x += 0.5 * (c.v + vNew) * dt;
      c.v = vNew;

      /* Hard non-overlap guard. IDM should make this unreachable; the release
         logic makes "should" worth backing up. */
      if (i > 0) {
        var lead = cars[i - 1];
        var limitX = lead.x - CAR_LEN - 0.3;
        if (c.x > limitX) { c.x = limitX; c.v = Math.min(c.v, lead.v); }
      }

      if (prevX < 0 && c.x >= 0) {
        c.crossedAt = this.t;
        stream.platoon.push({ t: this.t, q: !!c.everQueued });
        stream.crossedTotal++;
        var freeFlow = (c.x - X_SPAWN) / drv.v0;
        var delay = (this.t - c.enteredAt) - freeFlow;
        stream.delays.push(Math.max(0, delay));
        if (stream.delays.length > 160) stream.delays.shift();
      }

      if (c.x > X_EXIT) { stream.traces.delete(c.id); cars.splice(i, 1); }
    }
  };

  LightSim.prototype.recordTraces = function (stream) {
    var cutoff = this.t - TRACE_WINDOW;
    for (var i = 0; i < stream.cars.length; i++) {
      var c = stream.cars[i];
      var tr = stream.traces.get(c.id);
      if (!tr) { tr = []; stream.traces.set(c.id, tr); }
      tr.push(this.t, c.x);
    }
    stream.traces.forEach(function (tr, id) {
      var drop = 0;
      while (drop + 1 < tr.length && tr[drop] < cutoff) drop += 2;
      if (drop > 0) tr.splice(0, drop);
      if (tr.length === 0) stream.traces.delete(id);
    });
  };

  LightSim.prototype.step = function (dt) {
    this.t += dt;
    this.advanceSignal();
    var d = this.drivers();
    var drv = d.move;
    this.human.tau = this.params.tau;

    /* Shared arrival schedule: both streams get the identical vehicle at the
       identical instant, so any difference downstream is reaction time and
       nothing else. */
    var i;
    while (this.nextArrival <= this.t) {
      for (i = 0; i < this.streams.length; i++) this.spawn(this.streams[i], drv.v0, drv);
      var rate = Math.max(this.params.demand, 60) / 3600;
      this.nextArrival += Math.max(0.6, this.rand.exponential(rate));
    }

    for (i = 0; i < this.streams.length; i++) this.stepStream(this.streams[i], dt, d);
  };

  LightSim.prototype.spawn = function (stream, v0, drv) {
    var cars = stream.cars;
    var last = cars.length ? cars[cars.length - 1] : null;
    /* Don't materialise a vehicle on top of the back of the queue; if the
       queue has reached the spawn point, the arrival is simply lost (the
       approach is over capacity, which the metrics will show anyway). */
    if (last && last.x - CAR_LEN - X_SPAWN < 6) return;
    var car = new T.Vehicle(X_SPAWN, v0, drv);
    car.enteredAt = this.t;
    car.yellowCall = null;
    car.launchLogged = false;
    cars.push(car);
  };

  /* ------------------------------------------------------------------------
     Rendering
     ---------------------------------------------------------------------- */

  /* Which comparison lanes are on screen, in a fixed order with fixed colours —
     a lane keeps its colour whether or not its neighbours are showing. */
  function visibleLanes(sim, th, show) {
    var out = [{ s: sim.human, c: th.s1, tag: 'τ = ' + sim.params.tau.toFixed(1) + ' s' }];
    if (show.ideal) out.push({ s: sim.ideal, c: th.s3, tag: 'τ = 0, still waits for room' });
    if (show.rigid) out.push({ s: sim.rigid, c: th.s2, tag: 'τ = 0, no room needed' });
    return out;
  }

  function drawRoadView(canvas, sim, show) {
    var f = T.fitCanvas(canvas);
    var ctx = f.ctx, W = f.w, H = f.h;
    var th = T.theme(canvas);
    ctx.clearRect(0, 0, W, H);

    var padL = 8, padR = 8;
    var plotW = W - padL - padR;
    var span = VIEW_MAX - VIEW_MIN;
    var sx = function (x) { return padL + ((x - VIEW_MIN) / span) * plotW; };

    var laneH = 28, gap = 20, topY = 24;
    var lanes = visibleLanes(sim, th, show);
    lanes.forEach(function (L, i) { L.y = topY + i * (laneH + gap); });

    var maxV = sim.driver().v0;

    lanes.forEach(function (L) {
      var y = L.y;

      /* asphalt */
      ctx.fillStyle = th.asphalt;
      ctx.fillRect(padL, y, plotW, laneH);
      ctx.fillStyle = th.asphaltEdge;
      ctx.fillRect(padL, y, plotW, 1);
      ctx.fillRect(padL, y + laneH - 1, plotW, 1);

      /* stop line */
      var sl = sx(0);
      ctx.fillStyle = th.marking;
      ctx.fillRect(sl - 1.5, y, 3, laneH);

      /* lane label */
      ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.fillStyle = L.c;
      ctx.textBaseline = 'alphabetic';
      var name = L.s.label.toUpperCase();
      ctx.fillText(name, padL + 2, y - 6);
      ctx.fillStyle = th.muted;
      ctx.fillText(L.tag, padL + 2 + ctx.measureText(name).width + 10, y - 6);

      /* vehicles */
      var carW = Math.max(5, (CAR_LEN / span) * plotW);
      for (var i = 0; i < L.s.cars.length; i++) {
        var c = L.s.cars[i];
        if (c.x < VIEW_MIN - 10 || c.x > VIEW_MAX + 10) continue;
        var ratio = T.clamp(c.v / maxV, 0, 1);
        ctx.fillStyle = T.congestionColor(ratio, th.dark);
        T.roundRect(ctx, sx(c.x) - carW, y + 6, carW, laneH - 12, 2);
        ctx.fill();
      }

      /* signal head */
      var sigY = y + laneH / 2;
      var col = sim.phase === 'green' ? th.go : (sim.phase === 'yellow' ? th.caution : th.stop);
      ctx.beginPath();
      ctx.arc(sl, y - 13, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
    });

    /* distance ruler */
    var ry = topY + lanes.length * laneH + (lanes.length - 1) * gap + 16;
    ctx.strokeStyle = th.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, ry + 0.5); ctx.lineTo(W - padR, ry + 0.5);
    ctx.stroke();
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillStyle = th.muted;
    ctx.textAlign = 'center';
    for (var d = -300; d <= 0; d += 100) {
      var px = sx(d);
      ctx.beginPath();
      ctx.moveTo(px + 0.5, ry); ctx.lineTo(px + 0.5, ry + 4);
      ctx.stroke();
      var lab = d === 0 ? 'stop line' : (d + ' m');
      /* keep the end labels inside the canvas — the leftmost one sits on the
         padding edge and was losing its first character */
      var half = ctx.measureText(lab).width / 2;
      ctx.fillText(lab, T.clamp(px, padL + half, W - padR - half), ry + 15);
    }
    ctx.textAlign = 'left';
  }

  /* The space-time diagram: the canonical way traffic engineers look at this.
     Distance runs up the y-axis, time runs right. A stopped car is a flat
     line; the backward start-up wave is the diagonal front where those flat
     lines end. */
  function drawSpaceTime(canvas, sim, show) {
    var f = T.fitCanvas(canvas);
    var ctx = f.ctx, W = f.w, H = f.h;
    var th = T.theme(canvas);
    ctx.clearRect(0, 0, W, H);

    var padL = 44, padR = 12, padT = 12, padB = 26;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var t1 = Math.max(TRACE_WINDOW, sim.t), t0 = t1 - TRACE_WINDOW;
    var xLo = VIEW_MIN, xHi = VIEW_MAX;

    var px = function (t) { return padL + ((t - t0) / (t1 - t0)) * plotW; };
    var py = function (x) { return padT + plotH - ((x - xLo) / (xHi - xLo)) * plotH; };

    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT, plotW, plotH);
    ctx.clip();

    /* grid */
    ctx.strokeStyle = th.grid;
    ctx.lineWidth = 1;
    for (var gx = -300; gx <= 0; gx += 100) {
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(py(gx)) + 0.5);
      ctx.lineTo(padL + plotW, Math.round(py(gx)) + 0.5);
      ctx.stroke();
    }

    /* trajectories — comparison lanes first so the human one reads on top */
    var series = visibleLanes(sim, th, show).slice().reverse();

    series.forEach(function (S) {
      ctx.strokeStyle = S.c;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1;
      S.s.traces.forEach(function (tr) {
        if (tr.length < 4) return;
        ctx.beginPath();
        ctx.moveTo(px(tr[0]), py(tr[1]));
        for (var i = 2; i < tr.length; i += 2) ctx.lineTo(px(tr[i]), py(tr[i + 1]));
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
    });

    ctx.restore();

    /* stop line + signal state ribbon */
    var slY = Math.round(py(0)) + 0.5;
    ctx.strokeStyle = th.inkSoft;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, slY); ctx.lineTo(padL + plotW, slY);
    ctx.stroke();

    /* axes */
    ctx.strokeStyle = th.grid;
    ctx.beginPath();
    ctx.moveTo(padL + 0.5, padT); ctx.lineTo(padL + 0.5, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();

    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillStyle = th.muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var ly = -300; ly <= 0; ly += 100) {
      ctx.fillText(ly === 0 ? '0' : String(ly), padL - 6, py(ly));
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    var tickStep = 20;
    var firstTick = Math.ceil(t0 / tickStep) * tickStep;
    for (var tt = firstTick; tt <= t1; tt += tickStep) {
      ctx.fillText(tt.toFixed(0) + 's', px(tt), padT + plotH + 15);
    }
    ctx.save();
    ctx.translate(11, padT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('distance to stop line (m)', 0, 0);
    ctx.restore();
    ctx.textAlign = 'left';
  }

  /* ------------------------------------------------------------------------
     Widget wiring
     ---------------------------------------------------------------------- */

  var PRESETS = {
    typical:   { tau: 1.2, s0: 2.0, accel: 1.8, headway: 1.2 },
    attentive: { tau: 0.6, s0: 1.4, accel: 2.6, headway: 1.0 },
    distracted:{ tau: 2.0, s0: 3.6, accel: 1.1, headway: 1.7 },
    platoon:   { tau: 0.1, s0: 1.0, accel: 2.8, headway: 0.6 }
  };

  function fmt(v, unit, digits) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return v.toFixed(digits === undefined ? 1 : digits) + (unit || '');
  }

  T.LightSim = LightSim;   /* exported for the headless checks in test/ */

  T.initLightSim = function () {
    var root = document.getElementById('light-sim');
    if (!root) return;

    var sim = new LightSim();
    var roadCanvas = document.getElementById('light-road');
    var stCanvas = document.getElementById('light-spacetime');
    var show = { ideal: true, rigid: true };
    /* Nothing runs until the reader asks. A simulator left running while
       someone reads three thousand words above it is, by the time they
       arrive, showing a queue that grew to the edge of the model — the
       interesting transient happened minutes ago and off screen. */
    var running = false;
    var started = false;
    var startOverlay = document.getElementById('ls-start');

    var ranges = {
      tau: 'ls-tau', s0: 'ls-gap', accel: 'ls-accel',
      headway: 'ls-headway', green: 'ls-green', demand: 'ls-demand'
    };
    var units = {
      tau: [' s', 1], s0: [' m', 1], accel: [' m/s²', 1],
      headway: [' s', 1], green: [' s', 0], demand: [' veh/h', 0]
    };

    function syncOutputs() {
      Object.keys(ranges).forEach(function (k) {
        var el = document.getElementById(ranges[k]);
        var out = document.getElementById(ranges[k] + '-val');
        if (el && out) out.textContent = fmt(parseFloat(el.value), units[k][0], units[k][1]);
      });
    }

    function readControls() {
      Object.keys(ranges).forEach(function (k) {
        var el = document.getElementById(ranges[k]);
        if (el) sim.params[k] = parseFloat(el.value);
      });
      syncOutputs();
    }

    Object.keys(ranges).forEach(function (k) {
      var el = document.getElementById(ranges[k]);
      if (el) el.addEventListener('input', readControls);
    });

    ['ideal', 'rigid'].forEach(function (k) {
      var el = document.getElementById('ls-show-' + k);
      if (el) el.addEventListener('change', function () { show[k] = el.checked; });
    });

    /* speed */
    root.querySelectorAll('[data-speed]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        sim.speed = parseFloat(btn.getAttribute('data-speed'));
        root.querySelectorAll('[data-speed]').forEach(function (b) {
          b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
        });
      });
    });

    /* manual signal control */
    var signalBtn = document.getElementById('ls-signal');
    var autoBtn = document.getElementById('ls-auto');
    function refreshSignalBtns() {
      if (signalBtn) {
        signalBtn.textContent = sim.phase === 'green' ? 'Turn red' : 'Turn green';
      }
      if (autoBtn) {
        autoBtn.hidden = !sim.manual;
      }
    }
    if (signalBtn) {
      signalBtn.addEventListener('click', function () {
        sim.forcePhase(sim.phase === 'green' ? 'red' : 'green');
        refreshSignalBtns();
      });
    }
    if (autoBtn) {
      autoBtn.addEventListener('click', function () { sim.resumeAuto(); refreshSignalBtns(); });
    }

    root.querySelectorAll('[data-preset]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var p = PRESETS[btn.getAttribute('data-preset')];
        if (!p) return;
        Object.keys(p).forEach(function (k) {
          var el = document.getElementById(ranges[k]);
          if (el) el.value = p[k];
        });
        readControls();
        root.querySelectorAll('[data-preset]').forEach(function (b) {
          b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
        });
        sim.reset();
      });
    });

    var playBtn = document.getElementById('ls-play');
    var resetBtn = document.getElementById('ls-reset');
    function setPlay() {
      if (playBtn) {
        playBtn.textContent = running ? 'Pause' : (started ? 'Resume' : 'Start');
        playBtn.setAttribute('aria-pressed', running ? 'true' : 'false');
      }
      if (startOverlay) startOverlay.hidden = started;
    }

    function setRunning(v) {
      running = v;
      if (v) started = true;
      setPlay();
    }
    if (playBtn) playBtn.addEventListener('click', function () { setRunning(!running); });
    if (startOverlay) startOverlay.addEventListener('click', function () { setRunning(true); });
    if (resetBtn) resetBtn.addEventListener('click', function () { sim.reset(); });

    /* stat tiles */
    var out = {};
    ['cleared', 'gain', 'rigid', 'wave', 'lost', 'headway', 'queue', 'delay'].forEach(function (k) {
      out[k] = document.getElementById('ls-out-' + k);
    });
    var tableBody = document.getElementById('ls-table-body');

    function refreshStats() {
      var h = sim.human, id = sim.ideal, rg = sim.rigid;
      var hc = h.avg('count'), ic = id.avg('count'), rc = rg.avg('count');
      var hLive = h.platoon.length;

      if (out.cleared) out.cleared.textContent = hc === null ? String(hLive) : hc.toFixed(1);
      var relative = function (other) {
        if (!hc || !other || hc <= 0) return '—';
        var pct = ((other - hc) / hc) * 100;
        return (pct >= 0 ? '+' : '') + pct.toFixed(0) + '%';
      };
      if (out.gain) out.gain.textContent = relative(ic);
      if (out.rigid) out.rigid.textContent = relative(rc);
      var w = h.avg('wave');
      if (out.wave) out.wave.textContent = w === null ? '—' : (w * T.KMH).toFixed(1);
      var l1 = h.avg('l1');
      if (out.lost) out.lost.textContent = l1 === null ? '—' : l1.toFixed(1);
      var hh = h.avg('h');
      if (out.headway) out.headway.textContent = hh === null ? '—' : hh.toFixed(2);
      if (out.queue) out.queue.textContent = h.queueLength().toFixed(0);
      if (out.delay) {
        var d = h.delays.length
          ? h.delays.reduce(function (a, b) { return a + b; }, 0) / h.delays.length : null;
        out.delay.textContent = d === null ? '—' : d.toFixed(0);
      }

      /* table view — every number above is reachable without reading a colour */
      if (tableBody) {
        var kmh = function (s) {
          var v = s.avg('wave');
          return v === null ? '—' : (v * T.KMH).toFixed(1);
        };
        var rows = [
          ['Vehicles per green', fmt(hc, '', 1), fmt(ic, '', 1), fmt(rc, '', 1)],
          ['Saturation headway (s)', fmt(h.avg('h'), '', 2), fmt(id.avg('h'), '', 2), fmt(rg.avg('h'), '', 2)],
          ['Start-up lost time (s)', fmt(h.avg('l1'), '', 1), fmt(id.avg('l1'), '', 1), fmt(rg.avg('l1'), '', 1)],
          ['Start-up wave (km/h)', kmh(h), kmh(id), 'none'],
          ['Queue at stop line (m)', h.queueLength().toFixed(0), id.queueLength().toFixed(0), rg.queueLength().toFixed(0)]
        ];
        tableBody.innerHTML = rows.map(function (r) {
          return '<tr><th scope="row">' + r[0] + '</th><td>' + r[1] + '</td><td>' +
                 r[2] + '</td><td>' + r[3] + '</td></tr>';
        }).join('');
      }
    }

    /* phase readout */
    var phaseEl = document.getElementById('ls-phase');
    function refreshPhase() {
      if (!phaseEl) return;
      var left = sim.phaseEnds - sim.t;
      phaseEl.textContent = sim.phase.toUpperCase() + ' · ' +
        (sim.manual || !isFinite(left) ? 'held' : Math.max(0, left).toFixed(0) + 's');
      phaseEl.className = 'phase-pill phase-' + sim.phase;
    }

    readControls();
    var last = 0, acc = 0, statAcc = 0, traceAcc = 0;

    function frame(now) {
      requestAnimationFrame(frame);
      if (!last) last = now;
      var real = Math.min((now - last) / 1000, 0.1);
      last = now;

      if (running) {
        /* Faster than real time by default: a signal cycle is around a minute,
           and nobody should sit through four of them to see a number. */
        acc += real * sim.speed;
        var dt = 1 / 60;
        var guard = 0, maxSteps = 12 + Math.ceil(sim.speed * 8);
        while (acc >= dt && guard++ < maxSteps) {
          sim.step(dt);
          acc -= dt;
          traceAcc += dt;
          if (traceAcc >= 0.3) {
            for (var s = 0; s < sim.streams.length; s++) sim.recordTraces(sim.streams[s]);
            traceAcc = 0;
          }
        }
        if (acc > 1) acc = 0;   /* don't accumulate an unpayable backlog */
        statAcc += real;
        if (statAcc > 0.25) { refreshStats(); statAcc = 0; }
      }
      refreshPhase();
      refreshSignalBtns();
      drawRoadView(roadCanvas, sim, show);
      drawSpaceTime(stCanvas, sim, show);
    }
    requestAnimationFrame(frame);
    setPlay();
    refreshStats();
  };

})(window);
