/* ============================================================================
   merge-sim.js — a lane closure, and three ways of dealing with it
   ----------------------------------------------------------------------------
   Two lanes become one at a taper. Drivers differ only in *where* they intend
   to change lanes, and in whether the through-lane drivers open a gap. Demand,
   arrivals and every driver parameter are held identical across strategies by
   the seeded RNG, so the comparison isolates merge behaviour.
   ========================================================================== */
(function (global) {
  'use strict';

  var T = global.Traffic;
  var CAR_LEN = T.CAR_LEN;

  var ROAD_LEN = 3200;
  var X_TAPER = 2500;    // taper begins, work-zone speed limit starts
  var X_CLOSED = 2650;   // right lane is physically gone
  var X_MEASURE = 2760;  // throughput counter
  var V_FREE = 100 / T.KMH;
  var V_WZ = 60 / T.KMH;
  var BIN = 25;

  var VIEW_LO = X_CLOSED - 640;
  var VIEW_HI = X_CLOSED + 130;

  /* Where drivers intend to merge, per strategy. `at` is a road position, so
     larger = closer to the closure. `onSlow` marks the drivers who will also
     merge the moment they catch slow traffic, wherever that happens to be —
     which is what "merge early" actually means once a queue exists. Their
     merge point migrates upstream with the back of the queue, and that is
     precisely what turns the whole backup into a single lane. */
  var STRATEGY = {
    early: function (r) {
      /* Almost everyone moves over at the first sign; a few stragglers don't. */
      return r() < 0.9 ? { at: r.normal(1760, 230), onSlow: true }
                       : { at: r.normal(2570, 60), onSlow: false };
    },
    zipper: function (r) {
      /* Both lanes run full to the taper, then alternate. */
      return { at: r.normal(2598, 26), onSlow: false };
    },
    mixed: function (r) {
      /* The situation almost every real work zone is actually in: no shared
         convention, so the two populations collide. */
      return r() < 0.55 ? { at: r.normal(1820, 320), onSlow: true }
                        : { at: r.normal(2596, 42), onSlow: false };
    },
    /* Everyone uses both lanes and aims for the same merge point, set by the
       slider as a distance back from the closure. This is the knob that asks
       whether there is a best place to zip — far enough back that a gap can be
       negotiated while still moving, but not so far that the closing lane
       empties out and the queue collapses into one lane. */
    custom: function (r, params) {
      var back = params.mergeBack;
      return { at: X_CLOSED - back, onSlow: false, spread: Math.max(10, back * 0.22) };
    }
  };

  function drawPlan(r, params) {
    var plan = STRATEGY[params.mode](r, params);
    var sd = plan.spread;
    if (sd) plan.at = r.normal(plan.at, sd);
    return plan;
  }

  T.MERGE_LABELS = {
    early: 'Everyone merges early',
    zipper: 'Zipper — both lanes to the taper',
    mixed: 'Mixed — no shared convention',
    custom: 'Both lanes, merging at a set distance'
  };
  T.X_CLOSED = X_CLOSED;

  /* ------------------------------------------------------------------------ */

  function MergeSim(params) {
    this.params = params;
    this.reset();
  }

  MergeSim.prototype.reset = function () {
    this.t = 0;
    this.lanes = [[], []];      // 0 = through lane, 1 = closing lane
    this.rand = T.rng(31072026);
    this.nextArrival = 0;
    this.crossings = [];        // times vehicles passed X_MEASURE
    this.delays = [];
    this.blocked = 0;           // arrivals lost because the road was full
    this.entered = 0;
    this.mergeLog = [];         // where lane changes actually happened
    this.prefill();
  };

  /* Lay free-flowing traffic along the whole approach before the clock starts.
     A vehicle needs about a minute and a half to drive from the entry point to
     the counter, so without this the throughput readout sits at zero while the
     reader waits for the first car to arrive. */
  MergeSim.prototype.prefill = function () {
    var r = this.rand;
    var drv = this.driver();
    var perLane = Math.max(this.params.demand, 100) / 2 / 3600;   // veh/s
    var pitch = Math.max(V_FREE / perLane, CAR_LEN + 8);

    for (var lane = 0; lane < 2; lane++) {
      for (var x = X_MEASURE; x > 0; x -= pitch) {
        var car = new T.Vehicle(x, V_FREE, drv);
        car.lane = lane;
        car.enteredAt = -(x / V_FREE);
        car.waiting = 0;
        car.yieldUntil = null;
        car.yieldCooldown = 0;
        car.yields = r() < this.params.cooperation;
        if (lane === 0) {
          car.merged = true; car.mergeAt = 0; car.mergeOnSlow = false;
        } else {
          var plan = drawPlan(r, this.params);
          car.mergeAt = T.clamp(plan.at, 700, X_CLOSED - 8);
          car.mergeOnSlow = plan.onSlow;
          car.merged = false;
          /* anyone already past the closure must have merged on the way */
          if (x > X_CLOSED - 20) { car.merged = true; car.lane = 0; }
        }
        this.lanes[car.lane].push(car);
      }
    }
    this.lanes[0].sort(function (a, b) { return b.x - a.x; });
    this.lanes[1].sort(function (a, b) { return b.x - a.x; });
  };

  MergeSim.prototype.driver = function () {
    return {
      v0: V_FREE,
      T: this.params.headway !== undefined ? this.params.headway : 1.25,
      a: 1.7,
      b: 2.5,
      s0: 2.2
    };
  };

  /* Desired speed falls through the work zone. */
  function desiredSpeed(x) {
    if (x < X_TAPER - 250) return V_FREE;
    if (x > X_TAPER) return V_WZ;
    var f = (x - (X_TAPER - 250)) / 250;
    return V_FREE + f * (V_WZ - V_FREE);
  }

  MergeSim.prototype.spawn = function () {
    var r = this.rand;
    var lane = r() < 0.5 ? 0 : 1;
    var arr = this.lanes[lane];
    var last = arr.length ? arr[arr.length - 1] : null;
    if (last && last.x < 9) { this.blocked++; return; }

    var drv = this.driver();
    var car = new T.Vehicle(0, V_FREE, drv);
    car.lane = lane;
    car.enteredAt = this.t;
    car.merged = (lane === 0);
    if (lane === 1) {
      var plan = drawPlan(r, this.params);
      car.mergeAt = T.clamp(plan.at, 700, X_CLOSED - 8);
      car.mergeOnSlow = plan.onSlow;
    } else {
      car.mergeAt = 0;
      car.mergeOnSlow = false;
    }
    /* Whether this driver, in the through lane, will open a gap for someone. */
    car.yields = r() < this.params.cooperation;
    car.waiting = 0;
    car.yieldUntil = null;
    car.yieldCooldown = 0;
    arr.push(car);
    this.entered++;
  };

  /* arr is sorted descending by x; find the vehicles straddling position x. */
  function neighbors(arr, x) {
    var leader = null, follower = null;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].x > x) leader = arr[i];
      else { follower = arr[i]; break; }
    }
    return { leader: leader, follower: follower };
  }

  function insertSorted(arr, car) {
    var i = 0;
    while (i < arr.length && arr[i].x > car.x) i++;
    arr.splice(i, 0, car);
  }

  /* ------------------------------------------------------------------------
     Lane changing.

     A merge needs a gap in front and a gap behind. The gap a driver will
     accept shrinks as they run out of road, and the gap the through-lane
     driver insists on shrinks if they are willing to cooperate. Those two
     effects are what separates an orderly zipper from a forced cut-in.
     ---------------------------------------------------------------------- */
  MergeSim.prototype.tryMerge = function (car) {
    if (car.merged || car.lane !== 1) return false;
    /* Eligible either because they have reached their intended merge point, or
       because they are the sort of driver who gets over as soon as they catch
       the back of the queue. */
    var caughtQueue = car.mergeOnSlow && car.v < 0.6 * V_FREE && car.x > 350;
    if (car.x < car.mergeAt - 5 && !caughtQueue) return false;

    var target = this.lanes[0];
    var nb = neighbors(target, car.x);
    var gapFront = nb.leader ? (nb.leader.x - CAR_LEN - car.x) : 1e5;
    var gapRear = nb.follower ? (car.x - CAR_LEN - nb.follower.x) : 1e5;

    /* How badly this driver needs to be in the other lane, 0..1 */
    var overrun = T.clamp((car.x - car.mergeAt) / 140, 0, 1);
    var stuck = T.clamp(car.waiting / 10, 0, 1);
    var push = Math.max(overrun, stuck);

    var coop = nb.follower && nb.follower.yields ? 1 : 0;
    var needFront = Math.max(2.6, 2.5 + car.v * (0.55 - 0.30 * push));
    /* A driver who has run out of road stops negotiating and forces in. The
       follower then has to brake hard, which is where the backward wave that
       makes late merging feel so destructive actually comes from. */
    var needRear = Math.max(2.0, 2.2 + (nb.follower ? nb.follower.v : 0) *
                            Math.max(0, 0.85 - 0.45 * coop - 0.45 * push));

    /* Judge the gap by its total size, not by where the merger happens to be
       sitting inside it. A driver waiting to merge edges forward or hangs back
       to line themselves up; testing the front and rear gaps independently
       models someone frozen in place, who then refuses a gap that is plainly
       big enough. The floors keep them from slotting into a space they are not
       actually beside. */
    var space = gapFront + gapRear;
    if (gapFront >= 1.0 && gapRear >= 0.5 && space >= needFront + needRear) {
      var from = this.lanes[1];
      var idx = from.indexOf(car);
      if (idx >= 0) from.splice(idx, 1);
      car.lane = 0;
      car.merged = true;
      car.waiting = 0;
      insertSorted(target, car);
      /* Record where the change happened. With "merge early" the intended
         merge point is fixed, but the *actual* one migrates upstream as the
         queue grows — drivers get over when they meet the back of it, not
         where the sign is. That migration is the whole reason early merging
         turns the entire backup into a single lane, so it is worth showing. */
      this.mergeLog.push(car.x);
      if (this.mergeLog.length > 500) this.mergeLog.shift();
      return true;
    }
    return false;
  };

  /* Cooperation, done as one instruction per merger rather than one per
     through-lane driver.

     For each vehicle that wants in, find the single through-lane vehicle
     immediately behind it — that is the one whose lifting off creates the gap
     — and, if that driver is a cooperative one, tell them to ease off.

     The earlier version had these drivers *follow* the merger as though it
     were their leader. That deadlocks: a merger stopped at the cones stops the
     yielder, which stops the entire through lane behind it, so turning
     cooperation up drove throughput to zero. A bounded lift-off opens the same
     gap and cannot cascade. */
  MergeSim.prototype.yieldSet = function () {
    var set = new Set();
    var closing = this.lanes[1];
    var prevSeeking = null;

    for (var i = 0; i < closing.length; i++) {
      var m = closing[i];
      if (m.merged) continue;

      /* Only vehicles at the head of the closing lane are actively negotiating.
         A zipper is sequential — the car at the taper goes, then the next one
         moves up and asks. Letting every queued vehicle request a gap at once
         makes most of the through lane open twelve metres simultaneously and
         collapses its capacity, which is a modelling artefact, not traffic. */
      var independent = (prevSeeking === null) || (prevSeeking.x - m.x > 15);
      prevSeeking = m;
      if (!independent) continue;
      if (m.x < m.mergeAt - 40) continue;

      var nb = neighbors(this.lanes[0], m.x);
      if (nb.follower && nb.follower.yields && m.x - nb.follower.x < 45) {
        set.add(nb.follower);
      }
    }
    return set;
  };

  MergeSim.prototype.step = function (dt) {
    this.t += dt;
    var drv = this.driver();

    while (this.nextArrival <= this.t) {
      this.spawn();
      var rate = Math.max(this.params.demand, 100) / 3600;
      this.nextArrival += this.rand.exponential(rate);
    }

    var yielders = this.yieldSet();
    var li, arr, i, car;

    /* --- accelerations --- */
    for (li = 0; li < 2; li++) {
      arr = this.lanes[li];
      for (i = 0; i < arr.length; i++) {
        car = arr[i];
        var p = {
          v0: desiredSpeed(car.x), T: drv.T, a: drv.a, b: drv.b, s0: drv.s0
        };
        var leader = i > 0 ? arr[i - 1] : null;
        var a = leader
          ? T.idmAccel(car.v, car.v - leader.v, leader.x - CAR_LEN - car.x, p)
          : T.idmAccel(car.v, 0, 1e5, p);

        /* the closed lane ends */
        if (li === 1 && !car.merged) {
          var gapToEnd = X_CLOSED - car.x;
          a = Math.min(a, T.idmAccel(car.v, car.v, gapToEnd, p));

          /* Approaching the merge point, pace the vehicle ahead in the target
             lane as well. This is what a zipper physically is: you match the
             through lane's speed and slot in behind the car already ahead of
             you, rather than driving up to the cones, stopping dead, and then
             trying to launch into a moving stream from rest. */
          if (car.x > X_CLOSED - 180) {
            var ahead = neighbors(this.lanes[0], car.x).leader;
            if (ahead) {
              a = Math.min(a, T.idmAccel(car.v, car.v - ahead.v,
                                         ahead.x - CAR_LEN - car.x, p));
            }
          }
          if (car.v < 2.5 && car.x > X_TAPER - 120) car.waiting += dt;
        }

        /* Cooperative gap creation: for a bounded couple of seconds, the
           yielding driver follows *their own leader* at an inflated headway.
           That opens a gap ahead of them at any speed, including the crawl of
           a queued lane — and because the reference is always their own
           leader, never the stopped merger, it cannot deadlock the lane. */
        if (li === 0 && leader && yielders.has(car)) {
          /* Hold an extra vehicle's worth of space in front while someone is
             alongside wanting in. The gap has to fit a whole car plus the room
             it needs front and rear, or the merger still cannot legally take
             it — that is the difference between cooperating and merely
             dawdling. No timer: at the crawl of a queued lane this costs the
             yielder almost nothing, and the reference is always their own
             leader, so a merger who never finds a gap can never hold the lane. */
          var open = { v0: p.v0, T: p.T, a: p.a, b: p.b,
                       s0: p.s0 + CAR_LEN + 3 };
          a = Math.min(a, T.idmAccel(car.v, car.v - leader.v,
                                     leader.x - CAR_LEN - car.x, open));
        }
        car.a = T.clamp(a, -9, p.a);
      }
    }

    /* --- integrate --- */
    for (li = 0; li < 2; li++) {
      arr = this.lanes[li];
      for (i = arr.length - 1; i >= 0; i--) {
        car = arr[i];
        var vNew = Math.max(0, car.v + car.a * dt);
        var prevX = car.x;
        car.x += 0.5 * (car.v + vNew) * dt;
        car.v = vNew;

        if (i > 0) {
          var lead = arr[i - 1];
          var lim = lead.x - CAR_LEN - 0.3;
          if (car.x > lim) { car.x = lim; car.v = Math.min(car.v, lead.v); }
        }
        if (li === 1 && !car.merged && car.x > X_CLOSED - 0.5) {
          car.x = X_CLOSED - 0.5;
          car.v = 0;
        }

        if (prevX < X_MEASURE && car.x >= X_MEASURE) {
          this.crossings.push(this.t);
          var ff = X_MEASURE / V_FREE;
          this.delays.push(Math.max(0, (this.t - car.enteredAt) - ff));
          if (this.delays.length > 600) this.delays.shift();
        }
        if (car.x > ROAD_LEN) arr.splice(i, 1);
      }
    }

    /* --- lane changes --- */
    var closing = this.lanes[1].slice();
    for (i = 0; i < closing.length; i++) this.tryMerge(closing[i]);
  };

  /* Mean speed per 25 m bin, per lane. Drives both the corridor strip and the
     queue-extent measurement. */
  MergeSim.prototype.speedBins = function () {
    var n = Math.ceil(ROAD_LEN / BIN);
    var sum = [new Float32Array(n), new Float32Array(n)];
    var cnt = [new Float32Array(n), new Float32Array(n)];
    for (var li = 0; li < 2; li++) {
      var arr = this.lanes[li];
      for (var i = 0; i < arr.length; i++) {
        var b = Math.min(n - 1, Math.max(0, Math.floor(arr[i].x / BIN)));
        sum[li][b] += arr[i].v; cnt[li][b] += 1;
      }
    }
    return { n: n, sum: sum, cnt: cnt };
  };

  /* Queue extent: walk upstream from the closure and keep going while either
     lane is congested, tolerating short clear stretches. */
  /* How far back the jam reaches.

     Walking upstream from the closure and stopping at the first clear stretch
     is wrong: when drivers merge a few hundred metres early, the taper itself
     can be flowing freely while a long queue sits behind the merge point, and
     that reads as a queue of zero. Instead find the furthest-upstream point
     such that most of the road between there and the closure is congested. */
  MergeSim.prototype.queueExtent = function () {
    var s = this.speedBins();
    var thresh = 0.45 * V_FREE;
    var start = Math.floor(X_CLOSED / BIN);
    var slow = [], b, li;

    for (b = 0; b <= start; b++) {
      var isSlow = false;
      for (li = 0; li < 2; li++) {
        if (s.cnt[li][b] > 0 && s.sum[li][b] / s.cnt[li][b] < thresh) isSlow = true;
      }
      slow[b] = isSlow;
    }

    var congested = 0, back = start;
    for (b = start; b >= 0; b--) {
      if (slow[b]) congested++;
      var span = start - b + 1;
      if (congested >= 3 && congested / span >= 0.5) back = b;
    }
    return { metres: (start - back) * BIN, reachedStart: back <= 1 };
  };

  /* Vehicles that have reached the merge point and genuinely cannot get in.
     Deliberately not "everything stopped in the closing lane" — in a working
     zipper the whole closing lane is stopped and waiting its turn, which is
     the strategy operating correctly, not a failure. */
  MergeSim.prototype.strandedCount = function () {
    var n = 0, arr = this.lanes[1];
    for (var i = 0; i < arr.length; i++) {
      var c = arr[i];
      if (!c.merged && c.x > X_CLOSED - 45 && c.waiting > 8) n++;
    }
    return n;
  };

  MergeSim.prototype.throughput = function (window) {
    var cut = this.t - window;
    var n = 0;
    for (var i = this.crossings.length - 1; i >= 0; i--) {
      if (this.crossings[i] >= cut) n++; else break;
    }
    var span = Math.min(window, this.t);
    return span > 5 ? (n / span) * 3600 : 0;
  };

  MergeSim.prototype.meanDelay = function () {
    if (!this.delays.length) return 0;
    var s = 0;
    for (var i = 0; i < this.delays.length; i++) s += this.delays[i];
    return s / this.delays.length;
  };

  /* ------------------------------------------------------------------------
     Headless batch: run one strategy to completion and report its numbers.
     Stepped in slices so the page stays responsive.
     ---------------------------------------------------------------------- */
  T.runMergeBatch = function (baseParams, mode, onDone, onProgress) {
    var params = Object.assign({}, baseParams, { mode: mode });
    var sim = new MergeSim(params);
    var dt = 0.05;
    var warmup = 200, total = 560;
    var steps = Math.round(total / dt);
    var done = 0;
    var cleared = false;
    var peakQueue = 0, censored = false;

    function slice() {
      var budget = 1400;
      while (budget-- > 0 && done < steps) {
        sim.step(dt);
        done++;
        if (!cleared && sim.t >= warmup) {
          sim.crossings.length = 0; sim.delays.length = 0; cleared = true;
        }
        if (cleared && done % 40 === 0) {
          var q = sim.queueExtent();
          if (q.metres > peakQueue) peakQueue = q.metres;
          if (q.reachedStart) censored = true;
        }
      }
      if (onProgress) onProgress(done / steps);
      if (done < steps) {
        requestAnimationFrame(slice);
      } else {
        onDone({
          mode: mode,
          throughput: sim.throughput(total - warmup),
          delay: sim.meanDelay(),
          queue: peakQueue,
          censored: censored
        });
      }
    }
    requestAnimationFrame(slice);
  };

  /* ------------------------------------------------------------------------
     Rendering
     ---------------------------------------------------------------------- */

  function drawWorkZone(canvas, sim) {
    var f = T.fitCanvas(canvas);
    var ctx = f.ctx, W = f.w, H = f.h;
    var th = T.theme(canvas);
    ctx.clearRect(0, 0, W, H);

    var padL = 8, padR = 8;
    var plotW = W - padL - padR;
    var span = VIEW_HI - VIEW_LO;
    var sx = function (x) { return padL + ((x - VIEW_LO) / span) * plotW; };

    var laneH = 26, top = 34;
    var y0 = top, y1 = top + laneH;

    /* asphalt: both lanes up to the taper, one lane after */
    ctx.fillStyle = th.asphalt;
    ctx.fillRect(padL, y0, plotW, laneH * 2);

    /* the closed lane is hatched out from the taper on */
    var tx = sx(X_TAPER), cx = sx(X_CLOSED);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(tx, y1);
    ctx.lineTo(cx, y1 + laneH);
    ctx.lineTo(sx(VIEW_HI), y1 + laneH);
    ctx.lineTo(sx(VIEW_HI), y1);
    ctx.closePath();
    ctx.fillStyle = th.surface;
    ctx.fill();
    ctx.restore();

    /* lane divider */
    ctx.strokeStyle = th.marking;
    ctx.setLineDash([9, 11]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(padL, y1 + 0.5);
    ctx.lineTo(tx, y1 + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    /* outer edges */
    ctx.strokeStyle = th.asphaltEdge;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y0 + 0.5); ctx.lineTo(W - padR, y0 + 0.5);
    ctx.stroke();

    /* taper barrels */
    ctx.fillStyle = th.cone;
    var nB = 9;
    for (var i = 0; i <= nB; i++) {
      var f2 = i / nB;
      var bx = tx + f2 * (cx - tx);
      var by = y1 + f2 * laneH;
      ctx.beginPath();
      ctx.arc(bx, by, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillRect(cx, y1 + laneH - 3, sx(VIEW_HI) - cx, 3);

    /* vehicles */
    var carW = Math.max(4, (CAR_LEN / span) * plotW);
    for (var li = 0; li < 2; li++) {
      var arr = sim.lanes[li];
      var yy = (li === 0 ? y0 : y1) + 5;
      for (var k = 0; k < arr.length; k++) {
        var c = arr[k];
        if (c.x < VIEW_LO - 10 || c.x > VIEW_HI + 10) continue;
        var ratio = T.clamp(c.v / V_FREE, 0, 1);
        ctx.fillStyle = T.congestionColor(ratio, th.dark);
        T.roundRect(ctx, sx(c.x) - carW, yy, carW, laneH - 10, 2);
        ctx.fill();
      }
    }

    /* signage */
    ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = th.cone;
    if (X_TAPER - 380 > VIEW_LO) {
      ctx.fillText('RIGHT LANE CLOSED', sx(X_TAPER - 380), y0 - 16);
      ctx.fillText('AHEAD', sx(X_TAPER - 380), y0 - 6);
    }
    ctx.fillStyle = th.muted;
    ctx.fillText('MERGE POINT', sx((X_TAPER + X_CLOSED) / 2), y1 + laneH + 18);
    ctx.textAlign = 'left';
  }

  /* The whole corridor at a glance. This is where the queue-length difference
     between strategies becomes obvious. */
  function drawCorridor(canvas, sim) {
    var f = T.fitCanvas(canvas);
    var ctx = f.ctx, W = f.w, H = f.h;
    var th = T.theme(canvas);
    ctx.clearRect(0, 0, W, H);

    var padL = 8, padR = 8, top = 36;
    var plotW = W - padL - padR;
    var laneH = 13;
    var sx = function (x) { return padL + (x / ROAD_LEN) * plotW; };

    var bins = sim.speedBins();
    var bw = plotW * (BIN / ROAD_LEN) + 0.6;

    for (var li = 0; li < 2; li++) {
      var y = top + li * (laneH + 3);
      ctx.fillStyle = th.asphalt;
      var laneEndX = li === 1 ? sx(X_CLOSED) : W - padR;
      ctx.fillRect(padL, y, laneEndX - padL, laneH);

      for (var b = 0; b < bins.n; b++) {
        if (bins.cnt[li][b] === 0) continue;
        var mean = bins.sum[li][b] / bins.cnt[li][b];
        ctx.fillStyle = T.congestionColor(T.clamp(mean / V_FREE, 0, 1), th.dark);
        ctx.fillRect(sx(b * BIN), y + 2, bw, laneH - 4);
      }
    }

    /* where lane changes are actually happening */
    var log = sim.mergeLog;
    if (log.length > 8) {
      var recent = log.slice(-160);
      var my = top - 4;
      ctx.strokeStyle = th.s1;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var mi = 0; mi < recent.length; mi++) {
        var mx = Math.round(sx(recent[mi])) + 0.5;
        ctx.moveTo(mx, my - 5); ctx.lineTo(mx, my);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      var sorted = recent.slice().sort(function (a, b) { return a - b; });
      var median = sorted[Math.floor(sorted.length / 2)];
      ctx.fillStyle = th.s1;
      ctx.beginPath();
      ctx.arc(sx(median), my - 2.5, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('merges happening here (' +
        ((X_CLOSED - median) / 1000).toFixed(2) + ' km back)',
        T.clamp(sx(median), padL + 82, W - padR - 82), my - 9);
      ctx.textAlign = 'left';
    }

    /* closure marker */
    var cx = sx(X_CLOSED);
    ctx.strokeStyle = th.cone;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, top - 6); ctx.lineTo(cx, top + laneH * 2 + 6);
    ctx.stroke();

    /* queue extent bracket */
    var q = sim.queueExtent();
    if (q.metres > 40) {
      var qx = sx(X_CLOSED - q.metres);
      var by = top + laneH * 2 + 12;
      ctx.strokeStyle = th.ink;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(qx + 0.5, by - 4); ctx.lineTo(qx + 0.5, by);
      ctx.lineTo(cx, by); ctx.lineTo(cx, by - 4);
      ctx.stroke();
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.fillStyle = th.ink;
      ctx.textAlign = 'center';
      var label = (q.metres / 1000).toFixed(2) + ' km queue' + (q.censored ? ' (off-scale)' : '');
      var mid = (qx + cx) / 2;
      ctx.fillText(label, T.clamp(mid, padL + 40, W - padR - 40), by + 12);
      ctx.textAlign = 'left';
    }

    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillStyle = th.muted;
    ctx.fillText('3.2 km of approach', padL, 12);
    ctx.textAlign = 'right';
    ctx.fillText('closure', W - padR, 12);
    ctx.textAlign = 'left';
  }

  /* ------------------------------------------------------------------------
     Widget wiring
     ---------------------------------------------------------------------- */

  T.MergeSim = MergeSim;   /* exported for the headless checks in test/ */

  T.initMergeSim = function () {
    var root = document.getElementById('merge-sim');
    if (!root) return;

    /* Two independent simulations run side by side. They share a seed, so both
       see the identical vehicles arriving at identical instants — anything that
       differs between the panels is merge behaviour and nothing else. */
    var paramsA = { mode: 'mixed', demand: 2400, cooperation: 0.6, headway: 1.25, mergeBack: 80 };
    var paramsB = { mode: 'zipper', demand: 2400, cooperation: 0.6, headway: 1.25, mergeBack: 80 };
    var simA = new MergeSim(paramsA);
    var simB = new MergeSim(paramsB);
    var sides = { a: { sim: simA, params: paramsA }, b: { sim: simB, params: paramsB } };
    var compare = true;
    /* Nothing runs until the reader asks. A simulator left running while
       someone reads three thousand words above it is, by the time they
       arrive, showing a queue that grew to the edge of the model — the
       interesting transient happened minutes ago and off screen. */
    var running = false;
    var started = false;
    var startOverlay = document.getElementById('mg-start');

    var cv = {
      a: { road: document.getElementById('mg-road'), cor: document.getElementById('mg-corridor') },
      b: { road: document.getElementById('mg-road-b'), cor: document.getElementById('mg-corridor-b') }
    };
    var panelB = document.getElementById('mg-panel-b');

    function setMode(side, m) {
      sides[side].params.mode = m;
      sides[side].sim.reset();
      root.querySelectorAll('[data-side="' + side + '"][data-mode]').forEach(function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-mode') === m ? 'true' : 'false');
      });
    }

    root.querySelectorAll('[data-mode]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setMode(btn.getAttribute('data-side'), btn.getAttribute('data-mode'));
      });
    });

    var cmpToggle = document.getElementById('mg-compare-toggle');
    function applyCompare() {
      if (panelB) panelB.hidden = !compare;
      if (cmpToggle) cmpToggle.checked = compare;
      root.classList.toggle('is-comparing', compare);
    }
    if (cmpToggle) {
      cmpToggle.addEventListener('change', function () {
        compare = cmpToggle.checked;
        applyCompare();
      });
    }

    var demandEl = document.getElementById('mg-demand');
    var coopEl = document.getElementById('mg-coop');
    var backEl = document.getElementById('mg-mergeback');
    function readControls() {
      if (demandEl) {
        var d = parseFloat(demandEl.value);
        paramsA.demand = paramsB.demand = d;
        document.getElementById('mg-demand-val').textContent = d.toFixed(0) + ' veh/h';
      }
      if (coopEl) {
        var c = parseFloat(coopEl.value) / 100;
        paramsA.cooperation = paramsB.cooperation = c;
        document.getElementById('mg-coop-val').textContent = (c * 100).toFixed(0) + '%';
      }
      if (backEl) {
        var mb = parseFloat(backEl.value);
        paramsA.mergeBack = paramsB.mergeBack = mb;
        document.getElementById('mg-mergeback-val').textContent = mb.toFixed(0) + ' m';
      }
    }
    if (demandEl) demandEl.addEventListener('input', readControls);
    if (coopEl) coopEl.addEventListener('input', readControls);
    if (backEl) {
      backEl.addEventListener('input', function () {
        readControls();
        /* the merge point is baked into each vehicle's plan at spawn, so a
           change only takes effect on a fresh run */
        if (paramsA.mode === 'custom') simA.reset();
        if (paramsB.mode === 'custom') simB.reset();
      });
    }

    var speed = 2.2;
    root.querySelectorAll('[data-speed]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        speed = parseFloat(btn.getAttribute('data-speed'));
        root.querySelectorAll('[data-speed]').forEach(function (b) {
          b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
        });
      });
    });

    var playBtn = document.getElementById('mg-play');
    var resetBtn = document.getElementById('mg-reset');
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
    if (resetBtn) resetBtn.addEventListener('click', function () { simA.reset(); simB.reset(); });

    function panelStats(side) {
      var sim = sides[side].sim;
      var set = function (k, v) {
        var el = document.getElementById('mg-' + side + '-' + k);
        if (el) el.textContent = v;
      };
      set('thru', sim.t > 60 ? sim.throughput(120).toFixed(0) : '—');
      set('queue', (sim.queueExtent().metres / 1000).toFixed(2));
      set('delay', sim.delays.length > 5 ? sim.meanDelay().toFixed(0) : '—');
      set('stuck', String(sim.strandedCount()));
    }

    function refreshStats() {
      panelStats('a');
      if (compare) panelStats('b');
    }

    /* --- batch comparison --- */
    var compareBtn = document.getElementById('mg-compare');
    var progressEl = document.getElementById('mg-progress');
    var chartEl = document.getElementById('mg-chart');
    var chartTable = document.getElementById('mg-chart-table');

    function renderComparison(results) {
      if (!chartEl) return;
      var th = T.theme(root);
      var colors = { early: th.s1, zipper: th.s3, mixed: th.s2 };
      var metrics = [
        { key: 'throughput', label: 'Vehicles through the closure', unit: ' veh/h', digits: 0, better: 'high' },
        { key: 'delay', label: 'Average delay per vehicle', unit: ' s', digits: 0, better: 'low' },
        { key: 'queue', label: 'Longest queue', unit: ' km', digits: 2, better: 'low', scale: 0.001 }
      ];

      chartEl.innerHTML = metrics.map(function (m) {
        var vals = results.map(function (r) { return r[m.key] * (m.scale || 1); });
        var max = Math.max.apply(null, vals.concat([1e-6]));
        var bars = results.map(function (r, i) {
          var v = vals[i];
          var pct = (v / max) * 100;
          var label = v.toFixed(m.digits) + m.unit;
          return '' +
            '<div class="cmp-row">' +
              '<div class="cmp-name"><span class="swatch" style="background:' + colors[r.mode] + '"></span>' +
                T.MERGE_LABELS[r.mode] + '</div>' +
              '<div class="cmp-track">' +
                '<div class="cmp-bar" style="width:' + pct.toFixed(1) + '%;background:' + colors[r.mode] + '"></div>' +
                '<span class="cmp-val">' + label + (r.censored && m.key === 'queue' ? ' +' : '') + '</span>' +
              '</div>' +
            '</div>';
        }).join('');
        return '<figure class="cmp-group"><figcaption>' + m.label +
               ' <span class="cmp-dir">' + (m.better === 'high' ? 'higher is better' : 'lower is better') +
               '</span></figcaption>' + bars + '</figure>';
      }).join('');

      if (chartTable) {
        chartTable.innerHTML =
          '<thead><tr><th scope="col">Strategy</th><th scope="col">Throughput (veh/h)</th>' +
          '<th scope="col">Delay (s)</th><th scope="col">Queue (km)</th></tr></thead><tbody>' +
          results.map(function (r) {
            return '<tr><th scope="row">' + T.MERGE_LABELS[r.mode] + '</th><td>' +
              r.throughput.toFixed(0) + '</td><td>' + r.delay.toFixed(0) + '</td><td>' +
              (r.queue / 1000).toFixed(2) + (r.censored ? '+' : '') + '</td></tr>';
          }).join('') + '</tbody>';
      }
    }

    if (compareBtn) {
      compareBtn.addEventListener('click', function () {
        compareBtn.disabled = true;
        var modes = ['early', 'zipper', 'mixed'];
        var results = [];
        var wasRunning = running;
        setRunning(false);

        function next(i) {
          if (i >= modes.length) {
            compareBtn.disabled = false;
            if (progressEl) progressEl.textContent = '';
            setRunning(wasRunning);
            renderComparison(results);
            return;
          }
          T.runMergeBatch(paramsA, modes[i], function (res) {
            results.push(res);
            next(i + 1);
          }, function (frac) {
            if (progressEl) {
              progressEl.textContent = 'Simulating ' + T.MERGE_LABELS[modes[i]].toLowerCase() +
                ' — ' + Math.round(((i + frac) / modes.length) * 100) + '%';
            }
          });
        }
        next(0);
      });
    }

    readControls();
    setMode('a', paramsA.mode);
    setMode('b', paramsB.mode);
    applyCompare();
    setPlay();

    var last = 0, acc = 0, statAcc = 0;
    function frame(now) {
      requestAnimationFrame(frame);
      if (!last) last = now;
      var real = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (running) {
        acc += real * speed;   /* faster than real time — queues take a while to form */
        var dt = 1 / 60, guard = 0, maxSteps = 12 + Math.ceil(speed * 10);
        while (acc >= dt && guard++ < maxSteps) {
          simA.step(dt);
          if (compare) simB.step(dt);
          acc -= dt;
        }
        if (acc > 1) acc = 0;
        statAcc += real;
        if (statAcc > 0.3) { refreshStats(); statAcc = 0; }
      }
      drawWorkZone(cv.a.road, simA);
      drawCorridor(cv.a.cor, simA);
      if (compare) {
        drawWorkZone(cv.b.road, simB);
        drawCorridor(cv.b.cor, simB);
      }
    }
    requestAnimationFrame(frame);
    refreshStats();
  };

})(window);
