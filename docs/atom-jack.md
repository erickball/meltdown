# "Atom" Jack — AI contractor assistant

Jack is the Opus-powered head of operations at Atom Enterprises. He lives in
the bottom-right corner of the screen (hard hat says JACK) with an always-
visible "Ask Jack..." entry field next to his head; focusing it (or clicking
him) expands the conversation panel, which opens with a scripted intro (no API
call — the system prompt quotes it so he won't re-introduce himself). He can
explain the model, diagnose simulation behavior, and add/edit/connect/delete
components in construction mode.

## Architecture

```
browser (src/jack/)                    Firebase (functions/)
┌──────────────────────────┐          ┌──────────────────────────────┐
│ JackManager (UI + loop)  │  POST    │ jackChat (Cloud Function v2) │
│ jack-context (CONTEXT    │ ───────► │  - holds ANTHROPIC_API_KEY   │
│   block per user msg)    │          │    (Secret Manager)          │
│ jack-tools-exec (runs    │ ◄─────── │  - claude-opus-5, tools +    │
│   Jack's tool calls on   │  content │    character prompt (cached  │
│   ConstructionManager)   │          │    prefix, server-side)      │
└──────────────────────────┘          │  - $25/mo cap via Firestore  │
                                      │    ledger jack-usage/YYYY-MM │
                                      └──────────────────────────────┘
```

- **Tools are declared server-side** (stable prompt prefix → prompt caching)
  but **executed client-side** against the live plant via
  `ConstructionManager` — the game's own validation and unit conversion
  (bar/°C/MW dialog units) apply. The `list_component_types` catalog is
  generated from `componentDefinitions`, so it can't drift.
- **Context**: each user message carries a `[CONTEXT]` block — mode, component
  inventory, connections, sim readings (capped), selected component, and the
  last ~10 plant edits (user edits are journaled by wrapping the
  ConstructionManager mutators).
- **Budget**: the function reads `jack-usage/{YYYY-MM}` before each call and
  refuses (HTTP 429, in-character message) once the month's cost reaches
  $25, computed at claude-opus-5 list prices including cache reads/writes.
  Concurrent requests can overshoot by ~one request; acceptable slop.
- **Integration**: one `new JackManager({...})` host object in `main.ts`
  `init()` (next to `GameModeManager`), same host-object pattern as career
  mode. Nothing else in the app knows Jack exists.

## Deploy

Function (project `unityriskresearch`, already deployed 2026-07-09):

```sh
npx firebase-tools deploy --only functions --project unityriskresearch
```

- Secret: `ANTHROPIC_API_KEY` in `unityriskresearch` Secret Manager (copied
  from the `claude-fastmail-tools` project's secret of the same name). Rotate
  with `npx firebase-tools functions:secrets:set ANTHROPIC_API_KEY`.
- Endpoint: `https://us-central1-unityriskresearch.cloudfunctions.net/jackChat`
  (hard-coded in `src/jack/jack-manager.ts`).
- Spend ledger: Firestore collection `jack-usage`, one doc per month with
  costUsd / token counters / request count. Delete the doc to reset a month.
- Artifact cleanup policy is set (images older than 1 day are pruned).

The **hosting** side ships Jack only when a build containing `src/jack/` is
deployed (`npm run build && npx firebase-tools deploy --only hosting`).

## Local dev

The client talks to the production function by default (its CORS allows
localhost origins). To use the emulator instead:

```sh
cd functions && npm run build
npx firebase-tools emulators:start --only functions
# then in the browser console:
localStorage.setItem('jack-endpoint',
  'http://127.0.0.1:5001/unityriskresearch/us-central1/jackChat')
```

The emulator needs the secret locally: put `ANTHROPIC_API_KEY=...` in
`functions/.secret.local` (gitignored).

## Bug reports (CARs)

Jack files Corrective Action Reports with the `file_car` tool: the
`fileCar` function stores them in Firestore collection `jack-cars`. The user
sees the whole report in a consent dialog (`src/jack/jack-car-consent.ts`)
before anything is sent.

Once a simulation has been built, a report can carry a **reproduction
bundle** (`src/jack/jack-car-bundle.ts`): the plant design, the live sim
state and the rewind history (snapshots + accepted-dt log), gzipped and
base64'd, capped at 6 MB. Inside the cap the whole history travels; over it,
frame snapshots are thinned first and then the dt log is trimmed from the
old end, so what remains always replays exactly up to the reported moment,
and the summary shown to the user says what was left out. The blob is
stored as ~750 KB slices in the report's `car-chunks` subcollection.

On our side:

```sh
npx tsx scripts/car.ts list              # open reports, newest first
npx tsx scripts/car.ts fetch <id>        # -> cars/<id>/{report.json, bundle.gz, design.json}
npx tsx scripts/repro-car.ts cars/<id> --from 0 --run 60   # replay + continue headless
npx tsx scripts/car.ts close <id>        # delete the report and its chunks
```

`design.json` is in the app's save format: the Import button loads it and
resumes paused at the reported moment. `repro-car.ts --from T` replays the
recorded trajectory from the latest snapshot at or before T and checks that
it lands on the reported state, printing the drift against every recorded
checkpoint on the way; `--run S` then continues with the live solver. On
the same JavaScript engine and build the replay is bit-identical. A bundle
recorded in a browser and replayed in Node differs at round-off level from
the first step (different math libraries), which the flow solver amplifies
(~1e-3 relative after a few seconds of a PWR startup transient) - the same
physics, not a bug, and the drift table shows the difference between that
smooth growth and a jump at one checkpoint. The bundle names the git
commit that produced it (`__BUILD_COMMIT__`, stamped by `vite.config.ts`);
another build may load the bundle but need not reproduce the numbers.

Reports are meant to be closed once dealt with, so other people's plants do
not pile up. As a backstop, every report and chunk carries `expireAt`
(90 days) and the Firestore TTL policy on that field deletes what nobody
closed:

```sh
gcloud firestore fields ttls update expireAt --collection-group=jack-cars --enable-ttl --project=unityriskresearch
gcloud firestore fields ttls update expireAt --collection-group=car-chunks --enable-ttl --project=unityriskresearch
```

## Abuse posture

The endpoint is public (the game has no auth). Protections: origin allowlist
for CORS, request size/turn caps, `maxInstances: 5`, and the hard $10/month
ledger — worst case, a scraper burns the month's chat budget and Jack goes
quiet until the 1st.

## Known limitations / future work

- No streaming — replies appear all at once (client shows tool-action lines
  and any interim text between rounds; 100s fetch timeout per round).
- Placement: the plant overview gives Jack plan positions and building
  footprints, so he can place explicitly (inside/outside containment) and
  move components (move_component updates building containment
  automatically). Without an explicit position, a new component lands at
  its container's footprint center, or beside the plant. He still can't
  see the canvas viewport itself.
- Conversation resets on page reload; capped at 80 messages per conversation.
- `connect_components` picks the first free port matching direction unless
  the model names one; complex multi-port hookups may need the user.
- Sim-state context caps at 40 flow nodes to bound prompt size.
