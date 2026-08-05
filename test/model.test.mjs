/* Headless checks on the two models.

   These assert the physics, and specifically every quantitative claim the post
   makes. If the start-up wave stops matching spacing-over-reaction-time, or the
   merge strategies stop separating on queue length, the post is wrong and this
   fails.

   Run: node test/model.test.mjs
*/
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* The simulators are browser scripts. Give them just enough of a window to
   load; nothing under test touches the DOM. */
const sandbox = {
  window: null,
  document: { documentElement: {}, getElementById: () => null, querySelectorAll: () => [] },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  requestAnimationFrame: () => 0,
  devicePixelRatio: 1,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  console, Math, Object, Float32Array, Map, Set, isFinite, Infinity
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const POST = 'src/posts/the-wave-runs-backwards/js';
for (const f of [`${POST}/core.js`, `${POST}/light-sim.js`, `${POST}/merge-sim.js`, `${POST}/speed-sim.js`]) {
  vm.runInContext(await readFile(join(root, f), 'utf8'), sandbox, { filename: f });
}
const T = sandbox.Traffic;

/* ------------------------------------------------------------------ harness */
let failures = 0;
function check(name, actual, lo, hi, unit = '') {
  const ok = Number.isFinite(actual) && actual >= lo && actual <= hi;
  if (!ok) failures++;
  const val = Number.isFinite(actual) ? actual.toFixed(2) : String(actual);
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${name.padEnd(50)} ${val.padStart(8)}${unit.padEnd(7)} want ${lo}–${hi}`);
}
const note = (s) => console.log(`\n${s}`);

/* ---------------------------------------------------------------- the signal */

const BASE = { tau: 1.2, headway: 1.2, accel: 1.8, s0: 2.0, demand: 1500, green: 30 };

function light(overrides, seconds = 2400) {
  const sim = new T.LightSim();
  Object.assign(sim.params, BASE, overrides);
  sim.reset();
  const dt = 1 / 60;
  for (let i = 0; i < seconds / dt; i++) sim.step(dt);
  return sim;
}
/* Vehicles per green, averaged over the whole run. The per-cycle history is
   integer-valued and too coarse to compare levers with. */
const perGreen = (s) => s.human.crossedTotal / s.cyclesDone;

note('Signal — the start-up wave is spacing over reaction time, plus the ~0.3 s');
note('         each driver needs before there is physically room to move.');
/* Measured at the demand the widget itself defaults to. At twice capacity the
   queue creeps rather than discharging, and the release front is no longer the
   clean start-up wave the formula describes. */
const WAVE_DEMAND = 1050;
for (const tau of [0.8, 1.2, 1.6, 2.0, 2.5]) {
  const w = light({ tau, demand: WAVE_DEMAND }).human.avg('wave') * T.KMH;
  const predicted = ((T.CAR_LEN + 2.0) / (tau + 0.3)) * T.KMH;
  check(`tau=${tau}s wave vs s/(tau+0.3)`, w / predicted, 0.80, 1.20, '×');
}

note('Signal — at ordinary reaction times the wave lands in the measured band');
check('tau=1.2s wave speed',
      light({ tau: 1.2, demand: WAVE_DEMAND }).human.avg('wave') * T.KMH, 14, 20, ' km/h');
check('saturation headway', light({ tau: 1.2 }).human.avg('h'), 1.8, 2.6, ' s');
check('start-up lost time', light({ tau: 1.2 }).human.avg('l1'), 1.5, 4.0, ' s');

note('Signal — with zero reaction the wave does not vanish: geometry sets a floor');
{
  const w0 = light({ tau: 0, demand: WAVE_DEMAND }).human.avg('wave') * T.KMH;
  check('tau=0 wave speed (geometric floor)', w0, 18, 30, ' km/h');
}

/* ------------------------------------------------ what each lever is worth */

note('Signal — the post\'s central claim: no single fix buys much, because');
note('         whichever constraint you relax, another one binds.');
const base = perGreen(light({}));
const pct = (o) => ((perGreen(light(o)) - base) / base) * 100;

check('baseline discharge', base, 11, 15, ' veh');
check('zero reaction time alone', pct({ tau: 0 }), 3, 12, ' %');
check('halved following headway alone', pct({ headway: 0.6 }), 3, 12, ' %');
check('parking tighter is a loss, not a gain', pct({ s0: 1.0 }), -14, -3, ' %');
check('all four together (platoon)',
      pct({ tau: 0.1, s0: 1.0, accel: 2.8, headway: 0.6 }), 28, 70, ' %');

note('Signal — the three release regimes are genuinely distinct');
{
  const sim = light({ demand: 1400 }, 1800);
  const per = (st) => st.crossedTotal / sim.cyclesDone;
  const h = per(sim.human), z = per(sim.ideal), r = per(sim.rigid);
  console.log(`       human ${h.toFixed(2)} · zero-reaction ${z.toFixed(2)} · as-one-body ${r.toFixed(2)} veh/green`);
  check('zero reaction beats human', ((z - h) / h) * 100, 3, 14, ' %');
  check('moving as one body beats both', ((r - z) / z) * 100, 8, 60, ' %');
  check('zero-reaction wave still runs backwards',
        sim.ideal.avg('wave') * T.KMH, 18, 30, ' km/h');
  check('a body that moves together has no wave at all',
        sim.rigid.avg('wave') === null ? 1 : 0, 1, 1, '');
}

note('Signal — degrading any one constraint costs far more than fixing it gains');
check('distraction (tau 2.5 s)', pct({ tau: 2.5 }), -60, -25, ' %');
check('parking much too far back also costs', pct({ s0: 8.0 }), -16, -3, ' %');

note('Signal — the parking gap trades launch against distance, and the best');
note('         value depends on how fast the driver reacts.');
{
  /* One standing queue, one green: how long until the whole thing clears? */
  const clearTime = (parkGap, tau, n = 15) => {
    const sim = new T.LightSim();
    Object.assign(sim.params, BASE, { s0: parkGap, tau, demand: 1, green: 150 });
    sim.reset();
    for (const st of sim.streams) st.cars.length = 0;
    sim.seedQueue(sim.human, n, sim.drivers().park);
    sim.forcePhase('red');
    const dt = 1 / 60;
    for (let i = 0; i < 3 / dt; i++) sim.step(dt);
    sim.forcePhase('green');
    const t0 = sim.t;
    for (let i = 0; i < 200 / dt; i++) {
      sim.step(dt);
      if (sim.human.crossedTotal >= n) return sim.t - t0;
    }
    return Infinity;
  };
  const bestGap = (tau) => {
    const gaps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
    let best = gaps[0], bestT = Infinity;
    for (const g of gaps) { const t = clearTime(g, tau); if (t < bestT) { bestT = t; best = g; } }
    return best;
  };
  const alert = bestGap(0.4), ordinary = bestGap(1.2), slow = bestGap(2.5);
  console.log(`       best parking gap — alert ${alert} m · ordinary ${ordinary} m · distracted ${slow} m`);
  check('an alert driver should park further back', alert, 3, 8, ' m');
  check('an ordinary one, about where people already do', ordinary, 1.5, 3, ' m');
  check('a slow one should park close', slow, 1, 2, ' m');
  check('and the optimum shrinks as reactions slow', alert - slow, 1, 8, ' m');
}

note('Signal — parking further back speeds the release wave up');
{
  const wave = (g) => light({ s0: g, demand: WAVE_DEMAND }).human.avg('wave') * T.KMH;
  const tight = wave(1.0), wide = wave(6.0);
  console.log(`       wave at 1 m: ${tight.toFixed(1)} km/h · at 6 m: ${wide.toFixed(1)} km/h`);
  check('a wider parking gap releases the queue faster', wide / tight, 1.35, 3, '×');
}

note('Signal — a wider stopped gap lengthens the queue');
{
  /* Assert the geometry directly — metres of road consumed per queued vehicle.
     Comparing raw queue lengths is unstable here: a 1 m gap keeps the approach
     under capacity while a 6 m gap pushes it over, so the ratio reflects a
     regime change on top of the spacing effect rather than isolating it. */
  /* Sample at the end of red, when the queue is fully formed. Sampling at an
     arbitrary instant can catch a green with the queue already discharged. */
  const spacing = (s0) => {
    const sim = light({ s0, demand: 1200 }, 900);
    for (let i = 0; i < 120 / (1 / 60); i++) {
      sim.step(1 / 60);
      if (sim.phase === 'red' && sim.phaseEnds - sim.t < 0.5) break;
    }
    return sim.human.queuePitch();
  };
  const tight = spacing(1.0), wide = spacing(6.0);
  console.log(`       ${tight.toFixed(1)} m per vehicle at a 1 m gap · ${wide.toFixed(1)} m at 6 m`);
  check('road consumed per queued vehicle', wide / tight, 1.35, 2.2, '×');
}

/* ----------------------------------------------------------- the lane closure */

function merge(mode, demand, cooperation, seconds = 620, warmup = 200) {
  const sim = new T.MergeSim({ mode, demand, cooperation, headway: 1.25 });
  const dt = 0.05;
  let peak = 0, sum = 0, n2 = 0, cleared = false;
  for (let i = 0, n = seconds / dt; i < n; i++) {
    sim.step(dt);
    if (!cleared && sim.t >= warmup) { sim.crossings.length = 0; sim.delays.length = 0; cleared = true; }
    if (cleared && i % 40 === 0) {
      const q = sim.queueExtent().metres;
      peak = Math.max(peak, q); sum += q; n2++;
    }
  }
  return {
    throughput: sim.throughput(seconds - warmup),
    delay: sim.meanDelay(),
    queue: peak,
    meanQueue: n2 ? sum / n2 : 0
  };
}

note('Merge — the bottleneck is one lane, and no strategy adds a lane');
{
  const early = merge('early', 2400, 0.6);
  const zipper = merge('zipper', 2400, 0.6);
  const mixed = merge('mixed', 2400, 0.6);
  for (const [n, r] of [['early', early], ['zipper', zipper], ['mixed', mixed]]) {
    console.log(`       ${n.padEnd(7)} ${r.throughput.toFixed(0)} veh/h · queue ${(r.queue / 1000).toFixed(2)} km · delay ${r.delay.toFixed(0)} s`);
  }
  check('single work-zone lane capacity', zipper.throughput, 1300, 1800, ' veh/h');
  check('throughput ratio zipper:early', zipper.throughput / early.throughput, 0.88, 1.12, '×');
  check('zipper queue is shorter', zipper.queue / early.queue, 0.4, 0.92, '×');
  check('zipper delay is lower', zipper.delay / early.delay, 0.3, 0.95, '×');
}

note('Merge — below capacity nothing differs, which is when merging early is right');
{
  /* Needs a longer warm-up than the congested case: below capacity the road
     is still flushing its initial fill at 200 s, which reads as a difference
     between strategies when there is none. */
  const early = merge('early', 1200, 0.6, 700, 300);
  const zipper = merge('zipper', 1200, 0.6, 700, 300);
  check('throughputs match', zipper.throughput / early.throughput, 0.9, 1.1, '×');
  /* Peak, not mean, would catch a brief transient slow patch at the taper —
     which is real but is not a standing queue. The claim is that nothing
     sustained forms below capacity. */
  console.log(`       mean queue: early ${early.meanQueue.toFixed(0)} m · zipper ${zipper.meanQueue.toFixed(0)} m`);
  check('no sustained queue forms', Math.max(early.meanQueue, zipper.meanQueue), 0, 200, ' m');
}

note('Merge — cooperation pays near capacity, where breakdown is still in doubt,');
note('         and not deep in oversaturation, where the bottleneck is saturated anyway.');
{
  const near0 = merge('zipper', 2000, 0.0);
  const near1 = merge('zipper', 2000, 1.0);
  console.log(`       at 2000 veh/h: delay ${near0.delay.toFixed(0)}s -> ${near1.delay.toFixed(0)}s`);
  check('cooperation cuts delay near capacity', near1.delay / near0.delay, 0.4, 0.97, '×');

  const deep0 = merge('zipper', 3000, 0.0);
  const deep1 = merge('zipper', 3000, 1.0);
  console.log(`       at 3000 veh/h: delay ${deep0.delay.toFixed(0)}s -> ${deep1.delay.toFixed(0)}s`);
  check('and barely matters when hopelessly over capacity',
        deep1.delay / deep0.delay, 0.85, 1.15, '×');
}

/* ------------------------------------------------------------- speeding */

note('Speed — the arithmetic the bonus section rests on');
{
  const m = T.speedModel({ limit: 60, over: 5, miles: 20, react: 1.5,
                           petrol: 3.50, kwh: 0.17, mpg55: 32 });
  console.log(`       20 mi, 60 -> 65 mph: ${m.minutesSaved.toFixed(2)} min saved, impact ${m.impact.toFixed(1)} mph`);
  check('time saved on a 20 mile trip', m.minutesSaved, 1.4, 1.7, ' min');
  check('fatal risk increase (power model)', m.fatal * 100, 35, 42, ' %');
  check('injury risk increase', m.injury * 100, 15, 20, ' %');
  check('speed at impact where the other driver stops', m.impact, 25, 35, ' mph');
  check('extra fuel cost', m.extraFuel, 0.10, 0.30, ' $');
  check('dollars per hour of time bought', m.perHourPetrol, 4, 12, ' $/h');
  check('electric is cheaper per trip but still penalised',
        m.extraElec / m.elecLimit, 0.05, 0.15, '');
}

note('Speed — the fuel curve reproduces the DOE measurements it was fitted to');
{
  const drop = (a, b) => (1 - T.fuelIndex(a) / T.fuelIndex(b)) * 100;
  check('economy loss 50 -> 60 mph', drop(50, 60), 10.5, 14.5, ' %');
  check('economy loss 60 -> 70 mph', drop(60, 70), 11.5, 16.5, ' %');
  check('economy loss 70 -> 80 mph', drop(70, 80), 12.5, 18, ' %');
}

note('Merge — fighting for the last few metres strands drivers; backing off does not');
{
  const strandedAt = (back, coop) => {
    const sim = new T.MergeSim({ mode: 'custom', mergeBack: back, demand: 2400,
                                 cooperation: coop, headway: 1.25 });
    let sum = 0, n = 0;
    for (let i = 0, N = 900 / 0.05; i < N; i++) {
      sim.step(0.05);
      if (sim.t > 400 && i % 20 === 0) { sum += sim.strandedCount(); n++; }
    }
    return sum / Math.max(n, 1);
  };
  const last = strandedAt(10, 0.6), backedOff = strandedAt(100, 0.6);
  const lastMean = strandedAt(10, 0.2);
  console.log(`       merging at 10 m: ${last.toFixed(2)} stranded · at 100 m: ${backedOff.toFixed(2)}`);
  check('merging at the very last metres strands drivers', last, 0.3, 6, '');
  check('backing off to 100 m clears it', backedOff, 0, 0.15, '');
  check('and it is worse when fewer drivers yield', lastMean / Math.max(last, 0.01), 1.0, 4, '×');
}

console.log(failures === 0
  ? '\nAll model checks passed.\n'
  : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
