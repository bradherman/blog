# The Wave Runs Backwards — the model

Notes on what the three simulators actually compute. Everything on the page is
calculated in the browser; no figure in the post is a stored constant.

```
body.html          the post — prose and the simulator markup
js/core.js         IDM, seeded RNG, release rule, colour ramp, canvas helpers
js/light-sim.js    the signal: three streams, metrics, space-time diagram
js/merge-sim.js    the lane closure: gap acceptance, cooperation, A/B panels
js/speed-sim.js    speed vs risk vs money
js/boot.js         theme, scroll indicator, start-up
```

## Longitudinal motion

Longitudinal motion is the Intelligent Driver Model (Treiber, Hennecke &
Helbing, 2000). IDM has no reaction time of its own, so the start-up delay is a
separate release rule: a stopped driver may accelerate only τ seconds after
whichever cue was actually blocking them — the signal, or the vehicle ahead.
That rule is what produces the wave, and setting τ to zero is what makes the
comparison lanes possible.

Three minimum gaps are kept distinct, because conflating them is the difference
between "I left room so I can go" and "I permanently drive four metres further
back":

- **park** — behind a stationary car. This is the slider the reader controls.
- **move** — behind a moving car, and in free driving.
- **line** — at the stop line itself, which nobody parks four metres short of.

## The standing queue

How many cars are already waiting when the signal run starts is a control, not
something derived from the arrival rate. Deriving it guarantees the boring case:
a queue sized to one cycle's arrivals is by construction a queue that one green
can clear, so the light always runs out of cars before it runs out of green, and
the reader never sees the thing the post is about. Seeding it directly puts an
oversaturated approach on screen immediately rather than after the ten or so
cycles it would otherwise take to accumulate. Changing it restarts the run,
because an initial condition cannot be edited halfway through one.

## Measurement

Saturation headway and start-up lost time are measured the way a field engineer
would: regress stop-line crossing time against queue position over the saturated
part of each platoon. Wave speed is a Theil–Sen estimate over release events at
the front of the queue.

Arrivals come from a seeded generator, so the three merge strategies are compared
against an identical vehicle-by-vehicle sequence.

## Arrivals at the signal

Gaps are a shifted exponential: a 0.6 s floor plus an exponential drawn at
whatever rate makes the mean come out at the demand asked for. A truncated
exponential would be wrong in a way that matters — clamping discards every short
gap and quietly lowers the mean, so the slider delivers less flow than it reads.

A vehicle that is due but has nowhere to go waits rather than evaporating, and
keeps its due time as its entry time so that waiting counts as delay. It is
admitted once the entry point has the gap a driver at free-flow speed would
actually keep, which is `s₀ + v₀T` — around 19 m at the default settings, not
the vehicle length it would take to merely avoid an overlap. Admitting into a
bumper gap puts every entrant into an emergency stop and jams the entry while
the road behind it sits empty; the throughput that comes out of that is the
model's boundary, not traffic.

Only once the backlog reaches 200 vehicles is an arrival written off. That means
the queue has reached the far end of the modelled road, which is the one case
where losing it is the honest answer.

## Speed

The speed section uses Nilsson's power model (exponents 4 / 3 / 2), stopping
distances at a friction coefficient of 0.8, a petrol curve fitted to the US DOE's
74-vehicle measurements, and an electric curve fitted to a constant-speed range
test. The power model is a road-level relationship, not a driver-level one, and
the post says so.

## Calibration

Calibration is honest rather than flattering: the signal discharges at about
2.2 s saturation headway against the HCM's ideal of 1.9, and the work-zone lane
carries around 1,500 veh/h against a field range of 1,400–1,700. Read the
differences between scenarios rather than the absolute numbers.

## Tests

```bash
npm test
```

The tests assert the physics and every quantitative claim the post makes — wave
speed against `s / (τ + 0.3)`, the size of each lever at the signal, and the
merge results. If the model drifts, the post becomes wrong, and this fails.
CI runs it before every deploy, so a model change that moves a number the prose
quotes will fail the build rather than ship.
