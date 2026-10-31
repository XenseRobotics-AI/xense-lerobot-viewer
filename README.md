# XenseRobotics · LeRobot Local Dataset Visualizer

A web tool by **Xense Robotics** for interactive exploration of **local** LeRobot datasets — videos, sensor signals, episode statistics, and 3D URDF replay, all served straight from the filesystem.

This fork removes the Hugging Face Hub remote-loading path; everything reads from your local LeRobot cache (`~/.cache/huggingface/lerobot` by default).

## Startup and browser recovery

Public episode URLs remain `/_local/...`. An internal `/viewer/...` route avoids
Next 15 dev client navigation under-encoding escaped underscore script paths.
The UI uses installed system fonts; starting or building the viewer does not
require Google Fonts. Dataset-card and episode-list links load on selection
instead of prefetching routes while you browse. Preview videos detach when they
leave the viewport or the grid unmounts, and local files stream with cancellation
rather than buffering complete videos in memory. Cold dataset-size scans use a
bounded filesystem queue; concurrent refreshes share the same in-progress scan.
The first scan of a large archive can still take time, especially on slow storage.

If a browser tab was open against another app or an older build on the same
host and port, close those old tabs and perform a hard refresh. The viewer has
no `/api/workbench/shared-sync` endpoint or caller. Persistent requests to that
path come from another client; use the browser Network panel's Initiator column
to identify it. Do not run `bun run build` while `bun dev` is running in the
same checkout: both write `.next/`. A failed JavaScript asset triggers at most
one automatic recovery reload per tab, so a persistent failure reaches the error
UI instead of repeatedly reloading while a slow compilation finishes.

## Human episode inspection

The **Episode** and **3D Replay** tabs share manual inspection marks. Select a
preset inspector, then click **Mark as inspected** after checking an episode.
The last selected inspector is remembered in the browser across episodes, tabs
and datasets. Playback alone never creates a mark. Multiple inspectors can
inspect the same episode; undo removes only the selected inspector's mark.
Each new mark records the inspector name, roster role, server timestamp (UTC+8) and entry tab
(`episodes` or `urdf`). Names are self-selected labels, not authenticated identities.

Records are stored together under the directory selected by the homepage's path
switcher, **not inside an individual dataset** and not always under
`LOCAL_DATASET_ROOT`:

```text
<selected-browse-directory>/.xense-viewer/episode-reviews.json
<selected-browse-directory>/.xense-viewer/reviewers.json
```

The roster is local configuration, read fresh from the **currently selected work
directory** on each API request. There are no hardcoded personal names, shared
roster cache, or environment-variable fallbacks. Switching browse directories
also switches both the roster and inspection records. Edit that directory's
reviewers.json to update people without rebuilding the application. A missing or
explicitly empty file disables marking; existing records remain readable.

Use role objects; legacy arrays of names are still accepted as inspectors:

    [
      { "name": "Inspector A", "role": "inspector" },
      { "name": "Administrator A", "role": "admin" },
      { "name": "Developer A", "role": "developer" }
    ]

Roles are labels, not authentication or access control. Both reviewers.json and
episode-reviews.json belong in .xense-viewer, which is excluded by .gitignore;
never commit personal configuration or review data with the source code.
The selected work directory must be writable for marking.

New records use ISO 8601 timestamps with an explicit +08:00 offset. Historical
UTC timestamps retain their actual instant and are converted to UTC+8 on read,
display and export; they are not shifted twice. Browser/OS timezone settings do
not change the inspection time shown.

The record file is keyed by each dataset's path relative to the browse directory,
then by episode index, so identically numbered episodes in different datasets do
not collide. The viewer pins the selected browse directory when it opens, so
switching the homepage directory in another browser tab cannot redirect a save.
An episode outside that directory must be reopened from the correct dataset list.

The sidebar shows inspection progress, per-person counts, and filters for
uninspected / inspected / awaiting cross-review / cross-reviewed / awaiting my
check / inspected by me. Two or more **different people** marking an episode
make it cross-reviewed; repeated marks by the same name count once. Undo removes
only that person's mark and updates the status. A mark records that somebody
checked the episode, not a quality pass or fail.

