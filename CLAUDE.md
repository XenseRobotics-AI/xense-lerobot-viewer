# CLAUDE.md — XenseRobotics LeRobot Local Dataset Visualizer

## What this project is

A **local-only** LeRobot dataset visualizer (forked from huggingface/lerobot PR #1055 / @Mishig25). The Hugging Face Hub remote-loading path has been removed: every dataset is read directly from the filesystem via `/api/local-datasets/[encodedPath]/[...filePath]`. Standard robot URDF/mesh assets for the 3D replay are fetched from the public HF bucket `lerobot/robot-urdfs`; TacCap data-collection gripper assets are bundled under `public/urdf/taccap-grippers`.

**Two deliberate exceptions to "local-only"**, both added for the homepage dashboard — do not let either leak into the browse path:

1. **Manual HF sync.** The homepage's per-source Sync button — and the by-id panel beside it — download datasets from the Hub via `POST /api/local-datasets/sync` → `scripts/sync_hf_dataset.py`. They run **only** on an explicit click, always list before transferring, and are the single outbound data path. Rendering, parsing and playback never touch the network.
2. **A written history file.** The homepage records a daily snapshot to `<LOCAL_DATASET_ROOT>/.xense-viewer/corpus-history.json` so it can show growth. Writes are atomic and failure-tolerant; a read-only root just means no "since last snapshot" figures.

## Package manager

Always use **bun** (`bun install`, `bun dev`, `bun run build`, `bun test`). Never use npm or yarn.

## Post-process — run after every code change

After making any code changes, always run these commands in order and fix any errors before finishing:

```
bun run format        # auto-fix formatting (prettier)
bun run type-check    # TypeScript: app + test files
bun run lint          # ESLint (next lint)
bun test              # unit tests
```

Or run them all at once (format first, then the full validate suite):

```
bun run format && bun run validate
```

`bun run validate` runs: type-check → lint → format:check → test

## Key scripts

```
bun dev              # Next.js dev server
bun test             # Run all unit tests (bun:test)
bun run type-check   # tsc --noEmit (app) + tsc -p tsconfig.test.json --noEmit (tests)
bun run lint         # next lint
bun run validate     # type-check + lint + format:check + test
```

## Architecture

### Local dataset model

Each LeRobot dataset under `LOCAL_DATASET_ROOT` (default `${HOME}/.cache/huggingface/lerobot`) is identified by the presence of `meta/info.json`. The homepage server-side scans up to 3 levels deep via `src/lib/local-datasets-discovery.ts`, returning `LocalDatasetSummary[]` with an integrity probe (`ok` / `empty` / `incomplete`) and `sizeBytes`.

`sizeBytes` comes from `directorySizeBytes()`, a recursive walk of the dataset directory. It counts **everything on disk**, including the `.cache/huggingface` bookkeeping a Hub sync leaves behind — the figure answers "what does this cost me on disk", and `IGNORE_DIRS` only governs where datasets are _found_. Symlinks are skipped rather than followed, so a linked-in `videos/` is attributed to whoever owns the bytes instead of being double-counted. Apparent size is summed, not allocated blocks, so it reads slightly under `du` (which also charges for directory inodes). The walk is cheap enough to run inline on every homepage render — ~8 ms for 20 datasets / 4k files — so there is no cache to invalidate.

### Switching the scanned path

`LOCAL_DATASET_ROOT` is the anchor for the stores; which directory is _scanned_ can be switched at runtime from the homepage header (`src/components/dataset-path-switcher.tsx`).

- `src/lib/dataset-locations-store.ts` keeps the alternative paths at `<root>/.xense-viewer/locations.json` (atomic tmp+rename like the other stores) and exposes `resolveBrowsePath(root, requested)`, which accepts the request only when it names a listed location — a cookie is user input, so an unlisted path falls back to the root instead of scanning wherever it points.
- The selection rides in the `xense-browse-path` cookie. `src/utils/browsePath.ts` holds the cookie name and serializer because the switcher is a client component and the store imports `node:fs` (same split as `i18n/config` vs `i18n/locale-server`).
- `discoverLocalDatasets(requestedPath?)` scans that one directory and returns `{ root, browsePath, locations, datasets, errors }`. Away from the root, `encodedPath` carries the **absolute** path — `resolveServerLocalDatasetPath` already accepted those, so no file route changes — and a browsed directory that is itself a dataset is listed under its own basename.
- Routes: `GET/POST/DELETE /api/local-datasets/locations`, `GET /api/local-datasets/browse?path=` (one directory level, names only, for the picker).
- `DatasetCardGrid` takes `canDelete`; it is false away from the root, hiding both the per-card Delete and the `TrashStrip`, because `local-dataset-trash.ts` guards on the root and would refuse those datasets.

### Repo IDs and routing

Internally a local dataset is referred to by a `local:`-prefixed `repoId` (legacy wrapper, retained for minimal blast radius across `fetch-data`, `versionUtils`, sidebar, viewer). Helpers in `src/utils/datasetRoute.ts`:

- `makeLocalRepoId(path)` / `isLocalRepoId(id)` / `getLocalDatasetPath(id)`
- `encodeLocalDatasetPath(path)` (base64url) → used in URLs
- `repoIdFromRouteParams(org, dataset)` decodes `/_local/<encoded>` route params
- `routePathFromRepoId(repoId, episodeId?)` → `/_local/<encoded>/episode_N`
- `getLinkedHubDatasetRepoId` exists but is unused since the cloud path is gone.

The browser URL for episodes is `/_local/<base64url-encoded-relative-path>/episode_N`. The on-disk directory is `src/app/%5Flocal/...` because `_` is URL-encoded in directory names.

### File serving

- `src/app/api/local-datasets/route.ts` — `GET` returns the discovery JSON (datasets + integrity)
- `src/app/api/local-datasets/[encodedPath]/[...filePath]/route.ts` — streams individual files with HTTP range support for video
- `src/app/api/local-datasets/[encodedPath]/tags/route.ts` — `GET`/`PUT` the `meta/xense_tags.json` sidecar
- `src/app/api/local-datasets/[encodedPath]/annotations/route.ts` — `GET`/`PUT` the `meta/lerobot_annotations.json` sidecar (`GET ?episode=N` returns one episode's atoms; `PUT` merges one episode and atomically rewrites the file)
- `src/app/api/local-datasets/[encodedPath]/subtasks/route.ts` — `GET`/`PUT` the Pi-style `meta/annotations.json` subtask sidecar (JSONL, one record/episode; `GET ?episode=N` returns one; `PUT` merge-writes one episode, preserving other episodes + `key_frames`)
- `src/app/api/local-datasets/[encodedPath]/subtasks/export/route.ts` — `POST` spawns `scripts/export_subtasks.py` to compile the sidecar into lerobot-native `subtask_index` + `meta/subtasks.parquet`
- `src/app/api/local-datasets/[encodedPath]/parquet/route.ts` — `GET` lists every `.parquet` in the dataset (stat only); `?episode=N` also resolves that episode's data file + row range
- `src/app/api/local-datasets/[encodedPath]/parquet/read/route.ts` — `GET` reads one parquet server-side: `?meta=1` for schema only, otherwise `?offset=&limit=&col=…` for a page of rows
- `src/app/api/local-datasets/[encodedPath]/doctor/route.ts` — `POST` runs the read-only native TypeScript Doctor; no Python subprocess or external service
- `src/app/api/local-datasets/[encodedPath]/trash/route.ts` — `POST` moves one dataset into `<root>/.xense-viewer/trash/`; `src/app/api/local-datasets/trash/route.ts` — `GET` lists the trash, `DELETE` empties it

Path resolution for all of these goes through `src/lib/local-dataset-paths.ts` (`resolveDatasetRoot` / `resolveInsideDataset` / `statDatasetFile`) — the traversal check lives there, not in each route. `resolveInsideDataset` is pure and catches only **lexical** escapes (`..`, absolute segments); `statDatasetFile` additionally `realpath`s both the dataset directory and the target, so a **symlink** planted inside a dataset can't read outside it. A dataset reached through a symlinked root still works — but a deliberately out-of-tree `videos/` symlink is refused, by design.

`buildVersionedUrl(repoId, version, path)` in `src/utils/versionUtils.ts` is now local-only and **throws** for non-local repoIds.

### Dataset version support

Three versions are supported. Version is detected from `meta/info.json` → `codebase_version`.

| Version  | Path pattern                                                      | Episode metadata                           | Video                                          |
| -------- | ----------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| **v2.0** | `data/{episode_chunk:03d}/episode_{episode_index:06d}.parquet`    | None (computed from `chunks_size`)         | Full file per episode                          |
| **v2.1** | Same as v2.0                                                      | None                                       | Full file per episode                          |
| **v3.0** | `data/chunk-{N:03d}/file-{N:03d}.parquet` (via `buildV3DataPath`) | `meta/episodes/chunk-{N}/file-{N}.parquet` | Segmented (timestamps per episode, per camera) |

### Routing to parsers

`src/app/[org]/[dataset]/[episode]/fetch-data.ts` → `getEpisodeData()` dispatches to:

- `getEpisodeDataV2()` for v2.0 and v2.1
- `getEpisodeDataV3()` for v3.0

Note: `src/app/[org]/[dataset]/` no longer has `page.tsx` files — those were the cloud-route wrappers. The directory is kept because it still houses `episode-viewer.tsx`, `fetch-data.ts`, `error.tsx`, `actions.ts`, and tests. The `_local` route is the only public entry into `EpisodeViewer`.

### Deleting datasets (trash, not `rm`)

The dataset card's hover **Delete** button moves the directory to `<LOCAL_DATASET_ROOT>/.xense-viewer/trash/<stamp>__<flattened-path>/` plus a sibling `.json` manifest — a rename, never a recursive delete. Re-downloading a mistake costs tens of gigabytes over a link that measures in hundreds of kB/s; a rename costs a `mv` to undo. Nothing else in the app destroys dataset files.

- `src/lib/local-dataset-trash.ts` guards in order: inside the root lexically → is a directory → carries `meta/info.json` (so a stray encoded path cannot rename an arbitrary directory) → still inside the root after `realpath`. `EXDEV` is reported rather than silently turned into a copy.
- The scanner already skips dot-directories, so trashed datasets disappear from discovery with no extra filtering.
- Space is **not** reclaimed until the trash is emptied. `TrashStrip` (above the card grid) shows the count and bytes still on disk and is the only control that calls the destructive `emptyTrash`; it asks a second time.
- Naming lives in the pure, unit-tested `src/utils/datasetTrash.ts` — the entry name can never contain a separator, a leading dot, or `..`.

### Health probing

Episode entry pages call `probeDatasetHealth()` in `src/app/_local/[encodedPath]/[episode]/page.tsx` server-side **before** rendering `EpisodeViewer`. If `data/` or `videos/` are missing or `total_episodes === 0`, a diagnostic page is shown instead. The homepage grid mirrors the same `DatasetIntegrity` via `LocalDatasetSummary.integrity` and renders red/amber card borders + corner badges accordingly.

### v3.0 specifics

- Episode metadata row has named keys (`episode_index`, `data/chunk_index`, `data/file_index`, `dataset_from_index`, `dataset_to_index`, `videos/{key}/chunk_index`, etc.)
- Integer columns from parquet come out as **BigInt** — always use `bigIntToNumber()` from `src/utils/typeGuards.ts`
- Row-range selection: `dataset_from_index` / `dataset_to_index` allow reading only the episode's rows from a shared parquet file
- Fallback format uses numeric keys `"0"`.."9"` when column names are unavailable
- Episode metadata can span **multiple chunks** (when episode count exceeds `chunks_size`). Always walk via the `iterateEpisodeMetadataFilesV3(repoId, version)` async generator in `fetch-data.ts` — it advances chunk-000 → chunk-001 → … and stops on the first missing `file-000`. Never hardcode `chunk-000`.
- Multi-task episodes: episode-metadata rows carry a `tasks` field (`list[str]`) — prefer it over the legacy single `task_index` lookup. `EpisodeMetadataV3.tasks?: string[]` exposes it.
- `meta/tasks.parquet` lookup: rows are **not** ordered by `task_index`, and the task string lives in a named pandas index (`__index_level_0__`). Always filter by the `task_index` **column** (`row.task_index === taskIndexNum`), never by row position.
- **Language columns (v3.1)**: `loadEpisodeDataV3` always requests `language_persistent` / `language_events` in `v3DataColumns`. `hyparquet` silently ignores columns a dataset doesn't have, so this is safe for plain v3.0 datasets — `extractLanguageAtoms()` just returns `[]`. These columns are decoded as `list<struct<role,content,style,timestamp,camera,tool_calls>>`. See the Annotations section below.

### v2.x path construction

```ts
formatStringWithVars(info.data_path, {
  episode_chunk: Math.floor(episodeId / chunkSize)
    .toString()
    .padStart(3, "0"),
  episode_index: episodeId.toString().padStart(6, "0"),
});
// → "data/000/episode_000042.parquet"
```

`formatStringWithVars` strips `:03d` format specifiers — padding must be done by the caller.

### Annotations (v3.1 language schema)

The **Annotations** tab edits lerobot's v3.1 language atoms (schema: [lerobot#3467](https://github.com/huggingface/lerobot/pull/3467)). This is a **local-only port** of upstream `lerobot-dataset-visualizer#108` — the upstream FastAPI backend and push-to-Hub/parquet-export path were **dropped**. Edits persist to a JSON sidecar only.

- **Schema** (`src/types/language.types.ts`): a `LanguageAtom` is `{ role, content, style, timestamp, camera, tool_calls }`. Styles partition into **persistent** (`task_aug`/`subtask`/`plan`/`memory` → `language_persistent`, broadcast across all frames) vs **event** (`interjection`/`vqa` + speech where `style === null` → `language_events`, fired at one frame). `partitionAtoms()` / `columnForStyle()` route by style. VQA answers are JSON-stringified into `content` (`VqaBboxAnswer` / `VqaKeypointAnswer` / count / attribute / spatial). All helpers (`snapToFrame`, `activeAt`, `partitionAtoms`) are pure.
- **Read path**: `extractLanguageAtoms()` in `fetch-data.ts` coerces the parquet `language_persistent`/`language_events` lists into `LanguageAtom[]` (persistent deduped from the first non-empty row; events collected per-row with the row `timestamp` as fallback). Exposed on `EpisodeData.languageAtoms` + `EpisodeData.frameTimestamps` (sorted, from the **full non-sampled** row set, used for snap-to-frame).
- **State** (`src/context/annotations-context.tsx`): `AnnotationsProvider` holds per-episode atoms + draw state. `EpisodeBootstrap` (in `episode-viewer.tsx`) calls `setEpisode(episodeId, { repoId }, languageAtoms, frameTimestamps)`. **Hydration precedence: unsaved sessionStorage edits → JSON sidecar (`fetchEpisodeAtoms`) → parquet atoms.** sessionStorage is the live edit buffer; `save()` writes the sidecar.
- **Persistence** (`src/utils/annotationsClient.ts`): rewritten to be local — derives the route from `getLocalDatasetFileBase(repoId)` and `PUT`s to `…/[encodedPath]/annotations`. `isAnnotateBackendEnabled()` always returns `true` (local write is always available); `fetchFrameTimestamps` is a no-op stub (timestamps come from the parquet). **There is no `NEXT_PUBLIC_ANNOTATE_BACKEND_URL` and no `backend/` directory** — do not reintroduce them.
- **Sidecar** `meta/lerobot_annotations.json`: `{ version: 2, episodes: { "<id>": { atoms: [...] } }, updated_at }`. The route does read-modify-write of the whole file (preserving other episodes) with an atomic `tmp`+`rename`, mirroring the tags route.
- **UI**: `annotations-panel.tsx` (quick-add + inspector; the upstream "Save dataset"/export and "backend offline" UI were removed), `annotations-timeline.tsx` (multi-track timeline), `video-overlay-canvas.tsx` (draw bbox/keypoint on a video → VQA atom). The overlay mounts **only** where annotating happens: `SimpleVideosPlayer` takes an `annotationOverlay` prop, off by default, and only the Annotations tab passes it. It used to ride along on the Episodes tab, inert — all annotation UI now lives on the Annotations tab and nowhere else.
- **Not implemented (deferred Milestone B)**: writing atoms back into `data/chunk-*/file-*.parquet`. `hyparquet` is read-only; a local parquet write would need `hyparquet-writer` in a Node route. The JSON sidecar is the source of truth.

### Annotations tab layout (two panes, one screen)

All annotation UI lives on this tab — nothing annotation-related renders on the
Episodes tab any more. The tab is a **CSS grid**, not nested flex columns, and
the reason is `position: sticky`.

- DOM order is `[video] [hints + playback + timeline] [editor pane]`. At `lg`
  the grid puts the first two in column 1 (video in an `auto` row, the rest in a
  scrolling `minmax(0,1fr)` row) and the editor in column 2 spanning both rows,
  so both panes scroll independently and the footage never leaves the screen.
- Below `lg` it collapses to one column in that same DOM order, and the video
  sticks to the top. **The video must be a direct child of the scroller for
  that to work**: sticky is confined to its own parent's box, so a video nested
  inside a left-hand column unsticks the moment that column scrolls past — which
  is precisely when the editor below it comes into view. Nesting it "tidily"
  reintroduces the bug this layout was built to fix.
- The video wrapper is capped at `lg:max-h-[55vh]` with its own overflow: a
  dataset with several cameras wraps into rows and would otherwise take the
  whole column height and leave no room for the timeline.
- The editor pane carries **sub-tabs** (`annotationEditor` state) switching
  between `AnnotationsPanel` (v3.1 language atoms) and `SubtaskPanel` (Pi-style
  segments). One at a time, deliberately: stacking them puts the lower one back
  off screen, which is the problem again.

### Subtasks (Pi-style segmentation → lerobot-native `subtask_index`)

Separate from the atom-based language editor, but sharing the Annotations tab with it: the **Subtask panel** (`src/components/subtask-panel.tsx`) is the second of the tab's two editor sub-tabs. Type an instruction at the current frame and it starts a **contiguous frame-range segment that persists until the next subtask** — the "persist until next" model lerobot's `subtask_index` uses. This is the layer that produces the **trainable** `sample["subtask"]` (the language-atom `subtask` style does not).

- **Model** (`src/types/subtask.types.ts`): `SubtaskSegment { segment_id, skill, instruction, paraphrases[], start_frame_index, success_frame_index, end_frame_index }` inside `EpisodeSubtaskAnnotation { episode_index, high_level_instruction, instruction_segments[], key_frames? }`. Pure, unit-tested helpers (`activeSegmentAt`, `insertSubtaskAt`, `updateSegment`, `removeSegment`, `normalizeSegments`, `timeToFrame`/`frameToTime`) work in **frame-index** space and keep segments sorted, contiguous, and renumbered.
- **Authoring source of truth** — `meta/annotations.json` (**JSONL**, one Pi-style record per episode; the vendor format some datasets already ship). Read/written via `src/utils/subtasksClient.ts` → the `subtasks` route, which does per-episode merge (never clobbers other episodes / `key_frames`). Panel state uses a sessionStorage live buffer + explicit **Save**, mirroring the Annotations context. Not wired to `AnnotationsProvider` (the Pi model carries skill/paraphrases/success-frame the atom schema can't express).
- **Compile to native** — `scripts/export_subtasks.py` (pandas/pyarrow; `scripts/requirements.txt`). Writes per-frame `subtask_index` into every `data/**/*.parquet` (the earliest subtask is pinned to frame 0 so annotated episodes are fully covered; an episode with no annotation falls back to its own `task` string as one whole-episode subtask), `meta/subtasks.parquet` (mirrors `tasks.parquet`: string as `__index_level_0__` index + `subtask_index` column; indices stable across runs), and adds the `subtask_index` feature + `total_subtasks` to `meta/info.json`. Uses pyarrow (not the JS writer) so the `list<float>` `action`/`observation.state` columns round-trip exactly; rewrites are verified (row count + untouched-column equality) with a `.bak` kept. Triggered by the panel's **Export** button (dataset-wide) or run standalone from the CLI.

### Episode switching (in-page, cached, staged)

Selecting an episode in the sidebar does **not** navigate. `EpisodeViewer` keeps
one mount and swaps `EpisodeData` underneath it, which changes what "loading"
means and who is allowed to keep rendering.

- **`fetch-data.ts` holds three browser-side LRU caches** — parsed `EpisodeData`
  (`MAX_EPISODE_DATA_CACHE_ENTRIES`, 8), decoded v3 episode-metadata shards, and
  individual metadata rows — plus an in-flight map per key so overlapping
  switches share one decode. All three go through `rememberInLru` / `touchLru`
  in `src/utils/lruCache.ts`; do not hand-roll a fourth. The metadata shard
  cache stores `null` for "this shard does not exist", so it is probed with
  `has()`, never truthiness.
- **None of these caches invalidate.** `src/lib/parquet-server.ts` re-keys on
  `mtime + size`; these do not. A dataset rewritten underneath an open tab
  (`export_subtasks.py`, an HF sync) keeps serving the parsed copy until it is
  evicted. A reload is the escape hatch. Entries are **shared and must be
  treated as read-only** — mutating a cached `EpisodeData` in place corrupts
  every later reader.
- **Loading is staged, not all-or-nothing.** The full-page `Loading` layer
  guards only the _data_ transition (`episodeTransitioning`); video tiles and
  Recharts carry their own local placeholders, and charts mount in an idle
  callback after the media is ready. So "switch took 1 s" means the shell is
  interactive, not that every chart is painted — don't compare that number
  against the old all-or-nothing figure.
- **The overlay must yield to the error panel.** A failed load leaves `data` on
  the previous episode while `selectedEpisodeId` stays on the requested one, so
  `episodeTransitioning` never clears. `isLoading` therefore carries
  `&& !episodeError`; without it the z-30 spinner sits on the z-20 error panel
  forever and the user never learns why the episode did not load.
- **Retained `<video>` elements are the point.** v3 episodes commonly share one
  MP4 and differ only in `segmentStart`/`segmentEnd`, so the tile key is
  `filename:url` (no segment) and the player _seeks_ instead of reloading.
  Putting `segmentStart` back in the key throws away the browser's buffer on
  every switch. `SimpleVideosPlayer` takes `loading` and pauses the retained
  media immediately, so the previous episode can't keep playing underneath.

### Viewer keyboard shortcuts

`episode-viewer.tsx` binds `Space` (play/pause, routed to the 3D replay on that
tab), `↑`/`↓` (previous/next episode) and `←`/`→` (±5 s, 3D tab only) on
`window`. The rules live in the pure, unit-tested `src/utils/viewerShortcuts.ts`;
the viewer only reads the DOM once per keydown via `describeShortcutTarget` and
then asks two _separate_ questions, and the split matters:

- `blocksAllShortcuts` — contenteditable, `TEXTAREA`, `SELECT`, and `INPUT` **except `type=range`**. Blocks every shortcut. The scrubber is exempt because it is the thing the shortcuts drive; clicking it must not disable them.
- `yieldsSpaceShortcut` — `BUTTON`, `[role=button]` and `A[href]`. Blocks **`Space` only**. Space activates a focused button, so taking it would leave every button in the viewer un-activatable by keyboard; the arrow keys, which buttons and links don't consume, stay global — that is what keeps the shortcuts alive after clicking a sidebar episode or a 3D control.

**Episode links are the one exception to the yield, and they must stay one.**
Space does not _activate_ a native link — the browser scrolls instead. Since
selecting an episode in-page leaves its `<Link>` focused, yielding to it made
the next Space scroll the sidebar rather than toggle playback. Sidebar entries
therefore carry `data-episode-link`, and `yieldsSpaceShortcut` returns false
for anything inside one (checked before the activatable test, so a `<span>`
child of the link is covered too). Do not "simplify" that back to a bare
`A[href]` test.

Sidebar episode entries are always `<Link href>`, even on tabs that select
in-page: the click handler intercepts only unmodified left clicks, so
Cmd/middle-click and "copy link address" keep working.

### 3D pose trajectories (Episodes 3D tab + Action Insights)

Two viewers read Cartesian pose out of the flat chart rows. Both are fed by
`extractEpisodePoseTrajectories` (`src/utils/poseTrajectory3d.ts`), which finds
complete named xyz groups — `action | left_tcp.x/y/z` — plus the optional
`r1`–`r6` rotation sextet. **Numeric-only feature names are ignored on purpose**:
without semantic names there is no way to know which three dimensions form a
position.

- **Single episode** — `episode-pose-3d-viewer.tsx`, the `3D` mode of the Episodes chart. Plays a marker along the trajectory in sync with the video.
- **Whole dataset** — `spatial-trajectory-viewer.tsx` in Action Insights. One line per episode per layer, hover to identify, click to isolate.

Shared rules:

- **Dataset frame is Z-up, Three.js is Y-up.** The single mapping is `toScenePoint` in `src/utils/scene3d.ts` — `(x, y, z) -> (x, z, -y)`, which keeps the frame right-handed. `sceneBoundsFromPointArrays` and `niceGridStep` live beside it, and `AxisGuide` / `CameraFit` / `ControlsHandle` in `src/components/scene3d-guides.tsx`. These were duplicated across the two viewers; they are shared now so the mapping cannot drift. `CameraFit`'s `offset` is deliberately different per viewer (single-episode sits behind -X looking along the direction of travel; cross-episode sits on +X to read the spread side-on) — that is a parameter, not an accident.
- **`extractEpisodePoseTrajectories` is memoised per rows array** (a `WeakMap` keyed on identity). One episode load asks for it five times — gripper tracks, head track, source list, the Episodes 3D view, and the "is there anything to show" probe — and each pass is O(rows × keys) plus a full copy of every point and rotation array. **The result is shared: treat it as read-only.** Every current caller does `.filter(...)` before `.sort(...)`, which sorts the copy.
- **Cross-episode loading is capped, and the caps are the contract.** `getCrossEpisodeData` in `fetch-data.ts` loads the union of two evenly-sampled sets: `MAX_CROSS_EPISODE_SAMPLE` (120) episodes for the statistics panels, and `MAX_SPATIAL_TRAJECTORY_EPISODES` (400) for the trajectories. Do **not** replace this with "load every episode when a spatial group exists" — on v3 that means fetching and decoding every ~100 MB data parquet in the browser, and on v2 one HTTP request per episode. `MAX_SPATIAL_TRAJECTORY_POINTS` (120k) is a real upper bound: `spatialPointsPerEpisode` returns 0 rather than flooring to 2 and overshooting it, so the way to draw more is to raise the episode cap, not to remove the floor. The panel reports `{loaded} / {total} episodes shown` — keep that honest if you change the caps.

### Parquet browser (raw table view)

The **Parquet** tab (`src/components/parquet-table-panel.tsx`, last in the tab row) renders the raw contents of any parquet file in the dataset as a table — file picker on the left, paged table on the right.

- **Parsing is server-side.** hyparquet's Node entry (`hyparquet/src/node.js` → `asyncBufferFromFile`) reads straight off disk in `src/lib/parquet-server.ts`; only the requested page reaches the browser. v3 packs many episodes into one 100 MB data parquet with a **single row group**, so client-side paging would re-download and re-decode the whole group per page. Warm handles (file + footer) are LRU-cached keyed on `mtime + size`, so an `export_subtasks.py` rewrite invalidates them.
- **JSON safety** — `toJsonSafe` in `src/utils/parquetBrowser.ts` converts BigInt (→ number, or string past `MAX_SAFE_INTEGER`), typed arrays, `Date`, and byte columns (→ `{__kind:"bytes"}` summary) before the response is serialised. Lists past `MAX_LIST_ITEMS` become `{__kind:"list"}`. All display helpers (`describeCell`, `formatNumber`, `rowsToCsv`, `defaultColumnSelection`, `classifyParquetPath`) are pure and unit-tested.
- **Column projection is the perf lever** — `?col=` is passed to hyparquet's `columns`, which silently ignores names a file doesn't have. `meta/episodes/*.parquet` carries ~180 columns, so `defaultColumnSelection` opens with 16 (lerobot bookkeeping columns first, schema order preserved) and the rest are opt-in via the Columns menu.
- **Episode shortcut** — `locateEpisodeRows` dispatches on `codebase_version`. For **v3.0** it walks `meta/episodes/chunk-*/file-*.parquet` (all chunks, not just chunk-000) for the row whose `episode_index` matches, and returns `data/chunk_index` + `data/file_index` + `dataset_from_index`/`dataset_to_index`. For **v2.x** there is no such tree: the episode owns a whole parquet whose path is computed by the pure `buildV2EpisodeDataPath(info, episodeIndex)` from `info.data_path` + `chunks_size`, and the row range is the whole file (`0`–`num_rows`, read from the footer). Null when the episode's file doesn't exist. The tab opens on the current episode's own rows; the header button jumps back there.
- Read-only. Nothing here writes to a parquet — that stays with `scripts/export_subtasks.py`.

### Doctor (native TypeScript diagnostics)

The **Doctor** tab (`src/components/doctor-panel.tsx`, immediately after Action Insights) runs 13 dataset checks locally and renders the structured PASS/WARN/FAIL report. It is a TypeScript port of the read-only diagnostic concepts from `lerobot-doctor`; do not add back a Python bridge, `PYTHON_BIN`, PyAV/OpenCV, or a remote Space iframe.

- `POST /api/local-datasets/[encodedPath]/doctor` validates scope/check IDs, applies a 5-minute abort timeout, deduplicates identical in-flight work, and keeps a bounded 5-minute result cache.
- `src/lib/doctor/loader.ts` reads `info.json`, JSONL metadata, and raw Parquet values through the shared Node-side `hyparquet` handle. v2 computes per-episode paths; v3 uses episode metadata shard and global-index row ranges. The default is the first 25 episodes; directory inventory checks remain dataset-wide.
- `src/lib/doctor/checks/` holds the 13 checks. MP4 files are structurally parsed in TypeScript (`ftyp`/`moov`/`mdat`, video track, dimensions, timing/sample count); this intentionally avoids native codecs and does not claim to decode a frame. The separate dimension-level jump check supplements (but does not alter) the Python-compatible mean-z-score action check. The independent TCP speed-limit check is opt-in from the Doctor panel, uses real timestamps when valid (otherwise fps), differentiates xyz positions per axis, and derives world-frame angular velocity from r1–r6 through the shared SO(3) rotation math; its default 1.5 m/s and 270 deg/s thresholds are UI-configurable.
- The report schema lives in `src/types/doctor.types.ts`. Messages that explicitly name episode IDs feed `FlaggedEpisodesProvider` through its pure extraction helpers.
- Read-only: Doctor never runs fix/trim commands and never writes dataset files.

### Homepage dashboard (corpus tape, source tabs, HF sync)

The homepage header is a tabbed dashboard: an **All sources** tab holding the corpus tape, plus one tab per top-level source (the directory prefix / HF org) with that source's own figures, its growth since the last snapshot, and its Sync button. Tabs are per _source_, never per task — there are ~4 sources against 231 tasks, and sync is an org-level operation.

- **The tape is proportioned by recorded hours, not episode count.** An episode is an arbitrary slice; sources differ by an order of magnitude in mean episode length (see `avgEpisodeSeconds`), so episode counts are not comparable quantities and hours are. The legend deliberately shows episodes _and_ mean length beside the duration bar so the mismatch is visible.
- **Card grids are ordered largest-first**, both levels: `compareDatasetsBySize` in `src/utils/datasetGrouping.ts` sorts on `sizeBytes` desc → `total_frames` desc → `total_episodes` desc → path, and `groupDatasetsByPrefix` ranks the category cards on the same keys summed (`totalBytes` first). **Bytes lead** — "how big is this dataset" is a storage question, and frames are only a proxy for it: on the real corpus TacVerse holds the most frames (2.9M) but 13 GB, while Vertax holds 1.6M frames and 40 GB, so the two keys genuinely disagree about which card comes first. Frames stay as the second key because `sizeBytes` is 0 for a directory that could not be walked, and those must not collapse to the bottom in path order. A group's card art is the thumbnail of its largest dataset that has one.
- **Two sync targets, one route.** `POST /api/local-datasets/sync` takes either `{ source }` (a whole org) or `{ repo: "owner/name" }` (one dataset), and the client's `SyncTarget` keeps them on one code path. The by-id target exists because the per-source button can only refresh a source already on disk — a dataset the machine has never held has no tab to press. Its panel (`repo-fetch-panel.tsx`) therefore sits on the homepage **outside** `CorpusDashboard`, which renders nothing when no source exists, and opens by default in exactly that case. The owner half of the id becomes the source directory, so a successful fetch is what makes a new source tab appear.
  Its listing pass calls `dataset_info(files_metadata=True)`, so the confirmation names a size and file count rather than "1 dataset pending" — deliberately **not** done on the org path, where it would be ~188 metadata calls before anything renders. A hand-typed id that does not resolve fails the listing outright instead of being conservatively treated as work the way an unresolvable org repo is: the id came from a keyboard, so "no such dataset" is the answer, not a download attempt.
- **Storage is reported at all three levels**: `totalBytes` on the All-sources tile row, `bytes` per source (tab tile + tape legend), `sizeBytes` on each dataset card. Formatting goes through the one shared `formatBytes` in `src/utils/byteSize.ts` (binary units, read against `du`). `sync-progress.tsx` keeps a separate `formatTransferred` for live sync progress — that one is decimal on purpose, because it is read against what the Hub reports for the repo. The progress bars and the outcome line live there too, shared by both sync entry points: once bytes are moving the report is the same report. Storage is also in the daily snapshot, so the source panel shows a "since last snapshot" storage delta beside hours/episodes/tasks.
- `src/utils/corpusStats.ts` — pure aggregation, tape width allocation (tiny sources are floored to a hoverable minimum, with the borrowed width taken proportionally from the large ones so the bar still sums to 100), and the cyan→violet ramp. That ramp is deliberately not categorical: emerald/red/amber/orange all carry reserved status meanings, and a rainbow here would read as a health bar.
- `src/utils/corpusHistory.ts` — daily snapshots and deltas. Deltas compare against the **most recent earlier recorded day**, not literal yesterday, because nobody opens the page daily. Negative deltas are preserved, not clamped.
  `SourceSnapshot.bytes` is **optional and stays at `version: 1`** — a version bump would make `parseHistory` discard the whole file, trading months of real history for one added column. The absence is therefore meaningful, and `SourceDelta.bytes` is `number | null`: a baseline row with no `bytes` yields `null` ("never recorded"), never `0` and never "all of it is new", which would have reported the entire corpus as one day's growth on the first render after the upgrade. One unknown source makes `total.bytes` null rather than a partial sum, `formatDeltaBytes` renders null as `"n/a"` against `"—"` for a genuine zero, and the source panel drops the column entirely while it is unknown. `isFlatDelta` ignores a null byte delta but treats a known non-zero one as change — a re-encode moves bytes without moving any count.
- `src/lib/corpus-history-store.ts` — atomic `tmp`+`rename` write, swallows its own failures.
- **HF sync** (`scripts/sync_hf_dataset.py` + `sync/route.ts`): listing always precedes transfer. This gate is not politeness — `lerobot` is a public org with ~188 datasets against 5 held locally, and an unconfirmed sync would pull hundreds of gigabytes. One sync runs at a time, process-wide.
- **Sync is incremental, and the counter says so.** The org listing asks for `expand=["sha"]`, and a repo is skipped when the remote commit is already present as `<dataset>/.cache/huggingface/trees/<commit>.json` **and** every file that tree lists exists at the listed size. The size check is what catches a copy that was deleted, truncated, or rewritten in place — `export_subtasks.py` does exactly that to the data parquets, so a subtask-compiled dataset reads as pending and a sync will overwrite it. `pending` (not `repos`) is the work list, so the progress reads `1/M` of what actually differs rather than `1/N` of the whole org; `--force` / the panel's "Re-check all" ignores the check. Do not reintroduce a plain "iterate the whole org" loop: `snapshot_download` skips unchanged bytes, but only after a per-file metadata round trip, which is minutes of nothing across a large org.
- **`HF_ENDPOINT` defaults to `https://hf-mirror.com`** — the point is saving proxy/VPN bandwidth, not the mirror itself. Keep the default: if the mirror starts serving again, sync works with no code change.
  As of 2026-08 on the dev machine it does **not** serve. Every path (`/api/...`, `/resolve/...`, models and datasets alike) answers `308 → huggingface.co`, and `huggingface_hub` refuses that redirect because it carries no `X-Repo-Commit` (reproduced on 0.34.4 and 1.22.0, so it is not a version issue, and not Xet either — `HF_HUB_DISABLE_XET=1` changes nothing).
  The likely cause is local, not remote: `hf-mirror.com` resolves to `198.18.0.79` on that machine — a transparent-proxy fake-IP — so the mirror is reached through a foreign exit and bounces the caller to the origin. **While that holds the mirror saves no bandwidth at all**, since the bytes come from `huggingface.co` (`198.18.0.80`, also proxied) either way. The fix is a proxy bypass rule for `hf-mirror.com`, not a code change; DNS is hijacked too, so it cannot be verified from inside the box.
  `scripts/sync_hf_dataset.py` preflights one file and fails with this explanation rather than erroring once per repo. `HF_ENDPOINT=https://huggingface.co` downloads successfully today.

### Python interpreter resolution

Two routes shell out to Python — `sync/route.ts` (needs `huggingface_hub`) and `subtasks/export/route.ts` (needs `pandas` + `pyarrow`). Neither may assume `python3`: the first one on the dev server's PATH is routinely a shell venv or a bare system Python without the dependencies, and the symptom is an opaque `No module named 'huggingface_hub'` that names the org rather than the interpreter. Both go through `resolvePython(modules)` in `src/lib/python-runtime.ts`.

Resolution is ordered, and the order is the contract:

1. **`PYTHON_BIN`** — explicit config wins and is **exclusive**. If it lacks the modules, resolution fails naming it; it is never silently overridden.
2. `./.venv`, `./venv`, `$VIRTUAL_ENV`, `$CONDA_PREFIX`, then `python3` / `python` from PATH.
3. **Only if none of those satisfy the modules**, conda/mamba env directories are scanned (`CONDA_ENVS_PATH`, `MAMBA_ROOT_PREFIX`, the active env's siblings, and the usual `~/miniforge3|mambaforge|miniconda3|anaconda3|micromamba` installs) and the best match is used.

Step 3 is a fallback, not the strategy — it exists so a fresh clone works on a machine whose deps live in a conda env, without asking for setup first. It is deterministic (highest version of the first required module, then path order), it logs the interpreter it picked, and `PYTHON_BIN` overrides it. Probing uses `importlib.util.find_spec`, so heavy modules are never imported (a full scan of ~10 envs costs ~100 ms) and results are memoised for 5 minutes. When nothing on the machine qualifies, the error names both fixes (install, or set `PYTHON_BIN`) — don't downgrade it to a bare stack trace.

**The intended setup is a project-local `.venv`** — it is the first candidate after `PYTHON_BIN`, needs no configuration, and keeps the scripts' dependencies out of whatever else the machine has:

```
python3.12 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
```

`.venv/` is gitignored. Nothing needs activating: the routes address the interpreter by path, so an unactivated shell, a different conda env, or a `next dev` started from anywhere all resolve the same way.

**`PYTHONPATH` and `PYTHONHOME` are stripped from every spawn** (`pythonSpawnEnv`, applied to the probe as well so it sees what the real run sees). `PYTHONPATH` is honoured by every Python regardless of version, so a sourced ROS setup — `/opt/ros/humble/.../python3.10/site-packages`, the normal state of a robotics workstation, this one included — prepends 3.10 packages to a 3.12 venv's `sys.path`, shadowing installed modules and crashing on any 3.10-built C extension. `PYTHONHOME` overrides the interpreter's prefix and breaks a venv outright. Neither is wanted by scripts that import stdlib plus their resolved environment and nothing else; without the strip, "resolve the interpreter" would not mean "run against that interpreter's packages".

Both Python scripts also self-diagnose when run directly from the CLI: they report the missing dependency against `sys.executable` instead of letting the `ImportError` surface through an unrelated handler.

### Internationalisation (English ⇄ 简体中文)

Hand-rolled dictionary + React context. **No i18n library, no `/[locale]/` route segment** — the URL shape (`/_local/<encoded>/episode_N`) is load-bearing.

**Mechanism**

- `src/i18n/messages/en.ts` is the source of truth: flat dotted keys, `MessageKey = keyof typeof en`, and `zh.ts` typed `Record<MessageKey, string>` so tsc catches a missing or stray key. Flat avoids a recursive `Paths<T>` and keeps keys greppable.
- `_one` / `_other` pairs go through `pluralKey()` / `tp()`. Chinese always resolves to `_other`, so its `_one` entries duplicate their `_other`. Don't reintroduce `{n === 1 ? "" : "s"}`.
- `tRich` / `tpRich` (`rich.tsx`) interpolate **React nodes**, so a sentence carrying one styled fragment (mono path, amber count, coloured tag word) stays a single translatable string. Never split into `…Before` / `…After` keys — that freezes English word order, which is exactly what differs in Chinese.
- The `xense-locale` cookie holds the preference. The root layout reads it via `getServerLocale()`, so the first paint and `<html lang>` are already correct; the switcher writes the cookie **and** sets context state, so the UI flips with no `router.refresh()`. Reading it makes the layout dynamic, which costs nothing here — every page was already `force-dynamic`. The one server component that renders text (the integrity page in `_local/[encodedPath]/[episode]/page.tsx`) has no context, so it looks strings up through `MESSAGES` directly.
- Modules that aren't components (the fetch clients, `fetch-data`) throw `Error`s a panel renders verbatim. They use `tStandalone()` (`standalone.ts`), which reads that same cookie — don't add a second locale source.
- `globals.css` appends a CJK fallback chain to `body`: Inter ships no CJK glyphs, and without it every Chinese string falls back per-glyph, usually to a serif.

**Terminology** — enforced by `src/i18n/__tests__/messages.test.ts`

- The brand is **千觉机器人**, split across `brand.part1` / `brand.part2` for the two-tone wordmark. The `Xense` in a _dataset path_ is a directory, not the brand.
- **Episodes stay English** — `{n} episodes`, `{n} ep`, `Episodes`, `Per episode`. It is the word the user also reads in the URL, in `episode_index` and in `total_episodes`; a translated count would line up with none of them.
- **A unit following a number is English** — `frames`, `steps`, `rows`, `bytes`, `days`, `h`, `s`, `×`. Bare labels are nouns rather than units and stay Chinese (帧数, 任务数, 首帧).
- Fixed renderings: 过滤 for "Filtering" (never 筛选), 动作审查 for "Action Insights".

**Never translate**

- **Doctor's report body** — ~146 `pass/warn/fail()` messages, the 13 check names, and the clipboard export quoting them. Three things read that text as data: `extractDoctorEpisodeIdsFromMessage` regexes episode ids out of it, `doctor-panel.tsx` branches on `check.name`, and 24 assertions in `doctor/__tests__/checks.test.ts` match English substrings. It would also need a locale in the route's result-cache key. That is a structured-message refactor (codes + params), not a string swap.
- **API-route errors and `scripts/*.py` output** — the same server-locale plumbing as the Doctor report, so do both together or neither.
- **Anything written to disk or read back from it** — the v3.1 style tokens (`task_aug`, `subtask`, `vqa`, …), `COMMON_SKILLS`, the `src/lib/dataset-tags.ts` presets, plus dataset paths, task strings, parquet column names and joint names. The quick-add dropdown glosses the token (`subtask 子任务`) instead of replacing it, and `ann.ph.*` examples keep English sample content behind a `例：` prefix.
- `formatBytes` / `formatCompact` / `formatHours` / `formatDelta` stay pinned to `en-US`: grouping is identical in `zh-CN` and their units are English by the rule above. 万/亿 and `Intl.DateTimeFormat` dates would be a separate step — don't thread a locale through those pure, unit-tested helpers piecemeal.

**Never branch on a translated string.** `action-insights-panel` used to pick its recommendation with `verdict.label === "Smooth"`; the branch key is now a separate `kind` discriminator. Same failure mode as the Doctor message parsing above.

Every user-facing panel is translated (625 keys). To extend: add keys to both dictionaries, swap literals for `t()`, and let the messages test tell you what drifted — it asserts the set of byte-identical entries _exactly_, so both a new untranslated string and a stale exemption fail.

## Key files

| File                                                              | Purpose                                                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/i18n/messages/en.ts`                                         | Source dictionary (flat dotted keys); `MessageKey` derives from it. `zh.ts` is the typed translation                                                               |
| `src/i18n/config.ts`                                              | `Locale`, `parseLocale`, `htmlLang`, the `xense-locale` cookie contract — pure, unit-tested                                                                        |
| `src/i18n/format.ts` / `rich.tsx`                                 | `interpolate` / `pluralKey`; `richInterpolate` for React-node placeholders                                                                                         |
| `src/context/locale-context.tsx`                                  | `LocaleProvider` (mounted in the root layout) + `useLocale()` / `useT()` → `t`, `tp`, `tRich`, `tpRich`                                                            |
| `src/components/language-switcher.tsx`                            | EN / 中 toggle for the top right of each page header                                                                                                               |
| `src/lib/local-datasets-discovery.ts`                             | Server-side scanner: walks the local root, returns datasets + `DatasetIntegrity`                                                                                   |
| `src/app/page.tsx`                                                | Server component → calls `discoverLocalDatasets()` → renders `LocalDatasetGrid`                                                                                    |
| `src/app/local-dataset-grid.tsx`                                  | Client grid: filter, health filter, "Open episode N" quick-jump, card with health badge                                                                            |
| `src/app/_local/[encodedPath]/[episode]/page.tsx`                 | Server health probe + `EpisodeViewer` mount (the only live entry into the viewer)                                                                                  |
| `src/app/api/local-datasets/route.ts`                             | `GET /api/local-datasets` — discovery API for clients                                                                                                              |
| `src/app/api/local-datasets/[encodedPath]/[...filePath]/route.ts` | `GET`/`HEAD` for individual files, range-aware for video                                                                                                           |
| `src/app/api/local-datasets/[encodedPath]/annotations/route.ts`   | `GET`/`PUT` the `meta/lerobot_annotations.json` annotation sidecar                                                                                                 |
| `src/app/[org]/[dataset]/[episode]/episode-viewer.tsx`            | Tabbed viewer (Episodes / Annotations / 3D Replay / Statistics / Filtering / Frames / Action Insights / Parquet); hosts `AnnotationsProvider` + `EpisodeBootstrap` |
| `src/app/[org]/[dataset]/[episode]/fetch-data.ts`                 | Main data-loading entry point; v2/v3 parsers; `computeColumnMinMax`; `extractLanguageAtoms`                                                                        |
| `src/types/language.types.ts`                                     | v3.1 language atom schema + pure helpers (`snapToFrame`, `activeAt`, `partitionAtoms`, VQA parsing)                                                                |
| `src/context/annotations-context.tsx`                             | Per-episode annotation state; sessionStorage live buffer + sidecar hydration                                                                                       |
| `src/utils/annotationsClient.ts`                                  | Local-only persistence client → `…/[encodedPath]/annotations` route (no FastAPI backend)                                                                           |
| `src/components/annotations-panel.tsx`                            | Annotations editor: quick-add bar, atom list, inspector, "Save episode"                                                                                            |
| `src/components/annotations-timeline.tsx`                         | Multi-track atom timeline (one lane per kind, click-to-seek, drag spans)                                                                                           |
| `src/components/video-overlay-canvas.tsx`                         | Draw bbox/keypoint on a video → grounded-VQA atom; mounted only when `SimpleVideosPlayer` is given `annotationOverlay`                                             |
| `src/types/subtask.types.ts`                                      | Pi-style subtask segment schema + pure helpers (`activeSegmentAt`, `insertSubtaskAt`, `normalizeSegments`, frame↔time)                                             |
| `src/components/subtask-panel.tsx`                                | Annotations-tab subtask labeler: active-subtask banner, quick-add, segment strip, list/inspector, Save + Export                                                    |
| `src/utils/subtasksClient.ts`                                     | Client for the `…/[encodedPath]/subtasks` + `/subtasks/export` routes                                                                                              |
| `src/lib/local-dataset-paths.ts`                                  | Shared server path resolution + traversal guard for every per-dataset route                                                                                        |
| `src/lib/python-runtime.ts`                                       | `resolvePython(modules)`: PYTHON_BIN → local venv/active env → PATH → conda-env scan, memoised, with a fix-it error                                                |
| `src/lib/parquet-server.ts`                                       | Node-side hyparquet reader: LRU file handles, schema→type strings, `readParquetPage`, `locateEpisodeRows`                                                          |
| `src/lib/doctor/`                                                 | Native TypeScript Doctor loader, math helpers, MP4 structural probe, 13 checks, and report runner                                                                  |
| `src/components/doctor-panel.tsx`                                 | Doctor scope controls, report filters/download, and affected-episode flagging                                                                                      |
| `src/components/parquet-table-panel.tsx`                          | Parquet tab: file picker, column picker, paged sticky table, cell expansion, CSV export                                                                            |
| `src/utils/parquetBrowser.ts`                                     | Pure helpers: `toJsonSafe`, `describeCell`, `defaultColumnSelection`, `rowsToCsv`, file classify/sort                                                              |
| `src/utils/byteSize.ts`                                           | The one `formatBytes` (binary units), shared by the parquet file picker and the homepage storage figures                                                           |
| `src/utils/parquetBrowserClient.ts`                               | Client for the `…/[encodedPath]/parquet` + `/parquet/read` routes                                                                                                  |
| `src/components/repo-fetch-panel.tsx`                             | Homepage "download a dataset by Hugging Face id" panel — the only way to pull a source not yet on disk                                                             |
| `src/components/sync-progress.tsx`                                | Shared sync transfer/outcome views + `formatTransferred` (decimal, Hub-facing)                                                                                     |
| `scripts/export_subtasks.py`                                      | pyarrow: compile `meta/annotations.json` → per-frame `subtask_index` + `meta/subtasks.parquet` + `info.json` (backup + verify)                                     |
| `src/components/urdf-viewer.tsx`                                  | 3D viewer; loads standard URDFs from the HF bucket and bundled TacCap grippers; `autoMatchJoints` does column→joint mapping                                        |
| `src/utils/taccapGripperReplay.ts`                                | TacCap left/right TCP + opening extraction, source selection, interpolation, and normalized finger command                                                         |
| `src/utils/poseTrajectory3d.ts`                                   | Named xyz(+r1–r6) pose extraction from chart rows, memoised per rows array; sampling/interpolation; `selectTrailStartIndex` (trail window)                         |
| `src/utils/spatialTrajectories.ts`                                | Cross-episode spatial layers: axis-group discovery, point budget, `spatialLayerFeatureKey` — pure                                                                  |
| `src/utils/scene3d.ts`                                            | The one Z-up→Y-up `toScenePoint`, scene bounds, and grid stepping — shared by both 3D viewers                                                                      |
| `src/components/scene3d-guides.tsx`                               | Shared `AxisGuide` / `CameraFit` (per-viewer `offset`) / `ControlsHandle`                                                                                          |
| `src/components/spatial-trajectory-viewer.tsx`                    | Action Insights cross-episode trajectory view: layer toggles, episode legend, hover/isolate                                                                        |
| `src/components/episode-pose-3d-viewer.tsx`                       | Episodes-tab `3D` chart mode: single-episode pose path with a video-synced marker                                                                                  |
| `src/utils/urdfReplayVideos.ts`                                   | Groups replay cameras into left / top-center / right by `left`/`right`/`head` tokens — pure                                                                        |
| `src/utils/videoSegments.ts`                                      | Episode-local time ↔ the shared v3 MP4's media clock, both directions, each clamped into the segment — pure                                                        |
| `src/utils/sampling.ts`                                           | `evenlySampleIndices` / `evenlySampleArray` — unique, sorted, first-and-last-preserving downsampling                                                               |
| `src/utils/lruCache.ts`                                           | `touchLru` / `rememberInLru` — the one insertion-ordered LRU policy, shared by the three episode caches                                                            |
| `src/utils/viewerShortcuts.ts`                                    | Pure focus rules for the global viewer shortcuts (`describeShortcutTarget`, `blocksAllShortcuts`, `yieldsSpaceShortcut`)                                           |
| `src/utils/versionUtils.ts`                                       | `getDatasetInfo`, `getDatasetVersionAndInfo`, `buildVersionedUrl` (local-only)                                                                                     |
| `src/utils/datasetRoute.ts`                                       | `local:` repoId wrapper, base64url encode, route ↔ repoId conversion                                                                                               |
| `src/utils/stringFormatting.ts`                                   | `buildV3DataPath`, `buildV3VideoPath`, `buildV3EpisodesMetadataPath`, padding helpers                                                                              |
| `src/utils/parquetUtils.ts`                                       | `fetchParquetFile`, `readParquetAsObjects`, `formatStringWithVars`                                                                                                 |
| `src/utils/dataProcessing.ts`                                     | Chart grouping pipeline: `buildSuffixGroupsMap` → `computeGroupStats` → `groupByScale` → `flattenScaleGroups` → `processChartDataGroups`                           |
| `src/utils/typeGuards.ts`                                         | `bigIntToNumber`, `isNumeric`, `isValidTaskIndex`, etc.                                                                                                            |
| `src/utils/constants.ts`                                          | `PADDING`, `EXCLUDED_COLUMNS`, `CHART_CONFIG`, `THRESHOLDS`                                                                                                        |

## Time context: state vs controls

`src/context/time-context.tsx` exposes **two** contexts, and the split is a
performance contract. `TimeStateContext` (`currentTime`, `externalSeekVersion`,
`isPlaying`, `duration`) changes on every throttled tick (~12.5/s during
playback); `TimeControlsContext` (`seek`, `subscribe`, `setIsPlaying`,
`setDuration`) is memoised and effectively never changes.

- A component that only issues commands must use `useTimeControls()`. Reaching
  for `useTime()` there re-subscribes it to the clock and puts it back in the
  playback render path — which is what made a Recharts tree of thousands of SVG
  nodes rebuild 12.5 times a second.
- `useTime()` survives as a compatibility wrapper that spreads both. It is fine
  for components that genuinely need `currentTime` _and_ `seek`
  (`playback-bar`, `annotations-timeline`, `subtask-panel`), and wrong anywhere
  else.
- The chart playhead follows the same rule structurally: `SingleDataGraph` is
  not subscribed to time at all. `GraphPlayhead` is a tiny leaf that reads the
  clock and moves one absolutely-positioned `<div>`. Its inset is derived from
  `CHART_MARGIN` / `CHART_Y_AXIS_WIDTH` / `CHART_X_AXIS_HEIGHT`, the same
  constants passed to `<LineChart>` and the axes — Recharts computes its plot
  box as `margin + axis size`, so hardcoding the offset silently misaligns the
  playhead from the data the moment a margin changes.

## Chart data pipeline

Series keys use `" | "` as delimiter (e.g. `observation.state | 0`).
`groupRowBySuffix` groups by **suffix**: if two different prefixes share suffix `"0"` (e.g. `observation.state | 0` and `action | 0`), they are merged under `result["0"] = { "observation.state": ..., "action": ... }`. A series with a unique suffix stays flat with its full original key.

## Testing

- Test files live in `**/__tests__/` directories alongside source
- Uses `bun:test` (built-in, no extra install)
- BigInt literals (`42n`) require `tsconfig.test.json` (target ES2020) — test files are excluded from `tsconfig.json`
- `@types/bun` is installed as a devDependency for `bun:test` type resolution
- Mocking fetch: `globalThis.fetch = mock(() => Promise.resolve(new Response(...))) as unknown as typeof fetch`
- All `getDatasetVersionAndInfo` / `buildVersionedUrl` tests must call with a `makeLocalRepoId(...)` repoId — bare strings will throw "Only local datasets are supported"
- CI: `.github/workflows/test.yml` runs `bun test` on push/PR to main

## Local dataset path resolution

Server resolution order (in `resolveLocalDatasetRoot` and `resolveServerLocalDatasetPath`):

1. `LOCAL_DATASET_ROOT` env (server-only)
2. `NEXT_PUBLIC_LOCAL_DATASET_ROOT` env (server- or client-readable)
3. `${HOME}/.cache/huggingface/lerobot` fallback

Inside a dataset, files are addressed by `/api/local-datasets/<base64url(relative_path)>/<file/path>`.

## Excluded columns (not shown in charts)

Reserved/bookkeeping columns from lerobot — see `EXCLUDED_COLUMNS` in `src/utils/constants.ts`:

- v2.x: `timestamp`, `frame_index`, `episode_index`, `index`, `task_index`, `next.reward`, `next.done`, `next.truncated`
- v3.0: `index`, `task_index`, `episode_index`, `frame_index`, `next.reward`, `next.done`, `next.truncated`, `subtask_index`

## 3D URDF viewer (`src/components/urdf-viewer.tsx`)

- URDFs and meshes are hosted in the HF bucket `lerobot/robot-urdfs` — base URL `https://huggingface.co/buckets/lerobot/robot-urdfs/resolve` (no `/main` segment; buckets are unbranched). Override with `NEXT_PUBLIC_URDF_BASE_URL` for local development.
- Asset layout under the bucket: `g1/`, `openarm/`, `so101/` (both SO-100 and SO-101 live here).
- TacCap is the exception: `bi_taccap_gripper` loads the project-local left/right assets from `public/urdf/taccap-grippers`. Recorded `left_tcp` / `right_tcp` poses are read as canonical TCP, full stop. The viewport used to carry a `Already TCP` / `Tracker → TCP` switch that re-derived them through measured extrinsics; it was removed as an unused control that read as leftover debug UI. `extractTacCapGripperTracks` still takes an optional `TacCapPoseProfile` and `taccapPoseSemantics` still holds the measured side-specific transforms and their tests, so the capability is one caller away — but **episode extrinsics metadata is no longer read**, and a dataset recording tracker-frame poses would now render uncorrected. Do not infer this rigid-frame semantic from trajectory smoothness alone. Recover the model root from the measured `base_link -> link4` translation; both bundled URDFs define link4 with the same canonical X/Y orientation. The left link4 STL's SolidWorks `-90°` Z correction belongs on its `<visual>` origin, never on `joint4`, so it cannot rotate the TCP frame. Drive `joint1` from `0` to `28.92°` (`0.5047492196767601 rad`); `joint2` mimics it with multiplier `-1`. Prefer `action`, with `observation.state` available as a source toggle. If the selected source contains a complete `head.xyz+r1-r6` group, render its yellow trajectory, playback point, and local axes; video keys containing `head` alone are not pose data.
- `getRobotConfig` defaults to **`so101_new_calib.urdf`** for any `robot_type` that doesn't match G1/OpenArm. The legacy `so100.urdf` is only used when `robot_type` is literally `so100` / `so_100` / contains `so100_arm`. **This means `so100_follower` (lerobot 0.4+ catch-all term) goes through SO-101.**
- `autoMatchJoints` tolerates `.pos` / `.position` / `.q` suffixes on column names, so SO-101 features like `shoulder_pan.pos` auto-match the URDF joint `shoulder_pan`.
- **Replay advances rows, not frames.** `chartData` is the _downsampled_ row set (`MAX_EPISODE_POINTS`), so one row is not one 1/fps frame — a 6000-frame 30 fps episode arrives as 4000 rows spanning the same 200 s. `rowsPerSecond` is derived from the first and last real timestamps (falling back to `fps` only when they are unusable) and drives `PlaybackDriver`, the playback-bar clock, the seek fallbacks and `replayTimeSeconds` alike. Don't reintroduce a bare `fps` divisor: it runs playback ~1.5x fast and drags `UrdfVideoOverlay`, which seeks each MP4 from that value, along with it.
- **A warm STL cache still has to be announced.** `loadCachedStlGeometry` calls `manager.itemStart(url)` on a cache or in-flight hit and defers `itemEnd` by a macrotask. Without it, a remount with everything cached leaves the LoadingManager tracking only the `.urdf`, so `manager.onLoad` — and `reportReady()` — fire over an empty scene. Same ordering hazard as the STLLoader note below.
- **The trail window is a time window with a size floor, and the floor is measured as a bounding box.** A fixed `TACCAP_TRAIL_DURATION` alone is unreadable on real data: on `TacVerse/taccap-g1-fold-garment-0819` ep0 the distance covered in 3 s ranges from 0.75 cm to 28 cm against a 45 cm scene — 38x — so the same three seconds is a legible arc or a dot depending only on where you paused, and landing at frame 0 (2.6 cm) looks like a single point. `selectTrailStartIndex` in `poseTrajectory3d.ts` therefore walks back from the head until it has both `TACCAP_TRAIL_DURATION` of history **and** `TACCAP_TRAIL_MIN_SPAN_FRACTION` of the scene extent across, capped at `TACCAP_TRAIL_MAX_DURATION` so a stationary gripper cannot drag in the whole episode. The colour ramp spans the window actually drawn, not the nominal 3 s, or a stretched window would bottom out early and read as truncated.
  The floor is the **bounding-box diagonal, never accumulated path length**. Arc length is inflated by jitter — at t=40 s in that episode a gripper holding position racks up 5.4 cm of path while occupying 2.9 cm of screen, so an arc-length test declares the floor met and stops on exactly the case the floor exists to catch. There is a unit test for this (`poseTrailWindow.test.ts`); don't "simplify" it back to a running sum.
  Frame 0 is still a single point, and no floor can change that: there is no history behind it yet.
- **The trail geometry is allocated at a capacity and refilled; never resized per frame.** `WebGLRenderer` latches an instanced geometry's draw count the first time it draws it — `if (geometry._maxInstanceCount === undefined) geometry._maxInstanceCount = data.meshPerAttribute * data.count`, then every draw uses `Math.min(geometry.instanceCount, maxInstanceCount)` — and only `dispose()` clears it. The trail's geometry was created on the first frame that had two points to draw, so the latch froze at **one segment** and stayed there: `setPositions` kept raising `instanceCount` to 90, 178, … and the renderer kept drawing one. The surviving segment is the oldest pair in the window, so the trail collapsed to a dot that followed the gripper a whole window behind — the "single lagging point" bug. Sizing in `TRAIL_CAPACITY_STEP` blocks and writing through the interleaved buffers keeps the latch at the capacity. Do not go back to calling `setPositions` per frame: besides re-arming this bug, it allocates a fresh `InstancedInterleavedBuffer` every call, so it was never the in-place update its old comment claimed.
  `computeLineDistances()` is deliberately absent — it feeds the dash shader, which is compiled out while `dashed` is false, and it allocates two arrays per call.
- **`TacCapPoseTrail` reuses its buffers.** Scratch `Float32Array`s are grown on demand and sliced per frame, and the `LineGeometry` is replaced only on the first build (Line2 compiles its vertex-colour shader from the attributes present then — the code detects this by checking for `instanceColorStart`, so it self-corrects if the resources are rebuilt). This effect runs once per frame per track; allocating there was the scene's largest source of GC pressure.
- **`isTacCapRobot` is the single TacCap predicate** — `getRobotConfig` calls it rather than matching its own substring. Two matchers that disagree hide the 3D tab for a robot type the config still handles, or hand back an empty `urdfUrl` to a robot mounted through another branch.
- **URDFLoader gotcha**: after our `loadMeshCb` returns, `URDFLoader.js` does `if (obj instanceof THREE.Mesh) obj.material = <urdf-material>`, overwriting any material we set. Workaround: wrap the loaded mesh in a `THREE.Group` so the `instanceof Mesh` check fails. DAE returns a Group already; STL must be wrapped explicitly.
- **STLLoader event ordering**: `manager.itemEnd(url)` fires _before_ the user `onLoad` callback, so `manager.onLoad` can fire before meshes are attached to the robot tree. Defer post-load work (auto-fit camera, shadow flags) with `setTimeout(..., 0)`. Don't try to rebuild materials in `manager.onLoad` — pick the archetype color directly inside `loadMeshCb`.
- **Strict-mode double-mount in dev**: `URDFLoader.load` is async; if React tears down the first effect run before the load completes, the abandoned robot would otherwise be `scene.add`-ed and stay parked at its rest pose. The RobotScene effect uses a `cancelled` flag + `mountedRobot` local to ignore late callbacks and remove the right robot on cleanup. Don't strip these without preserving the behavior.
- **OpenArm DAE files ship 23 stray `PointLight`s** that drown out scene lighting. Strip non-`AmbientLight` lights from `collada.scene` before adding it to the robot.
- Scene setup: `<Canvas shadows>` with `ACESFilmicToneMapping` (exposure 0.9), local 3-point directional + ambient lights, and `<color attach="background" args={["#1a2433"]} />`. Do not add a Drei environment preset without bundling its HDRI locally: presets fetch external assets and can crash intranet/offline replay. `<OrbitControls makeDefault />` is required so `useThree().controls` exposes the controls for auto-fit.

## Design system

CSS tokens in `src/app/globals.css` (Tailwind v4 `@theme inline`):

- Surfaces: `--bg #0a0e17`, `--surface-0`, `--surface-1`, `--surface-2`
- Text: `--text-primary`, `--text-muted`, `--text-faint`
- Accent: `--accent #38bdf8` (cyan) — primary interactive color across UI
- Helpers: `.panel`, `.panel-raised`, `.tabular` (tabular-nums)
- **Color semantics**: cyan = primary/active brand; emerald = healthy state; red = incomplete dataset; amber = empty dataset / soft warning; orange (`orange-400/500`) is reserved for **flagged-episode** UI only — don't reuse it for generic accents.
