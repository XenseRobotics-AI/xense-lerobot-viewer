# XenseRobotics · LeRobot Local Dataset Visualizer

A web tool by **Xense Robotics** for interactive exploration of **local** LeRobot datasets — videos, sensor signals, episode statistics, and 3D URDF replay, all served straight from the filesystem.

This fork removes the Hugging Face Hub remote-loading path; everything reads from your local LeRobot cache (`~/.cache/huggingface/lerobot` by default).

## Features

- **Local dataset browser**: the homepage lists every LeRobot dataset under your local root with a video preview and metadata badge (robot type, codebase version, episode count). Filter by name, robot type, or **dataset tags** (see below).
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

```bash
LOCAL_DATASET_ROOT=/home/xense/src/tacverse-workbench/datasets
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
and a token for private repos (`hf auth login`, or the optional HF token login
shown on the homepage). The homepage login only validates/stores the
credential; dataset transfer still starts from the source tab below.

> **Endpoint note.** Sync defaults to `HF_ENDPOINT=https://hf-mirror.com` to keep
> downloads off a metered VPN. If the mirror answers with a `308` redirect to
> `huggingface.co`, downloads fail with an explanatory message — and the mirror
> is saving you nothing anyway, because the bytes then come from the origin.
>
> That usually means a transparent proxy is capturing `hf-mirror.com` itself, so
> the mirror sees a foreign IP and bounces you to the origin. The Viewer adds
> `hf-mirror.com` (including subdomains) to `NO_PROXY`/`no_proxy` for its native
> download child only; it does not change the proxy used by the browser or other
> server requests. If a system-level transparent proxy ignores those variables,
> add `hf-mirror.com` to that proxy application's direct/bypass rules as well.
>
> To download in the meantime:
>
> ```bash
> HF_ENDPOINT=https://huggingface.co bun dev
> ```

## Workbench tab

Workbench gives a read-only operations view over the local datasets for one
organization. Open it from any local dataset episode by clicking the
**Workbench** tab, or jump straight to an organization view with a URL like:

```text
http://localhost:3000/?org=TacVerse&tab=workbench
```

The tab has three subviews:

- **Grouped statistics** rolls datasets up by uploader, task, robot type, Left
  SN, or source.
- **Dataset statistics** shows an organization-level table with local health,
  episodes, frames, recorded hours, average episode duration, and lightweight
  checks.
- **Current dataset checks** runs the per-dataset custom checks when Workbench
  is opened from a local episode.

For the Left SN OKR workflow, choose **Group by: Left SN**, set the start and
end dates, then enter the daily OKR hours and reward amount. The end date is
exclusive. OKR status uses `✅` when recorded hours are at least the target, `…`
when they are at least 90% of the target, and `❌` below 90%.

The **Workstation** column appears only while grouping by Left SN. Click
**Workstation mappings** to edit labels for the selected organization. **Import
defaults** loads the repository defaults, and **Save** writes only to your local
dataset root, not to the git-tracked defaults. Repository defaults live in
`src/config/workbench-workstation-mappings.json`; local overrides live at:

```text
<LOCAL_DATASET_ROOT>/.xense-viewer/workbench/<org>.workstation-mappings.json
```

Use **Refresh statistics** to sync lightweight metadata for Workbench views. Use
**Reload local data** to refresh local dataset discovery without editing any
dataset files.

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