The **homepage** provides collection-wide counts and CSV / JSON export under
“Inspection management”. CSV contains one row per person and episode with the
dataset path, role, UTC+8 timestamp, entry tab, status and number of inspectors.
Statistics include saved historical records even if a dataset is no longer
present. The overview only reads the shared record file; it never scans media.

Other open viewers refresh on focus and every 30 seconds while visible; the
homepage overview refreshes every 60 seconds while visible. Requests do not
overlap and reads are aborted when the owning view unmounts. Writes merge under
an exclusive lock and replace the JSON atomically; failures are shown without
displaying an unsaved checkmark. If the server crashes while writing and leaves
episode-reviews.json.lock behind, stop all viewer processes before removing
that stale lock directory.

Resource handling preserves active playback: paused 3D scenes render on demand
(including seeking, camera controls and asynchronously loaded models), active
playback keeps the full render loop, and inactive/hidden 3D views stop rendering.
Episode pose plots and spatial trajectory scenes also redraw only when their
data or controls change, retaining the existing dataset-frame playback clock.
Hiding the browser tab pauses playback without automatically resuming it on
return. Offscreen previews and unmounted videos release their media sources;
metadata/parquet loading for the active episode is not throttled away.

When playback is paused and the active media is ready, Episodes and 3D Replay
warm parsed chart/pose data for episode links actually visible in the sidebar.
After 350 ms without navigation/scroll/input, browser idle time starts one
background episode at a time, nearest to the current episode first, with a 50 ms
gap between completed idle jobs. Hidden tabs,
offline connections, data saver and 2G stop new background work. Existing reads
finish normally; selecting the same episode joins its read, and selecting another
episode starts immediately. Preloading never creates inspection marks and does
not download adjacent videos or prefetch every route on the page.

Parsed foreground history is limited to 8 episodes / an estimated 192 MiB; the
active episode stays usable even if it alone exceeds the byte budget. A separate
background cache holds at most 24 episodes / an estimated 128 MiB. Once offscreen,
entries within 2 episodes expire after 10 minutes, within 12 after 4 minutes,
and farther away or in another dataset after 1 minute. Pruning runs every
30 seconds; capacity pressure releases distant offscreen entries sooner. Visible
and current entries remain protected from age eviction. Leaving the viewer
also schedules cleanup. The main thread and one background worker each limit raw
Parquet caches to 16 files / 512 ranges / 128 MiB, with 10-minute idle expiry
(256 MiB combined raw-cache ceilings per tab). Together with parsed caches, the
named budgets sum to 576 MiB; these are cache budgets, not a hard cap on browser
memory or active
decoding/video buffers. Failed byte reads are retryable and never cached forever.
Retention, cleanup periods and byte budgets are centralized in
src/utils/episodeCachePolicy.ts. Count limits are unchanged when byte budgets
are raised; caches allocate only when data is read, not up front.
These limits are shared across datasets in one browser tab, independently of
other tabs or machines. Counts and bytes are simultaneous limits: reaching
either triggers capacity eviction without waiting for age expiry. Parsed-data
bytes use a sampled object-size estimate (chart/pose rows, timestamp arrays and
language content), not a browser heap measurement. Raw Parquet bytes use actual
ArrayBuffer.byteLength, shared across files within each runtime rather than
allocated per file.
Byte budgets apply to retained in-memory data, not dataset size, file-size
access limits, disk usage or cumulative network traffic. A speculative episode
larger than its whole budget is not retained. Video,
GPU/3D resources, mounted views and in-flight decodes are outside these budgets.

Cold foreground reads start directly, avoiding worker queueing and large result
clones. Background decoding runs in one dedicated Web Worker, keeping speculative
Parquet/chart processing off the UI thread. An unsupported or failed worker skips
preloading; foreground loading remains available. A foreground selection that
adopts a failing preload retries once directly; concurrent selectors share the retry. Workers release after 10 idle
minutes; a separate 120-second decode deadline permits retry without treating tab
visibility as cancellation. Worker results reuse the UI's shared episode index,
and oversized speculative results are rejected before cloning.

