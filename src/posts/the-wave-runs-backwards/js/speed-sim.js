/* ============================================================================
   speed-sim.js — what a few miles per hour actually buys, and what it costs
   ----------------------------------------------------------------------------
   Three independent calculations off the same sliders:

     time      arithmetic, and the honest upper bound (no signals, no traffic)
     risk      Nilsson's power model for crash outcomes, plus the stopping
               -distance geometry that makes the abstraction concrete
     money     fuel and energy use against speed, fitted to published curves

   Sources for the constants are in the post's appendix; nothing here is tuned
   to make a point come out.
   ========================================================================== */
(function (global) {
  'use strict';

  var T = global.Traffic;

  var MPH = 0.44704;        // mph -> m/s
  var G = 9.81;
  var MU = 0.8;             // dry asphalt, decent tyres
  var M_PER_MI = 1609.34;

  /* ------------------------------------------------------------------------
     Fuel: relative consumption per mile against speed.

     Fitted to the Oak Ridge National Laboratory measurements of 74 vehicles
     reported by the US DOE: economy falls 12.4% from 50 to 60 mph, a further
     14% from 60 to 70, and another 15.4% from 70 to 80. The quadratic term is
     aerodynamic drag; the 1/v term is the per-mile share of idle and accessory
     load, which is what makes very low speeds inefficient too.
     ---------------------------------------------------------------------- */
  function fuelIndex(mph) {
    var v = Math.max(mph, 15);
    return 0.40 + 1.75e-4 * v * v + 12 / v;
  }
  var FUEL_REF = fuelIndex(55);

  /* Electric: energy per mile, calibrated to a real constant-speed test
     (224.7 Wh/mi at 50 mph, 366.2 Wh/mi at 80). No idle term — an EV at rest
     uses almost nothing — so the curve is flatter at the bottom and the
     penalty for speed is proportionally sharper. */
  function evWhPerMile(mph) {
    return 134 + 0.036282 * mph * mph;
  }

  T.speedModel = function (p) {
    var vl = p.limit, va = p.limit + p.over;
    var out = {};

    /* --- time --- */
    out.hoursLimit = p.miles / vl;
    out.hoursActual = p.miles / va;
    out.minutesSaved = (out.hoursLimit - out.hoursActual) * 60;

    /* --- risk: Nilsson's power model --- */
    var ratio = va / vl;
    out.ratio = ratio;
    out.fatal = Math.pow(ratio, 4) - 1;
    out.serious = Math.pow(ratio, 3) - 1;
    out.injury = Math.pow(ratio, 2) - 1;

    /* --- stopping distance and the speed left over --- */
    var a = MU * G;
    var vlm = vl * MPH, vam = va * MPH;
    out.stopLimit = vlm * p.react + (vlm * vlm) / (2 * a);
    out.stopActual = vam * p.react + (vam * vam) / (2 * a);
    /* A hazard appears exactly where the compliant driver can just stop. */
    var D = out.stopLimit;
    var braking = D - vam * p.react;
    var vImpact2 = braking <= 0 ? vam * vam : (vam * vam - 2 * a * braking);
    out.impact = Math.sqrt(Math.max(0, vImpact2)) / MPH;
    out.hazard = D;

    /* --- money --- */
    var mpgAt = function (v) { return p.mpg55 * FUEL_REF / fuelIndex(v); };
    out.mpgLimit = mpgAt(vl);
    out.mpgActual = mpgAt(va);
    out.fuelLimit = (p.miles / out.mpgLimit) * p.petrol;
    out.fuelActual = (p.miles / out.mpgActual) * p.petrol;

    out.whLimit = evWhPerMile(vl);
    out.whActual = evWhPerMile(va);
    out.elecLimit = (p.miles * out.whLimit / 1000) * p.kwh;
    out.elecActual = (p.miles * out.whActual / 1000) * p.kwh;

    out.extraFuel = out.fuelActual - out.fuelLimit;
    out.extraElec = out.elecActual - out.elecLimit;
    /* What you paid, in fuel alone, for the time you bought. */
    var hoursSaved = out.minutesSaved / 60;
    out.perHourPetrol = hoursSaved > 1e-6 ? out.extraFuel / hoursSaved : 0;
    out.perHourElec = hoursSaved > 1e-6 ? out.extraElec / hoursSaved : 0;

    return out;
  };

  T.fuelIndex = fuelIndex;
  T.evWhPerMile = evWhPerMile;

  /* ------------------------------------------------------------------------
     The stopping-distance animation. Two cars, one hazard, placed exactly
     where the driver at the limit can stop with nothing to spare.
     ---------------------------------------------------------------------- */

  function carPosition(v, react, t, decel) {
    if (t <= react) return { x: v * t, v: v };
    var tb = t - react;
    var tStop = v / decel;
    if (tb >= tStop) return { x: v * react + (v * v) / (2 * decel), v: 0 };
    return { x: v * react + v * tb - 0.5 * decel * tb * tb, v: v - decel * tb };
  }

  function drawStopping(canvas, p, m, t) {
    var f = T.fitCanvas(canvas);
    var ctx = f.ctx, W = f.w, H = f.h;
    var th = T.theme(canvas);
    ctx.clearRect(0, 0, W, H);

    var padL = 10, padR = 10;
    var plotW = W - padL - padR;
    var span = m.hazard * 1.22 + 12;
    var sx = function (x) { return padL + (x / span) * plotW; };

    var laneH = 26, top = 30, gap = 16;
    var a = MU * G;
    var lanes = [
      { v: p.limit * MPH, y: top, c: th.s3, name: 'At the limit — ' + p.limit + ' mph' },
      { v: (p.limit + p.over) * MPH, y: top + laneH + gap, c: th.s2,
        name: (p.over > 0 ? '+' + p.over + ' mph — ' : '') + (p.limit + p.over) + ' mph' }
    ];

    lanes.forEach(function (L) {
      ctx.fillStyle = th.asphalt;
      ctx.fillRect(padL, L.y, plotW, laneH);

      var st = carPosition(L.v, p.react, t, a);
      var hit = st.x >= m.hazard;
      var cx = sx(Math.min(st.x, m.hazard));

      /* hazard */
      var hx = sx(m.hazard);
      ctx.fillStyle = th.stop;
      ctx.fillRect(hx, L.y, 3, laneH);

      /* the car */
      var carW = Math.max(9, (4.8 / span) * plotW);
      var speedNow = hit ? Math.sqrt(Math.max(0, L.v * L.v - 2 * a * Math.max(0, m.hazard - L.v * p.react))) : st.v;
      /* Identity colour, not the congestion ramp: a car that stops safely at
         the hazard is stationary, and the ramp would paint it the same red as
         one that hit something. Red here means impact and nothing else. */
      ctx.fillStyle = (hit && speedNow > 0.5) ? th.stop : L.c;
      T.roundRect(ctx, cx - carW, L.y + 6, carW, laneH - 12, 2);
      ctx.fill();

      /* label */
      ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.fillStyle = L.c;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(L.name.toUpperCase(), padL + 2, L.y - 6);

      ctx.fillStyle = hit && speedNow > 0.5 ? th.stop : th.muted;
      var readout = hit && speedNow > 0.5
        ? ('HITS AT ' + (speedNow / MPH).toFixed(0) + ' MPH')
        : (st.v < 0.05 ? 'STOPPED' : (st.v / MPH).toFixed(0) + ' mph');
      ctx.fillText(readout, padL + 2 + ctx.measureText(L.name.toUpperCase()).width + 12, L.y - 6);
    });

    /* hazard caption */
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillStyle = th.muted;
    ctx.textAlign = 'center';
    var hx2 = sx(m.hazard);
    ctx.fillText('hazard at ' + m.hazard.toFixed(0) + ' m',
                 T.clamp(hx2, padL + 50, W - padR - 50),
                 top + laneH * 2 + gap + 18);
    ctx.textAlign = 'left';
  }

  /* ------------------------------------------------------------------------
     Cost against speed. One axis, two series in the same units ($ for this
     trip), a recessive grid, and direct labels only on the marked points.
     ---------------------------------------------------------------------- */
  function drawCostChart(canvas, p, m) {
    var f = T.fitCanvas(canvas);
    var ctx = f.ctx, W = f.w, H = f.h;
    var th = T.theme(canvas);
    ctx.clearRect(0, 0, W, H);

    var padL = 46, padR = 92, padT = 14, padB = 30;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var vMin = 40, vMax = 85;

    var series = [
      { name: 'Petrol', c: th.s1, f: function (v) { return (p.miles / (p.mpg55 * FUEL_REF / fuelIndex(v))) * p.petrol; } },
      { name: 'Electric', c: th.s3, f: function (v) { return (p.miles * evWhPerMile(v) / 1000) * p.kwh; } }
    ];

    var peak = 0;
    series.forEach(function (S) {
      for (var v = vMin; v <= vMax; v++) peak = Math.max(peak, S.f(v));
    });
    /* round the axis up to a readable step rather than a raw maximum, so the
       gridline labels are money amounts a person would actually write down */
    var steps = 4;
    var raw = (peak * 1.1 || 1) / steps;
    var nice = [0.05, 0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10, 25, 50];
    var step = nice[nice.length - 1];
    for (var n = 0; n < nice.length; n++) {
      if (nice[n] >= raw) { step = nice[n]; break; }
    }
    var maxY = step * steps;

    var px = function (v) { return padL + ((v - vMin) / (vMax - vMin)) * plotW; };
    var py = function (y) { return padT + plotH - (y / maxY) * plotH; };

    /* grid — solid hairlines, one shade off the surface */
    ctx.strokeStyle = th.grid;
    ctx.lineWidth = 1;
    for (var i = 0; i <= steps; i++) {
      var yy = Math.round(py((maxY / steps) * i)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
    }

    /* the two speeds under discussion */
    [{ v: p.limit, lab: 'limit' }, { v: p.limit + p.over, lab: 'you' }].forEach(function (mark, k) {
      if (mark.v < vMin || mark.v > vMax) return;
      var x = Math.round(px(mark.v)) + 0.5;
      ctx.strokeStyle = k === 0 ? th.grid : th.inkSoft;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
      ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.fillStyle = th.muted;
      ctx.textAlign = 'center';
      ctx.fillText(mark.lab, x, padT - 3);
      ctx.textAlign = 'left';
    });

    /* series */
    series.forEach(function (S) {
      ctx.strokeStyle = S.c;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (var v = vMin; v <= vMax; v += 0.5) {
        var X = px(v), Y = py(S.f(v));
        if (v === vMin) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      }
      ctx.stroke();

      /* marker + direct label at the driver's actual speed only */
      var va = T.clamp(p.limit + p.over, vMin, vMax);
      var cy = py(S.f(va));
      ctx.fillStyle = th.surface;
      ctx.beginPath(); ctx.arc(px(va), cy, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = S.c;
      ctx.beginPath(); ctx.arc(px(va), cy, 3, 0, Math.PI * 2); ctx.fill();

      ctx.font = '600 10px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillStyle = S.c;
      ctx.fillText(S.name + '  $' + S.f(va).toFixed(2), padL + plotW + 8, cy + 3.5);
    });

    /* axes */
    ctx.strokeStyle = th.grid;
    ctx.beginPath();
    ctx.moveTo(padL + 0.5, padT); ctx.lineTo(padL + 0.5, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH); ctx.stroke();

    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillStyle = th.muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (i = 0; i <= steps; i++) {
      var val = (maxY / steps) * i;
      ctx.fillText('$' + val.toFixed(step < 1 ? 2 : 2), padL - 6, py(val));
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (var v2 = vMin; v2 <= vMax; v2 += 15) {
      ctx.fillText(v2 + '', px(v2), padT + plotH + 14);
    }
    ctx.fillText('speed (mph)', padL + plotW / 2, padT + plotH + 26);
    ctx.textAlign = 'left';
  }

  /* ------------------------------------------------------------------------
     Widget
     ---------------------------------------------------------------------- */

  function fmtMinutes(min) {
    if (min < 1) return Math.round(min * 60) + ' s';
    var m = Math.floor(min), s = Math.round((min - m) * 60);
    if (s === 60) { m += 1; s = 0; }
    return m + ' min' + (s ? ' ' + s + ' s' : '');
  }
  function pct(x) { return (x >= 0 ? '+' : '') + (x * 100).toFixed(0) + '%'; }

  /* Journey length reads more naturally as a duration once the trip runs to
     hours, so the distance slider shows both. */
  function fmtDuration(min) {
    var h = Math.floor(min / 60), m = Math.round(min - h * 60);
    if (m === 60) { h += 1; m = 0; }
    if (h === 0) return m + ' min';
    return h + ' h' + (m ? ' ' + m + ' min' : '');
  }

  T.initSpeedSim = function () {
    var root = document.getElementById('speed-sim');
    if (!root) return;

    var stopCanvas = document.getElementById('sp-stopping');
    var costCanvas = document.getElementById('sp-cost');

    var ranges = {
      limit: 'sp-limit', over: 'sp-over', miles: 'sp-miles',
      react: 'sp-react', petrol: 'sp-petrol', kwh: 'sp-kwh'
    };
    var units = {
      limit: [' mph', 0], over: [' mph', 0], miles: [' mi', 0],
      react: [' s', 1], petrol: ['/gal', 2], kwh: ['/kWh', 2]
    };
    var p = { limit: 60, over: 5, miles: 20, react: 1.5, petrol: 3.50, kwh: 0.17, mpg55: 32 };

    function readControls() {
      Object.keys(ranges).forEach(function (k) {
        var el = document.getElementById(ranges[k]);
        if (!el) return;
        p[k] = parseFloat(el.value);
        var out = document.getElementById(ranges[k] + '-val');
        if (!out) return;
        if (k === 'miles') {
          /* `limit` is read before `miles`, so the duration is always current */
          out.textContent = p.miles.toFixed(0) + ' mi · ' +
            fmtDuration((p.miles / p.limit) * 60);
        } else {
          out.textContent = (k === 'petrol' || k === 'kwh' ? '$' : '') +
            p[k].toFixed(units[k][1]) + units[k][0];
        }
      });
      refresh();
    }
    Object.keys(ranges).forEach(function (k) {
      var el = document.getElementById(ranges[k]);
      if (el) el.addEventListener('input', function () {
        readControls();
        if (!playing) t = endOfRun();
      });
    });

    var out = {};
    ['saved', 'fatal', 'impact', 'injury', 'stopping', 'perhour', 'extra', 'mpg']
      .forEach(function (k) { out[k] = document.getElementById('sp-out-' + k); });
    var tableBody = document.getElementById('sp-table-body');

    var model = null;
    function refresh() {
      model = T.speedModel(p);
      var m = model;
      if (out.saved) out.saved.textContent = p.over === 0 ? '0 s' : fmtMinutes(m.minutesSaved);
      if (out.fatal) out.fatal.textContent = pct(m.fatal);
      if (out.injury) out.injury.textContent = pct(m.injury);
      if (out.impact) out.impact.textContent = m.impact.toFixed(0);
      if (out.stopping) out.stopping.textContent = (m.stopActual - m.stopLimit).toFixed(0);
      if (out.extra) out.extra.textContent = '$' + m.extraFuel.toFixed(2);
      if (out.perhour) {
        out.perhour.textContent = p.over === 0 ? '—' : '$' + m.perHourPetrol.toFixed(2);
      }
      if (out.mpg) out.mpg.textContent = m.mpgActual.toFixed(1);

      if (tableBody) {
        var rows = [
          ['Journey time', (m.hoursLimit * 60).toFixed(1) + ' min', (m.hoursActual * 60).toFixed(1) + ' min'],
          ['Stopping distance', m.stopLimit.toFixed(0) + ' m', m.stopActual.toFixed(0) + ' m'],
          ['Relative risk of a fatal crash', '1.00×', Math.pow(m.ratio, 4).toFixed(2) + '×'],
          ['Relative risk of any injury crash', '1.00×', Math.pow(m.ratio, 2).toFixed(2) + '×'],
          ['Fuel used', (p.miles / m.mpgLimit).toFixed(2) + ' gal', (p.miles / m.mpgActual).toFixed(2) + ' gal'],
          ['Fuel cost', '$' + m.fuelLimit.toFixed(2), '$' + m.fuelActual.toFixed(2)],
          ['Energy used (electric)', (p.miles * m.whLimit / 1000).toFixed(2) + ' kWh',
            (p.miles * m.whActual / 1000).toFixed(2) + ' kWh'],
          ['Energy cost (electric)', '$' + m.elecLimit.toFixed(2), '$' + m.elecActual.toFixed(2)]
        ];
        tableBody.innerHTML = rows.map(function (r) {
          return '<tr><th scope="row">' + r[0] + '</th><td>' + r[1] + '</td><td>' + r[2] + '</td></tr>';
        }).join('');
      }
    }

    readControls();

    /* The stopping scene plays once, on request, and then rests on its final
       frame — which is the useful one, because it is the frame showing what the
       faster car is still doing when the other has already stopped. It does not
       loop: an animation running on its own beside three paragraphs of prose is
       a distraction, and it is finished long before anyone scrolls to it. */
    function endOfRun() {
      return p.react + ((p.limit + p.over) * MPH) / (MU * G) + 0.4;
    }

    var t = endOfRun(), last = 0, playing = false;
    var replayBtn = document.getElementById('sp-replay');

    function setReplay() {
      if (!replayBtn) return;
      replayBtn.textContent = playing ? 'Playing…' : 'Play it';
      replayBtn.disabled = playing;
    }

    function play() {
      if (T.reducedMotion()) { t = endOfRun(); return; }
      t = 0;
      playing = true;
      setReplay();
    }
    if (replayBtn) replayBtn.addEventListener('click', play);

    function frame(now) {
      requestAnimationFrame(frame);
      if (!last) last = now;
      var dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      if (playing) {
        var done = endOfRun();
        t += dt;
        if (t >= done) { t = done; playing = false; setReplay(); }
      }

      drawStopping(stopCanvas, p, model, t);
      drawCostChart(costCanvas, p, model);
    }
    setReplay();
    requestAnimationFrame(frame);
  };

})(window);