Ordinary joint charts flatten only the existing 4,000 display samples. Pose and
gripper velocities still use original adjacent source frames before display
sampling; original frame timestamps and sampling endpoints are preserved. A
synthetic V3 fixture (20.6 MiB, 30,000 frames, 43 state and 43 action dimensions)
measured three-run median cold decoding of about 349 ms before and 245 ms after
this optimization in headless Chrome. This isolates parsing/chart preparation;
NFS latency, video loading and other dataset shapes can differ.

## Features

- **Local dataset browser**: the homepage lists every LeRobot dataset under your local root with a video preview and metadata badge (robot type, codebase version, episode count). Filter by name, robot type, or **dataset tags** (see below). Source cards name the robot types they hold, and each dataset card shows its shape (`20-dim + 7 streams`) — amber when that shape contradicts the dataset's declared `robot_type`, which is how a half-configured capture gets caught.
- **Dataset health probing**: each dataset is scanned for `meta/info.json` + `data/` + `videos/` and classified as Healthy / Empty / Incomplete. The homepage shows red/amber card borders + corner badges for problem datasets; clicking an incomplete one opens a diagnostic page instead of failing on a missing file.
- **Editable dataset tags** (task / scene / objects): annotate each dataset with a task category (`pick_and_place`, `peeling`, …), a scene (`tabletop`, `kitchen`, …), and a list of manipulated objects (`cucumber`, `box`, …). Tags persist as `meta/xense_tags.json` inside the dataset and power a task-based filter on the homepage. See [Tagging datasets](#tagging-datasets) below.
- **Synchronized video + telemetry**: episode pages play all cameras side-by-side, synced to interactive Recharts time series for `observation.state`, `action`, and other signals.
- **Language annotations editor** (lerobot v3.1 schema): an **Annotations** tab for authoring per-episode language atoms — subtasks, plans, memory, task rephrasings, interjections, robot speech, and VQA. Draw a bounding box or click a keypoint directly on any video for grounded VQA, arrange events on a multi-track timeline, and edit each atom in an inspector. Saves to `meta/lerobot_annotations.json` inside the dataset. See [Annotating episodes](#annotating-episodes) below.
- **Statistics, Frames, Action Insights, Filtering** panels for dataset quality inspection — flagged episodes can be exported as a ready-to-run LeRobot CLI command.
- **3D pose trajectories**: the Episodes chart has a `3D` mode that draws the current episode's Cartesian path with a marker synced to video playback, and Action Insights adds a **cross-episode trajectory distribution** — one line per episode, hover to identify, click to isolate, with per-arm layers toggled independently. Both need complete named xyz feature groups (`left_tcp.x/y/z`); numeric-only feature names are skipped, since nothing identifies which three dimensions form a position.
- **Subtask labeling** (Pi-style segmentation): an Episodes-tab panel for labeling contiguous subtask ranges that persist until the next one, saved to `meta/annotations.json`. An **Export** button compiles them into lerobot-native per-frame `subtask_index` + `meta/subtasks.parquet` — the layer that produces a trainable `sample["subtask"]`.
- **Parquet browser**: a raw table view of any `.parquet` in the dataset — file picker, column picker, paged rows, cell expansion, CSV export. Parsing happens server-side, so a 100 MB v3 data file pages without shipping the whole row group to the browser.
- **Doctor**: read-only, dataset-wide diagnostics immediately after Action Insights. Its native TypeScript engine provides 13 checks over metadata, timing, actions, dimension-level continuity, optional configurable TCP linear/angular speed limits, video containers, statistics, episode consistency, training readiness, anomalies, and portability; the speed check is enabled explicitly in the Doctor panel, it needs no Python runtime, and it can send affected episode IDs into the existing flagged-episode workflow.
- **3D URDF replay** for SO-100, SO-101, OpenArm, G1, and bimanual TacCap data-collection grippers. TacCap replay treats recorded poses as canonical TCP by default; the `Tracker → TCP` button applies the measured or dataset-provided extrinsic only when selected manually. It animates both finger joints, conditionally replays complete `head.xyz+r1-r6` trajectories with a self-contained schematic HMD, and labels the world axes (+X forward, +Y left, +Z up); its URDF/STL assets are bundled under `public/urdf/taccap-grippers`. Other robot assets load from the public Hugging Face `lerobot/robot-urdfs` bucket. Recorded cameras replay alongside the model as synchronized overlays — grouped into left / top-center / right by `left`, `right` and `head` in the feature name — and each tile can be dragged to resize, clicked to bring to front, or double-clicked to reset.
- **Per-card "Open episode N" shortcut**: jump straight to a specific episode from the homepage card.
- **Keyboard playback control**: `Space` plays/pauses, `↑`/`↓` step between episodes, and `←`/`→` seek ±5 s in 3D replay. The shortcuts keep working after you click the sidebar or a replay control, and still yield to text fields and to buttons that need `Space` themselves.
- Supports dataset codebase versions **v2.0 / v2.1 / v3.0** (autodetected from `meta/info.json`).

## Prerequisites

- [Bun](https://bun.sh) for the package manager and test runner
- A directory of LeRobot datasets on disk

```bash
curl -fsSL https://bun.sh/install | bash
```

## Setup

```bash
git clone git@github.com:XenseRobotics-AI/xense-lerobot-viewer.git
cd xense-lerobot-viewer
bun install
bun dev
```

Open <http://localhost:3000>. The homepage scans your local LeRobot root and shows everything it finds.

## Local dataset root

The app expects a directory tree like this:

```text
<LOCAL_DATASET_ROOT>/
  <org-or-namespace>/<dataset-name>/
    meta/info.json
    data/...
    videos/...
```

The root is resolved in this order:

1. `LOCAL_DATASET_ROOT` (server-side only)
2. `NEXT_PUBLIC_LOCAL_DATASET_ROOT` (server- or client-readable)
3. `${HOME}/.cache/huggingface/lerobot` (default)

Set it explicitly when running outside the default location:

```bash
LOCAL_DATASET_ROOT=/data/lerobot bun dev
```

Datasets are discovered by recursively scanning for `meta/info.json` (up to 3 levels deep). The `calibration/` directory is skipped automatically.

### Switching the path without a restart

`LOCAL_DATASET_ROOT` is fixed when the server starts, so the **Change** button
beside the "Browsing …" line on the homepage points the scan somewhere else —
an archive drive, a fresh conversion in `/archive/TacVerse` — without moving
the data or restarting:

- Pick any remembered path to switch to it, or add a new one: **Choose
  folder…** opens the desktop's own folder dialog (`zenity`, or `kdialog` on
  KDE) and the chosen path is remembered and switched to in one go. The path
  can also be typed.
- The dialog opens on the desktop of the machine running the server — the one
  holding the datasets — whichever address the browser used to get there, and
  only one can be open at a time. A browser cannot supply an absolute path by
  itself (`webkitdirectory` and the File System Access API both withhold it),
  which is why the server opens the dialog. If the server has no desktop
  session, or the browser is on another machine, type the path instead.
- The selected path is scanned exactly like the root, including a path that is
  itself a single dataset. Its episodes are addressed by absolute path
  (`/_local/<base64url(absolute path)>/episode_N`).
- The list lives in `<root>/.xense-viewer/locations.json` and the selection in
  a cookie, so both survive a restart. The default root stays the anchor: the
  list, the corpus history and the trash are always written there, and datasets
  outside it have no Delete button because the trash would refuse them.

### Downloading datasets

Use the standard `huggingface-cli` to populate the cache:

```bash
huggingface-cli download lerobot/svla_so101_pickplace \
  --repo-type dataset \
  --local-dir ~/.cache/huggingface/lerobot/lerobot/svla_so101_pickplace
```

Once the download finishes, refresh the homepage — the new dataset will appear.

## Commands

```bash
bun dev              # Next.js dev server
bun run build        # Production build
bun start            # Production server
bun test             # Unit tests (bun:test)
bun run test:video-playback # Chromium/H.264 playback regression (requires ffmpeg)
bun run type-check   # TypeScript: app + tests
bun run lint         # ESLint
bun run format       # Prettier --write
bun run validate     # type-check + lint + format:check + test
```

After any code change: `bun run format && bun run validate`.

## Tuning (optional)

The episode viewer downsamples aggressively on purpose: a v3 dataset packs many
episodes into one ~100 MB parquet, so the panels that read across episodes are
bounded by how much they are allowed to fetch and draw, not by the dataset size.
All of these are server-side env vars with sane defaults — set them only if a
panel is too coarse (raise) or too slow on your hardware (lower).

| Variable                                    | Default | Controls                                                                  |
| ------------------------------------------- | ------- | ------------------------------------------------------------------------- |
| `MAX_EPISODE_POINTS`                        | 4000    | Chart rows kept per episode after downsampling                            |
| `MAX_FRAMES_OVERVIEW_EPISODES`              | 3000    | Episodes scanned for the Frames panel                                     |
| `MAX_CROSS_EPISODE_SAMPLE`                  | 120     | Episodes sampled for the cross-episode statistics panels                  |
| `MAX_CROSS_EPISODE_FRAMES_PER_EPISODE`      | 2500    | Rows read per episode in that pass                                        |
| `MAX_SPATIAL_TRAJECTORY_EPISODES`           | 400     | Episodes sampled for the 3D trajectory distribution                       |
| `MAX_SPATIAL_TRAJECTORY_POINTS`             | 120000  | Hard ceiling on rendered trajectory points across all episodes and layers |
| `MAX_SPATIAL_TRAJECTORY_POINTS_PER_EPISODE` | 240     | Ceiling per single trajectory                                             |
| `CROSS_EPISODE_FILE_CONCURRENCY`            | 8       | Parquet files read in parallel                                            |

Values below each variable's minimum are ignored in favour of the default. The
trajectory panel reports `{loaded} / {total} episodes shown`, so you can always
see how much of the dataset the picture actually covers.

## Tagging datasets

LeRobot's schema doesn't carry a concept of "task category" or "scene" at the dataset level — only natural-language `tasks` per episode. This visualizer adds an editable sidecar so you can curate three pieces of dataset-level metadata:

| Field     | Type                      | Example                                   |
| --------- | ------------------------- | ----------------------------------------- |
| `task`    | single string             | `pick_and_place`, `peeling`, `assembly`   |
| `scene`   | single string             | `tabletop`, `kitchen`, `industrial_bench` |
| `objects` | string list               | `["cucumber", "knife"]`                   |
| `notes`   | free-form text (optional) | `"left arm only, gripper repurposed"`     |

Tags are stored per-dataset as plain JSON at:

```
<LOCAL_DATASET_ROOT>/<org>/<dataset>/meta/xense_tags.json
```

The `xense_` filename prefix keeps the sidecar from ever colliding with upstream LeRobot fields, and the per-dataset location means tags travel with the data when it is `rsync`-ed or moved to another machine. The file is plain UTF-8 JSON; you can also edit it by hand.

### Editing tags

Two entry points:

1. **Homepage card** — hover any dataset card, an `✎ Tags` button appears in the top-left corner. Click to open the editor modal. Useful for quick first-pass labelling across many datasets.
2. **Episode viewer** — open any episode, an `✎ Edit tags` button sits next to the dataset name (top-right of the Episodes tab). The currently-loaded tags also render as colored chips under the dataset name so you can verify what's set. Useful for refining tags while inspecting the data.

The editor offers a suggested vocabulary in dropdowns (`pick_and_place`, `peeling`, `tabletop`, `kitchen`, etc.), but you can always pick `+ Custom value…` to type a new label — values are normalized (lowercase, whitespace → `_`) on save, so `"Pick And Place"` and `"pick_and_place"` collapse into the same tag.

### Filtering by tag

When at least one dataset has a `task` tag, the homepage shows a **Task** filter row above the grid:

- `All (N)` — show everything
- `peeling (3)`, `pick_and_place (5)`, … — click to show only that task
- `Untagged (M)` — datasets without a `task` tag yet

The search box also matches against task / scene / object values, so typing `cucumber` will find any dataset whose `objects` list contains it.

### Example sidecar

```json
{
  "task": "peeling",
  "scene": "kitchen",
  "objects": ["cucumber", "knife"],
  "notes": "right-hand only, left arm parked",
  "updated_at": "2026-05-11T12:21:00.069Z"
}
```

`updated_at` is auto-stamped by the server on every save. Missing fields are treated as "unset" — an absent `xense_tags.json` is equivalent to all fields empty.

## Annotating episodes

The **Annotations** tab brings lerobot's v3.1 language schema ([lerobot#3467](https://github.com/huggingface/lerobot/pull/3467)) into the visualizer so you can author multi-modal language supervision next to the frames it describes. Each annotation is a _language atom_, split into two kinds:

| Kind           | Styles                                  | Stored in             | Behavior                             |
| -------------- | --------------------------------------- | --------------------- | ------------------------------------ |
| **Persistent** | `task_aug`, `subtask`, `plan`, `memory` | `language_persistent` | Holds across the episode (broadcast) |
| **Event**      | `interjection`, `vqa`, speech (`say`)   | `language_events`     | Fires at a specific frame timestamp  |

What the tab gives you:

- **Quick-add bar** for text atoms (subtask / plan / memory / task rephrasing / robot speech / non-spatial VQA).
- **Grounded VQA** — drag a bounding box or click a keypoint directly on any video. The gesture becomes a `Where is the X?` / `Point to the X.` Q&A pair tied to the camera you drew on.
- **Multi-track timeline** — one lane per atom kind; click to seek, drag a playhead, and drag-create / edge-resize subtask spans.
- **Inspector** — select any atom to edit its content, timestamp (snapped to the nearest source frame), or camera tag.

### How annotations are stored

Saving writes a per-dataset JSON sidecar:

```
<LOCAL_DATASET_ROOT>/<org>/<dataset>/meta/lerobot_annotations.json
```

```json
{
  "version": 2,
  "episodes": {
    "0": {
      "atoms": [
        {
          "role": "assistant",
          "content": "pick up the box",
          "style": "subtask",
          "timestamp": 1.5,
          "camera": null,
          "tool_calls": null
        }
      ]
    }
  },
  "updated_at": "2026-06-22T14:13:58.714Z"
}
```

On load, atoms are read with this precedence: **unsaved in-session edits → the JSON sidecar → atoms already embedded in the parquet** (`language_persistent` / `language_events`). A dataset that ships with the columns renders immediately; a dataset without them starts blank.

This fork is **local-only**: there is no FastAPI backend and no push-to-Hub. Writing annotations back into the dataset's `data/chunk-*/file-*.parquet` (the lerobot export path) is intentionally **not** implemented — the JSON sidecar is the source of truth, and the visualizer reads it directly. Because saving writes into the dataset's `meta/` directory, mount your dataset root **writable** (drop the `:ro` flag in the Docker examples below) if you want to persist edits.

## Homepage dashboard & Hugging Face sync

The homepage opens on a corpus dashboard: total recorded hours, a proportional
tape of where those hours come from, and one tab per source with its own
figures plus growth since the last snapshot.

Growth needs a baseline, so the homepage records a daily snapshot to
`<LOCAL_DATASET_ROOT>/.xense-viewer/corpus-history.json` (one row per day,
same-day re-renders overwrite). It is the only file the browse path writes; a
read-only root simply means no growth figures.

### Sync

Each source tab has a **Sync from Hugging Face** button. It always lists what
would be pulled before transferring anything — some orgs hold far more on the
Hub than you have locally, and the count is the only warning you get.

Requires Python with `huggingface_hub` (`pip install -r scripts/requirements.txt`)
and a token for private repos (`huggingface-cli login`).

> **Endpoint note.** Sync defaults to `HF_ENDPOINT=https://hf-mirror.com` to keep
> downloads off a metered VPN. If the mirror answers with a `308` redirect to
> `huggingface.co`, downloads fail with an explanatory message — and the mirror
> is saving you nothing anyway, because the bytes then come from the origin.
>
> That usually means a transparent proxy is capturing `hf-mirror.com` itself, so
> the mirror sees a foreign IP and bounces you to the origin. Add `hf-mirror.com`
> to the proxy's direct/bypass rules and it should serve normally.
>
> To download in the meantime:
>
> ```bash
> HF_ENDPOINT=https://huggingface.co bun dev
> ```

## Architecture notes

- Dataset files are served by an internal route `/api/local-datasets/[encodedPath]/[...filePath]` with HTTP range support for video streaming.
- The Doctor tab posts to `…/[encodedPath]/doctor`. The route loads JSON/JSONL and Parquet directly in Node/Bun with `hyparquet`, runs the checks in TypeScript, and returns a structured PASS/WARN/FAIL report. It is read-only, defaults to the full dataset in the UI, samples at most 20 physical videos for MP4 structure/track metadata, and offers 10/25/50/100/full/custom scopes. The separate dimension-level continuity check reports coordinated frame-to-frame jumps by feature name and timestamp without changing the Python-compatible aggregate action check. TCP speed detection is opt-in via the panel switch; when enabled it independently checks each `vx/vy/vz` component (default 1.5 m/s) and world-frame `ωx/ωy/ωz` component derived from the r1–r6 SO(3) rotation (default 270 deg/s); both limits are configurable.
- Dataset-level sidecars are read/written through dedicated routes: `…/[encodedPath]/tags` (`xense_tags.json`) and `…/[encodedPath]/annotations` (`lerobot_annotations.json`).
- The homepage discovers datasets via `src/lib/local-datasets-discovery.ts`.
- All cloud/HF Hub loading code (OAuth, proxy, search) has been removed.
- SO/OpenArm/G1 URDF assets load from `https://huggingface.co/buckets/lerobot/robot-urdfs/` (override with `NEXT_PUBLIC_URDF_BASE_URL`). TacCap gripper assets are bundled in this repository under `public/urdf/taccap-grippers`.

## Docker

The Dockerfile declares a `VOLUME ["/data/lerobot"]` and defaults `LOCAL_DATASET_ROOT=/data/lerobot` — mount your host LeRobot cache there:

```bash
docker build -t xense-lerobot-visualizer .

# Bind-mount the host cache (read-only is fine):
docker run -p 7860:7860 \
  -v ~/.cache/huggingface/lerobot:/data/lerobot:ro \
  xense-lerobot-visualizer

# Or point at a different host path:
docker run -p 7860:7860 \
  -v /mnt/big-disk/lerobot-data:/data/lerobot:ro \
  xense-lerobot-visualizer
```

Open <http://localhost:7860>.

If you keep datasets in several places, override the env directly:

```bash
docker run -p 7860:7860 \
  -v /srv/datasets:/srv/datasets:ro \
  -e LOCAL_DATASET_ROOT=/srv/datasets \
  xense-lerobot-visualizer
```

## Acknowledgement

This project is forked from the LeRobot dataset visualizer originally created by [@Mishig25](https://github.com/mishig25) (huggingface/lerobot PR [#1055](https://github.com/huggingface/lerobot/pull/1055)).

The Doctor checks are a TypeScript port of the diagnostic concepts from [`lerobot-doctor`](https://github.com/jashshah999/lerobot-doctor) by Jash Shah (Apache-2.0); no Python package or subprocess is used by this integration.
