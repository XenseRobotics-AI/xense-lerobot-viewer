/**
 * Source dictionary. Flat, dotted keys — `keyof typeof en` is the key type, so
 * translations are checked by tsc without any recursive path-type machinery,
 * and a key is greppable as a whole string.
 *
 * `_one` / `_other` pairs are picked by `pluralKey()`. Chinese has no plural and
 * always takes `_other`.
 *
 * Do NOT put here: strings that come from the dataset (paths, task text, parquet
 * column names), the Doctor's server-generated messages (their episode ids are
 * parsed back out of the English text), or the preset skill/tag vocabularies
 * (those are written into dataset files).
 */
export const en = {
  // ── app shell ───────────────────────────────────────────────────────────
  // The wordmark is rendered as two differently-coloured halves, so the brand
  // is split rather than kept whole. Note this is the *company* name — the
  // `Xense` that appears in dataset paths is a directory and never translated.
  "brand.part1": "Xense",
  "brand.part2": "Robotics",
  "app.title": "XenseRobotics · LeRobot Dataset Visualizer",
  "app.description":
    "XenseRobotics local LeRobot dataset visualizer — episode videos, telemetry charts, and 3D URDF replay.",

  // ── language switcher ───────────────────────────────────────────────────
  "lang.label": "Language",
  "lang.en": "EN",
  "lang.zh": "中",
  "lang.switchToEn": "Switch to English",
  "lang.switchToZh": "切换到中文",

  // ── shared vocabulary ───────────────────────────────────────────────────
  "common.episodes": "Episodes",
  "common.frames": "Frames",
  "common.tasks": "Tasks",
  "common.hours": "Hours",
  "common.storage": "Storage",
  "common.healthy": "healthy",
  "common.incomplete": "incomplete",
  "common.empty": "empty",
  "common.cancel": "Cancel",
  "common.copy": "Copy",
  "common.clear": "Clear",
  "common.prev": "Prev",
  "common.next": "Next",
  // Compact chip under a thumbnail / beside a bar. Same in both languages.
  "common.epShort": "ep {index}",
  "common.flagEpisode": "Flag episode",
  "common.unflagEpisode": "Unflag episode",
  "common.flagForReview": "Flag for review",

  // ── homepage: category landing ──────────────────────────────────────────
  "home.subtitle": "LeRobot Local Dataset Visualizer",
  "home.browsing": "Browsing {root}",
  "home.filterPlaceholder": "Filter datasets by name",
  "home.scanErrors_one": "{count} path could not be scanned:",
  "home.scanErrors_other": "{count} paths could not be scanned:",
  "home.emptyTitle": "No LeRobot tasks found under {root}.",
  "home.emptyHint": "Make sure each task directory contains {file}.",
  "home.noMatch": "No datasets match the current filter.",
  "home.taskCount_one": "{count} task",
  "home.taskCount_other": "{count} tasks",
  "home.groupTitle": "{prefix} — {tasks}",
  "home.groupEpisodes": "{value} episodes",
  "home.groupFrames": "{value} frames",
  "home.groupHealthy": "{count} healthy",
  "home.groupIssues_one": "{count} issue",
  "home.groupIssues_other": "{count} issues",

  // ── homepage: dataset card grid (level 2) ───────────────────────────────
  "grid.back": "Datasets",
  "grid.browsingLine_one": "Browsing {root} · {count} task in this dataset",
  "grid.browsingLine_other": "Browsing {root} · {count} tasks in this dataset",
  "grid.healthyCount": "{count} healthy",
  "grid.incompleteCount": "{count} incomplete (missing data/videos)",
  "grid.emptyCount": "{count} empty (0 episodes)",
  "grid.tagHint":
    "Tag your tasks to organise by {task}, {scene} and {objects}. Click the {button} button on any card to start.",
  "grid.wordTask": "task",
  "grid.wordScene": "scene",
  "grid.wordObjects": "objects",
  "grid.wordObject": "object",
  "grid.taskFilterLabel": "Task",
  "grid.filterAll": "All ({count})",
  "grid.filterUntagged": "Untagged ({count})",
  "grid.filterHealthy": "Healthy ({count})",
  "grid.filterIssues": "Issues ({count})",
  "grid.filterPlaceholder": "Filter tasks by name or robot type",
  "grid.allRobots": "All robots ({count})",
  "grid.noMatch": "No tasks match the current filter.",
  "grid.sourceLabel": "Source",
  "grid.sourceAll": "All",
  "grid.dateLabel": "Capture date",
  "grid.dateAll": "All",
  "grid.dateRange": "Range",
  "grid.dateUnknown": "No date ({count})",
  "grid.dateFrom": "Start date",
  "grid.dateTo": "End date",
  "grid.dateClear": "Clear",
  "grid.datePresetCutoff": "From {date}",
  "grid.datePresetCutoffHint":
    "First-release rule: captured on or after {date}",
  "grid.anomalyOnly": "Odd shape only ({count})",
  "grid.shapeBadge": "{dim}-dim + {streams} streams",
  "grid.bucketMerged": "merged",
  "grid.bucketRaw": "raw",
  "grid.bucketFailed": "failed",
  "grid.bucketReleased": "released",
  "grid.bucketInProcessing": "in-processing",
  "grid.healthOk": "Healthy",
  "grid.healthEmpty": "Empty",
  "grid.healthIncomplete": "Incomplete",
  "grid.healthOkReason": "data/ and videos/ present",
  "grid.healthEmptyReason": "info.json reports 0 episodes",
  "grid.healthIncompleteReason": "Missing on disk: {missing}",
  "grid.healthMissingFallback": "data files",
  "grid.editTagsTitle": "Edit tags (task, scene, objects)",
  "grid.editTagsAria": "Edit tags for {path}",
  "grid.tagsButton": "Tags",
  "grid.deleteTitle": "Delete this dataset (moves it to the trash)",
  "grid.deleteAria": "Delete {path}",
  "grid.deleteButton": "Delete",
  "grid.epCount": "{count} ep",
  "grid.framesSuffix": "{value} frames",
  "grid.bytesOnDisk": "{bytes} bytes on disk",
  "grid.open": "Open",

  // ── homepage: corpus dashboard ──────────────────────────────────────────
  "dash.allSources": "All sources",
  "dash.aria": "Corpus dashboard",
  "dash.tablistAria": "Data source",

  // ── homepage: corpus tape ───────────────────────────────────────────────
  "tape.aria": "Corpus summary",
  "tape.recorded": "Recorded",
  "tape.sources": "Sources",
  "tape.bandTitle": "{prefix} — {hours} h of {total}",
  "tape.bandAria":
    "{prefix}: {hours} hours, {episodes} episodes, {tasks} tasks, {bytes} on disk",
  "tape.epSuffix": "{value} ep",
  "tape.perEp": "{value}/ep",
  "tape.activeSummary":
    "{prefix} · {tasks} tasks · {percent}% of recorded time",
  "tape.hint": "Select a band to open that source",

  // ── homepage: source panel (growth + Hugging Face sync) ─────────────────
  "source.noSnapshot":
    "No earlier snapshot yet — growth appears the next day this page is opened.",
  "source.unchanged": "Unchanged since {since}.",
  "source.unchangedSpan": "Unchanged since {since} ({days} days ago).",
  "source.since": "Since {since} · 1 day",
  "source.sinceDays": "Since {since} · {days} days",
  "source.collectedSince": "Collected since last snapshot",
  "source.perEpisode": "Per episode",
  "source.share": "Share",
  "source.needAttention": "need attention",
  "source.browseTasks": "Browse {count} tasks",
  "source.syncButton": "Sync from Hugging Face",
  "source.syncHint":
    "Downloads {source} through hf-mirror. Shows what it would pull first.",
  "source.checking": "Checking the Hub for {source}…",
  "source.noneFound": "No datasets found on the Hub.",
  "source.allCurrent":
    "All {total} datasets for {source} are already at the latest commit locally.",
  "source.pending": "{pending} of {total} datasets for {source} need updating.",
  "source.othersMatch": "The other {current} already match.",
  "source.transferNote":
    "Transfers the full contents of each, including video.",
  "source.via": "Via {endpoint}.",
  "source.download_one": "Download {count} dataset",
  "source.download_other": "Download {count} datasets",
  "source.recheckAll": "Re-check all {total}",
  "source.recheckTitle":
    "Ignore the local commit check and fetch every dataset again",
  "source.phaseListing": "Preparing…",
  "source.phasePreflight": "Checking the endpoint…",
  "source.phaseDownloading": "Downloading {repo}",
  "source.phaseFailed": "Skipped {repo}",
  "source.phaseComplete": "Finishing…",
  "source.progressAria": "Overall sync progress",
  "source.repoProgressAria": "Current dataset progress",
  "source.filesDetail": "{done}/{total} files",
  "source.leavingNote": "Leaving this page does not stop the transfer.",
  "source.upToDate": "Already up to date — nothing to transfer.",
  "source.downloaded_one": "Downloaded {count} dataset",
  "source.downloaded_other": "Downloaded {count} datasets",
  "source.alreadyCurrent": "· {count} already current",
  "source.failedCount": "· {count} failed",
  "source.reloadNote": "Reload the page to pick up the new datasets.",

  // ââ homepage: fetch one dataset by repo id ââââââââââââââââââââââââââââââ
  "repofetch.title": "Download a dataset by Hugging Face id",
  "repofetch.hint":
    "The per-source Sync button only refreshes sources already on disk. Use this to pull a dataset this machine has never held.",
  "repofetch.placeholder": "owner/dataset-name",
  "repofetch.inputAria": "Hugging Face dataset id",
  "repofetch.check": "Check",
  "repofetch.checking": "Checking {repo} on the Hub…",
  "repofetch.invalid":
    "An id looks like owner/dataset-name — one slash, no spaces.",
  "repofetch.target": "Will be saved as {path} under the dataset root.",
  "repofetch.size": "{size} across {files} files.",
  "repofetch.sizeUnknown": "The Hub did not report a size for this dataset.",
  "repofetch.pendingLine": "{repo} is ready to download.",
  "repofetch.alreadyLocal": "{repo} is already here at the latest commit.",
  "repofetch.download": "Download",
  "repofetch.downloadSized": "Download {size}",
  "repofetch.redownload": "Download it again",
  "repofetch.redownloadTitle":
    "Ignore the local commit check and fetch the dataset again",
  "repofetch.another": "Download another",

  // ── homepage: trash ─────────────────────────────────────────────────────
  "trash.dialogTitle": "Delete dataset",
  "trash.moveBody": "Moves the whole directory into {path}.",
  "trash.moveBodyEpisodes_one":
    "Moves the whole directory — {count} episode, including video — into {path}.",
  "trash.moveBodyEpisodes_other":
    "Moves the whole directory — {count} episodes, including video — into {path}.",
  "trash.reversible":
    "Reversible: move the directory back out of the trash to restore it. The disk space is only freed once you empty the trash.",
  "trash.moving": "Moving…",
  "trash.moveToTrash": "Move to trash",
  "trash.strip_one": "Trash: {count} dataset · {bytes} still on disk",
  "trash.strip_other": "Trash: {count} datasets · {bytes} still on disk",
  "trash.confirmPrompt": "Delete permanently?",
  "trash.deleting": "Deleting…",
  "trash.yesEmpty": "Yes, empty it",
  "trash.keep": "Keep",
  "trash.empty": "Empty trash",

  // ── homepage: tags editor ───────────────────────────────────────────────
  "tags.title": "Edit tags",
  "tags.task": "Task",
  "tags.scene": "Scene",
  "tags.objects": "Objects ({count}/{max})",
  "tags.notes": "Notes ({count}/{max})",
  "tags.none": "(none)",
  "tags.custom": "+ Custom value…",
  "tags.customTask": "custom task name",
  "tags.customScene": "custom scene name",
  "tags.noObjects": "No objects yet",
  "tags.objectPlaceholder": "type and press Enter (e.g. cucumber)",
  "tags.add": "Add",
  "tags.removeAria": "Remove {value}",
  "tags.notesPlaceholder": "optional free-form notes",
  "tags.maxObjects": "At most {max} objects per dataset.",
  "tags.saving": "Saving…",
  "tags.save": "Save",

  // ── episode viewer: top tab bar ─────────────────────────────────────────
  "viewer.brandTitle": "Xense Robotics · back to dataset browser",
  "viewer.tab.episodes": "Episodes",
  "viewer.tab.annotations": "Annotations",
  "viewer.tab.annotationsTitle":
    "Edit subtask / plan / memory / interjection / VQA atoms (lerobot v3.1 schema)",
  "viewer.tab.urdf": "3D Replay",
  "viewer.tab.statistics": "Statistics",
  "viewer.tab.filtering": "Filtering",
  "viewer.tab.frames": "Frames",
  "viewer.tab.insights": "Action Insights",
  "viewer.tab.doctor": "Doctor",
  "viewer.tab.doctorTitle":
    "Run read-only TypeScript dataset quality diagnostics",
  "viewer.tab.parquet": "Parquet",
  "viewer.tab.parquetTitle":
    "Browse the raw contents of any parquet file in this dataset",
  "viewer.home": "Home",

  // ── episode viewer: body ────────────────────────────────────────────────
  "ep.episodeLabel": "Episode · {id}",
  "ep.editTags": "Edit tags",
  "ep.languageInstruction": "Language Instruction",
  "ep.groundedVqa": "Grounded VQA",
  "ep.vqaHint1":
    "Draw directly on the active video to create visual questions. Drag for a bounding box, click for a point. The camera is detected from the video you draw on.",
  "ep.vqaHint2":
    "Drag on any video to add a bbox question. Click any video to add a keypoint question. Confirm the popup with {enter}, or cancel with {esc}.",

  // ── episode viewer: sidebar ─────────────────────────────────────────────
  "nav.aria": "Sidebar navigation",
  "nav.episodeList": "Episodes",
  "nav.flagged": "Flagged · {count}",
  // Matches the URL (`episode_12`) the user can see, so it stays English.
  "nav.episodeItem": "Episode {index}",
  "nav.flag": "Flag",
  "nav.unflag": "Unflag",
  "nav.toggle": "Toggle sidebar",

  // ── episode viewer: player ──────────────────────────────────────────────
  "player.back5": "Jump backward 5 seconds",
  "player.forward5": "Jump forward 5 seconds",
  "player.play": "Play. Toggle with Space",
  "player.pause": "Pause. Toggle with Space",
  "player.rewind": "Rewind from start",
  "player.seekAria": "Seek video",
  "player.hintSpace": "pause/unpause",
  "player.hintArrows": "prev/next episode",
  "player.showHidden": "Show hidden · {count}",
  "player.restoreHidden": "Restore hidden videos",
  "player.enlarge": "Enlarge",
  "player.minimize": "Minimize",
  "player.hide": "Hide video",
  "player.noVideoTag": "Your browser does not support the video tag.",

  // ── loading ─────────────────────────────────────────────────────────────
  "loading.title": "Loading",
  "loading.subtitle": "preparing data & videos",

  // ── Frames tab ──────────────────────────────────────────────────────────
  "frames.intro":
    "Use first/last frame views to spot episodes with bad end states or other anomalies. Hover over a thumbnail and click the flag icon to mark episodes with wrong outcomes for review.",
  "frames.loading": "Loading episode frames…",
  "frames.noFlagged": "No flagged episodes to show.",
  "frames.noFrames": "No episode frames available.",
  "frames.showAll": "Show all episodes",
  "frames.flaggedOnly": "Flagged only ({count})",
  "frames.firstFrame": "First Frame",
  "frames.lastFrame": "Last Frame",
  "frames.toggleAria": "Toggle first/last frame",

  // ── Statistics tab ──────────────────────────────────────────────────────
  "stats.title": "Dataset Statistics:",
  "stats.robotType": "Robot Type",
  "stats.unknown": "unknown",
  "stats.datasetVersion": "Dataset Version",
  "stats.totalFrames": "Total Frames",
  "stats.totalEpisodes": "Total Episodes",
  "stats.totalTime": "Total Recording Time",
  "stats.cameraResolutions": "Camera Resolutions",
  "stats.computing": "Computing episode statistics…",
  "stats.episodeLengths": "Episode Lengths",
  "stats.shortest": "Shortest",
  "stats.longest": "Longest",
  "stats.mean": "Mean",
  "stats.median": "Median",
  "stats.std": "Std Dev",
  "stats.distribution": "Episode Length Distribution",
  "stats.bins_one": "{count} bin",
  "stats.bins_other": "{count} bins",
  "stats.histogramAria": "Episode length distribution histogram",
  "stats.binLabelCount_one": "{label}: {count} episode",
  "stats.binLabelCount_other": "{label}: {count} episodes",
  "stats.episodeCount_one": "{count} episode",
  "stats.episodeCount_other": "{count} episodes",
  "stats.binIndices": "Episode indices: {indices}",
  "stats.binMore": ", … (+{count} more)",
  "stats.copyIds": "Copy IDs",
  "stats.copiedIds": "Copied IDs",
  "stats.copyIdsTitle": "Copy episode IDs: {ids}",
  "stats.copyIdsAria": "Copy {label} episode IDs",
  "stats.episodeIndices": "Episode indices",
  "stats.none": "None",
  "stats.hint":
    "Hover, click, or focus a bar to inspect the episodes in that range.",

  // ── Filtering tab ───────────────────────────────────────────────────────
  "filter.title": "Filtering",
  "filter.desc":
    "Identify and flag problematic episodes for removal. Flagged episodes appear in the sidebar and can be exported as a CLI command.",
  "filter.flagAll": "Flag all",
  "filter.lowMovementTitle": "Lowest-Movement Episodes",
  "filter.lowMovementDesc":
    "Episodes with the lowest average action change per frame. Very low values may indicate the robot was standing still or the episode was recorded incorrectly.",
  "filter.lengthTitle": "Episode Length Filter",
  "filter.outsideRange_one": "{count} episode outside range",
  "filter.outsideRange_other": "{count} episodes outside range",
  "filter.flagOutside": "Flag {count} outside range",
  "filter.flaggedTitle": "Flagged Episodes",
  "filter.copyIdsTitle": "Copy IDs",
  "filter.viewFlagged": "View flagged episodes",
  "filter.cliIntro": "{link} — delete flagged episodes:",
  "filter.cliComment1": "Delete episodes (modifies original dataset)",
  "filter.cliComment2":
    "Delete episodes and save to a new dataset (preserves original)",
  "filter.loadingCross": "Loading cross-episode data…",

  // ── Subtask panel (Episodes tab) ────────────────────────────────────────
  "subtask.title": "Subtasks",
  "subtask.unsaved": "unsaved",
  "subtask.frameOf": "frame {current} / {last}",
  "subtask.highLevel": "High-level instruction",
  "subtask.highLevelPlaceholder": "Overall task for this episode",
  "subtask.activeAt": "Active subtask @ frame {frame}",
  "subtask.none":
    "No subtask yet — add one below, then it covers from frame 0.",
  "subtask.successFrameShort": "success frame:",
  "subtask.unmarked":
    "unmarked — scrub to the success moment, then click “{button}”.",
  "subtask.prevFrame": "Previous frame",
  "subtask.nextFrame": "Next frame",
  "subtask.frame": "frame {frame}",
  "subtask.jumpLastTitle": "Jump to the last frame ({frame})",
  "subtask.lastBtn": "last",
  "subtask.skillPlaceholder": "skill",
  "subtask.instructionPlaceholder":
    "subtask instruction — e.g. grasp the handle of the sponge",
  "subtask.addBtn": "+ Set subtask from here",
  "subtask.markSuccessTitle":
    "Set (or clear) the active subtask's success frame to the current frame",
  "subtask.markSuccessDisabledTitle":
    "Add a subtask first, then scrub into it to mark its success frame",
  "subtask.markSuccess": "✓ Mark success here",
  "subtask.clearSuccess": "✓ Clear success",
  "subtask.paraphrasesPlaceholder": "paraphrases (one per line, optional)",
  "subtask.count_one": "{count} subtask",
  "subtask.count_other": "{count} subtasks",
  "subtask.empty": "No subtasks yet. Scrub to a frame and add one above.",
  "subtask.save": "Save subtasks",
  "subtask.saving": "Saving…",
  "subtask.export": "Export to dataset → subtask_index",
  "subtask.exporting": "Exporting…",
  "subtask.exportTitle":
    "Compile to lerobot-native subtask_index + meta/subtasks.parquet (rewrites parquet; needs Python + pyarrow)",
  "subtask.exportConfirm":
    "Export ALL saved subtasks to the dataset?\n\nCompiles every episode in meta/annotations.json into a per-frame `subtask_index` column (rewrites the data parquet files) and writes meta/subtasks.parquet. A .bak backup is kept. Requires Python + pyarrow.",
  "subtask.statusCleared": "Cleared success frame for subtask #{id}.",
  "subtask.statusMarked":
    "Marked success @ frame {frame} for subtask #{id} ({instruction}).",
  "subtask.statusSaved": "Saved to {path}",
  "subtask.statusSavedPlain": "Saved subtasks.",
  "subtask.statusSaveFailed": "Save failed: {error}",
  "subtask.statusSaveFirst": "Save the episode before exporting.",
  "subtask.statusExporting": "Exporting… (compiling subtask_index in Python)",
  "subtask.successTick": "success @ {frame}",
  "subtask.selectToEdit": "Select a subtask to edit it.",
  "subtask.jumpStart": "Jump to start",
  "subtask.delete": "Delete subtask",
  "subtask.skill": "Skill",
  "subtask.instruction": "Instruction",
  "subtask.paraphrases": "Paraphrases (one per line)",
  "subtask.successFrameLabel": "Success frame",
  "subtask.setCurrentTitle": "Set to the current playhead frame",
  "subtask.setCurrent": "= current ({frame})",
  "subtask.setEndTitle": "Set to this subtask's last frame",
  "subtask.setEnd": "= end ({frame})",
  "subtask.clearBtn": "clear",
  "subtask.successRange":
    "Must be within [{start}, {end}]; values outside are cleared.",

  // ── Action Insights tab ─────────────────────────────────────────────────
  "insights.title": "Action Insights",
  "insights.desc":
    "Data-driven analysis to guide action chunking, data quality assessment, and training configuration.",
  "insights.toggleDesc": "Toggle description",
  "insights.fullscreen": "Fullscreen",
  "insights.exitFullscreen": "Exit fullscreen",
  "insights.exitFullscreenEsc": "Exit fullscreen (Esc)",
  "insights.scopeSampled": "{count} episodes sampled",
  "insights.scopeCurrent": "current episode",
  "insights.scopeEpisodeToggle": "Current Episode",
  "insights.scopeAllToggle": "All Episodes",
  "insights.scopeToggleAria": "Toggle episode/dataset scope",
  "insights.scopeSamplingNote":
    "{sampled} / {total} episodes sampled for statistical analyses",
  "insights.trajTitle": "3D Action Trajectory Distribution",
  "insights.trajDesc":
    "Shows the Cartesian action trajectories across the dataset. Episodes are sampled evenly and each trajectory is downsampled for rendering; the count above says how many are drawn.",
  "insights.trajLoading": "Loading all-episode 3D trajectories…",
  "insights.trajNoData":
    "No complete named action xyz groups were found (for example left_tcp.x/y/z).",
  "insights.trajCoverage": "{loaded} / {total} episodes shown",
  "insights.trajPointCount": "{count} rendered points",
  "insights.trajSelectLayer": "Select at least one trajectory layer.",
  "insights.trajEpisodeLegend": "Episodes",
  "insights.trajEpisodeLegendHint":
    "Each Episode has its own line color. Hover to identify; click to isolate.",
  "insights.trajShowAll": "Show all",
  "insights.trajEpisodeSelectAria": "Focus an Episode",
  "insights.trajAllEpisodesOption": "All Episodes ({count})",
  "insights.trajEpisodeLabel": "Episode {episode}",
  "insights.trajEpisodeButtonTitle":
    "Focus the trajectory for Episode {episode}",
  "insights.trajHoverPrompt":
    "Hover a trajectory to identify it; focused lines are brighter.",
  "insights.trajHoveredStatus": "Episode {episode} · {feature} · {layer}",
  "insights.trajFocusedStatus": "Focused: Episode {episode}",
  "insights.trajControls":
    "Drag to rotate · Scroll to zoom · Right-drag to pan",
  "insights.trajCoordinate": "Z up · position unit: m",
  "insights.lagAxis": "Lag (steps)",
  "insights.lagTooltip": "Lag {lag} ({seconds}s)",
  "insights.overall": "Overall:",
  "insights.verdict": "Verdict:",
  "insights.std": "Std",

  // Autocorrelation
  "insights.acTitle": "Action Autocorrelation",
  "insights.acNoColumns": "No action columns found.",
  "insights.acDesc":
    "Shows how correlated each action dimension is with itself over increasing time lags. Where autocorrelation drops below 0.5 suggests a {boundary} — actions beyond this lag are essentially independent, so executing them open-loop offers diminishing returns.",
  "insights.acBoundary": "natural action chunk boundary",
  "insights.acTheory":
    "Grounded in the theoretical result that chunk length should scale logarithmically with system stability constants ({link}, Theorem 1).",
  "insights.acSuggested": "Suggested chunk length: {steps} steps ({seconds}s)",
  "insights.acSuggestedDesc":
    "Median lag where autocorrelation drops below 0.5 across action dimensions",

  // Action velocity
  "insights.avTitle": "Action Velocity (Δa) — Smoothness Proxy",
  "insights.avNoData": "No action data for velocity analysis.",
  "insights.avDesc1":
    "Shows the distribution of frame-to-frame action changes (Δa = a{tPlus1} − a{t}) for each dimension. A {tight} means smooth, predictable control — the system is likely stable and benefits from longer action chunks.",
  "insights.avTight": "tight distribution around zero",
  "insights.avDesc2":
    "{fat} indicate jerky demonstrations, suggesting shorter chunks and potentially beneficial noise injection.",
  "insights.avFat": "Fat tails or high std",
  "insights.avTheory":
    "Relates to the Lipschitz constant L{pi} and smoothness C{pi2} in {link}, which govern compounding error bounds (Assumptions 3.1, 4.1).",
  "insights.avHistAria": "Δa distribution for {name}",
  "insights.tagInactive": "inactive",
  "insights.tagDiscrete": "discrete",
  "insights.tagInactiveDiscrete": "inactive & discrete",
  "insights.verdictNa": "N/A",
  "insights.verdictSmooth": "Smooth",
  "insights.verdictModerate": "Moderate",
  "insights.verdictJerky": "Jerky",
  "insights.lineSmooth": "{count} smooth ({names})",
  "insights.lineModerate": "{count} moderate ({names})",
  "insights.lineJerky": "{count} jerky ({names})",
  "insights.lineGripper_one":
    "{count} gripper jerky — expected for binary open/close",
  "insights.lineGripper_other":
    "{count} grippers jerky — expected for binary open/close",
  "insights.lineDiscrete": "{count} discrete ({names})",
  "insights.lineInactive": "{count} inactive ({names})",
  "insights.lineExcluded": "{parts} — excluded from verdict",
  "insights.tipNa":
    "All motors are inactive or discrete — no motors to evaluate.",
  "insights.tipSmooth":
    "Actions are consistent — longer action chunks should work well.",
  "insights.tipModerate":
    "Some dimensions show abrupt changes. Consider moderate chunk sizes.",
  "insights.tipJerky":
    "Many dimensions are jerky. Use shorter action chunks and consider filtering outlier episodes.",

  // Jerky episodes
  "insights.jerkyTitle": "Most Jerky Episodes",
  "insights.jerkySortedBy": "sorted by mean |Δa|",
  "insights.showTop15": "Show top 15",
  "insights.showAllN": "Show all {count}",
  "insights.thEpisode": "Episode",
  "insights.thMeanDelta": "Mean |Δa|",

  // Cross-episode variance heatmap
  "insights.hmTitle": "Cross-Episode Action Variance",
  "insights.hmLoading":
    "Loading cross-episode data (sampled up to 500 episodes)…",
  "insights.hmNoData":
    "Not enough episodes or no action data to compute variance.",
  "insights.hmDesc":
    "Shows how much each action dimension varies across episodes at each point in time (normalized 0–100%). {high} indicate multi-modal or inconsistent demonstrations — generative policies (diffusion, flow-matching) and action chunking help here by modeling multiple modes. {low} indicate consistent behavior across demonstrations.",
  "insights.hmHigh": "High-variance regions",
  "insights.hmLow": "Low-variance regions",
  "insights.hmTheory":
    "Relates to the “coverage” discussion in {link} — regions with low variance may lack the exploratory coverage needed to prevent compounding errors (Section 4).",
  "insights.hmCellTitle": "{name} @ {percent}%: var={value}",
  "insights.hmProgress": "Episode progress",
  "insights.hmHighLabel": "high",
  "insights.hmLowLabel": "low",

  // Demonstrator speed variance
  "insights.svTitle": "Demonstrator Speed Variance",
  "insights.svScope": "{count} episodes",
  "insights.svDesc":
    "Distribution of average execution speed (mean ‖Δa{t}‖ per frame) across all episodes. Different human demonstrators often execute at {speeds}, creating artificial multimodality in the action distribution that confuses the policy. A coefficient of variation (CV) above 0.3 strongly suggests normalizing trajectory speed before training.",
  "insights.svSpeeds": "different speeds",
  "insights.svTheory":
    "Based on “Is Diversity All You Need” (AGI-Bot, 2025) which shows velocity normalization dramatically improves fine-tuning success rate.",
  "insights.svConsistent": "Consistent",
  "insights.svModerate": "Moderate variance",
  "insights.svHigh": "High variance",
  "insights.svTipConsistent":
    "Demonstrators execute at similar speeds — no velocity normalization needed.",
  "insights.svTipModerate":
    "Some speed variation across demonstrators. Consider velocity normalization for best results.",
  "insights.svTipHigh":
    "Large speed differences between demonstrations. Velocity normalization before training is strongly recommended.",
  "insights.svBarTitle": "Speed {from}–{to}: {count} ep ({ratio}× median)",

  // State–action alignment
  "insights.saTitle": "State–Action Temporal Alignment",
  "insights.saScope_one": "{scope}, {count} matched pair",
  "insights.saScope_other": "{scope}, {count} matched pairs",
  "insights.saDesc":
    "Per-dimension cross-correlation between Δaction{d1}(t) and Δstate{d2}(t+lag), aggregated as {max}, {mean}, and {min} across all matched action–state pairs. The {peak} reveals the effective control delay — the time between when an action is commanded and when the corresponding state changes.",
  "insights.saMax": "max",
  "insights.saMean": "mean",
  "insights.saMin": "min",
  "insights.saPeakLag": "peak lag",
  "insights.saTheory":
    "Central to ACT ({act} — action chunking compensates for delay), Real-Time Chunking (RTC, {rtc}), and Training-Time RTC ({ttrtc}) — all address the timing mismatch between commanded actions and observed state changes.",
  "insights.saDelay_one": "Mean control delay: {steps} step ({seconds}s)",
  "insights.saDelay_other": "Mean control delay: {steps} steps ({seconds}s)",
  "insights.saLagPositive":
    "State changes lag behind actions by ~{frames} frames on average. Consider aligning action[t] with state[t+{frames}].",
  "insights.saLagNegative":
    "Actions lag behind state changes by ~{frames} frames on average (predictive actions).",
  "insights.saLagRange":
    "Individual dimension peaks range from {min} to {max} steps.",
  "insights.saLegend": "{series} (peak: lag {lag}, r={r})",
  "insights.saAligned":
    "Mean peak correlation at lag 0 (r={r}) — actions and state changes are well-aligned in this episode.",

  // ── Annotations tab ─────────────────────────────────────────────────────
  // Quick-add dropdown. The style token (task_aug / subtask / …) is the value
  // written to the dataset, so it stays visible in both languages.
  "ann.qa.task_aug": "task augmentation",
  "ann.qa.subtask": "subtask",
  "ann.qa.plan": "plan",
  "ann.qa.memory": "memory",
  "ann.qa.interjection": "interjection (user)",
  "ann.qa.speech": "speech (robot say)",
  "ann.qa.count": "vqa: count",
  "ann.qa.attribute": "vqa: attribute",
  "ann.qa.spatial": "vqa: spatial relation",
  // Example placeholders stay English content — that is what goes in the file.
  "ann.ph.taskAug": "pick up the blue cube and place it in the green box",
  "ann.ph.subtask": "grasp the handle of the sponge",
  "ann.ph.plan": "1. grab sponge / 2. wipe / 3. tidy",
  "ann.ph.memory": "sponge picked up; counter still dirty",
  "ann.ph.interjection": "user: actually skip the wipe…",
  "ann.ph.speech": "robot say: Got it, skipping the wipe.",
  "ann.ph.countLabel": "object label (e.g. cup)",
  "ann.ph.count": "count",
  "ann.ph.label": "label",
  "ann.ph.attribute": "attribute (color)",
  "ann.ph.value": "value (red)",
  "ann.ph.subject": "subject",
  "ann.ph.relation": "relation (right_of)",
  "ann.ph.object": "object",

  "ann.title": "Language annotations",
  "ann.editorTablistAria": "Annotation editor",
  "ann.unsaved": "unsaved",
  "ann.subtitle":
    "Select an atom from the timeline or list, then edit it in the inspector.",
  "ann.save": "Save episode",
  "ann.saving": "Saving…",
  "ann.saveFailed": "Save failed: {error}",
  "ann.saveUnknown": "unknown",
  "ann.savedTo": "Saved episode to {path}",
  "ann.saved": "Saved episode annotations.",
  "ann.composerKicker": "Add text annotation",
  "ann.composerDesc":
    "Adds task phrasing, subtask, plan, memory, speech, or non-spatial VQA atoms. Task phrasings are saved at episode start.",
  "ann.addAtFrame": "+ Add at frame",
  "ann.listKicker": "Annotations",
  "ann.atomCount": "{count} atoms in this episode",
  "ann.empty1": "No annotations yet.",
  "ann.empty2": "Add text above or draw on the active video.",
  "ann.colPersistent": "Persistent",
  "ann.colEvents": "Events",
  "ann.colPersistentSub": "language_persistent · broadcast across every frame",
  "ann.colEventsSub": "language_events · fire on a single frame",
  "ann.inspectorKicker": "Inspector",
  "ann.inspectorEmpty":
    "Select an annotation from the list or timeline, or draw a new bbox/keypoint on the video.",
  "ann.emptyContent": "(empty)",
  "ann.allCameras": "all cameras",
  "ann.jumpToFrame": "Jump to this atom's frame",
  "ann.deleteAtom": "Delete this atom",
  "ann.timestamp": "Timestamp (s)",
  "ann.snapToFrame": "snap to frame",
  "ann.fieldTaskAug": "Task augmentation",
  "ann.fieldSubtask": "Subtask",
  "ann.fieldPlan": "Plan",
  "ann.fieldMemory": "Memory",
  "ann.fieldInterjection": "Interjection",
  "ann.fieldSpeech": "Robot speech (say tool call)",
  "ann.fieldCamera": "Camera",
  "ann.cameraAny": "(any — renders on every camera)",
  "ann.fieldQuestion": "Question",
  "ann.fieldAnswer": "Answer ({kind})",
  "ann.kindUnknown": "unknown",
  "ann.tipBbox":
    "Tip: bbox values are 0..1 image-relative (xyxy). Edit on the video itself by deleting this and re-drawing.",
  "ann.tipKeypoint": "Tip: point values are 0..1 image-relative (xy).",
  "ann.tlTitle": "Annotations timeline",
  "ann.tlDragScrub": "Drag to scrub",
  "ann.tlTaskAugTip_one": "task aug · {count} phrasing",
  "ann.tlTaskAugTip_other": "task aug · {count} phrasings",
  "ann.tlCreatePh": "label (e.g. grasp the sponge)",
  "ann.cancel": "cancel",
  "ann.add": "add ↵",
  "ann.qWhere": "where is …?",
  "ann.qPoint": "point to …",
  "ann.phBboxLabel": "label (e.g. carrot)",
  "ann.phPointLabel": "label (e.g. handle)",

  // ── Doctor tab (panel chrome only — the report text stays English) ──────
  "doctor.readOnly": "read-only",
  "doctor.desc":
    "Native TypeScript dataset quality diagnostics. Checks metadata, timing, actions, videos, statistics, episode consistency, training readiness, anomalies, dimension-level jumps, TCP speed limits, and portability without a Python runtime.",
  "doctor.scope10": "First 10 episodes",
  "doctor.scope25": "First 25 episodes",
  "doctor.scope50": "First 50 episodes",
  "doctor.scope100": "First 100 episodes",
  "doctor.scopeAll": "Full dataset",
  "doctor.scopeCustom": "Custom episode range",
  "doctor.startEpisode": "Start episode index",
  "doctor.endEpisode": "End episode index",
  "doctor.phStart": "Start",
  "doctor.phEnd": "End",
  "doctor.to": "to",
  "doctor.scopeLabel": "Diagnostic scope",
  "doctor.downloadJson": "Download JSON",
  "doctor.diagnosing": "Diagnosing…",
  "doctor.runAgain": "Run again",
  "doctor.run": "Run Doctor",
  "doctor.localOnly": "Doctor is available for local datasets only.",
  "doctor.loadingProgress": "Loading episode metadata and parquet data…",
  "doctor.checksCompleted": "{done}/{total} checks completed",
  "doctor.checksWord": "checks",
  "doctor.jumpTitle": "Dimension-Level Jump Detection",
  "doctor.jumpDesc":
    "Triggers when at least 2 dimensions exceed the coordinated threshold, or 1 dimension exceeds the single-dimension threshold; reports triggered dimensions above 8σ.",
  "doctor.coordZ": "Coordinated z",
  "doctor.singleZ": "Single-dimension z",
  "doctor.jumpFormula": "≥2 dims >{z1}σ or 1 dim >{z2}σ",
  "doctor.jumpCondition":
    "Condition: ≥2 dimensions >{z1}σ or 1 dimension >{z2}σ",
  "doctor.speedTitle": "TCP Speed Limit Detection",
  "doctor.speedAria": "Enable TCP speed limit detection",
  "doctor.on": "On",
  "doctor.off": "Off",
  "doctor.speedDesc":
    "Checks each world-frame xyz direction independently. Translation uses metres per second; rotation uses the SO(3) angular velocity in degrees per second.",
  "doctor.speedEnabled": "Enabled for the next Doctor run.",
  "doctor.speedDisabled":
    "Turn on to include this check in the next Doctor run.",
  "doctor.linear": "Linear xyz (m/s)",
  "doctor.angular": "Angular xyz (deg/s)",
  "doctor.speedFormula":
    "|vx| / |vy| / |vz| ≤ {lin} m/s · |ωx| / |ωy| / |ωz| ≤ {ang} deg/s",
  "doctor.speedCondition":
    "Condition: |vx|/|vy|/|vz| > {lin} m/s or |ωx|/|ωy|/|ωz| > {ang} deg/s",
  "doctor.errRange":
    "Enter non-negative episode indices with the end greater than or equal to the start. Both endpoints are included.",
  "doctor.errZ":
    "Enter dimension-jump z-score thresholds greater than 0 and no more than {max}.",
  "doctor.errSpeed":
    "Enter speed thresholds greater than 0. Linear speed must be no more than {maxLinear} m/s and angular speed no more than {maxAngular} deg/s.",
  "doctor.fullWarning":
    "Full-dataset checks load every episode parquet and can use substantial time and memory on large datasets.",
  "doctor.distTitle": "Episode Length Distribution",
  "doctor.distSub": "Statistics · full dataset",
  "doctor.distBins": " · {count} bins",
  "doctor.distLoading": "Loading episode length distribution…",
  "doctor.distUnavailable":
    "Episode length distribution is unavailable for this dataset.",
  "doctor.ready": "Ready to diagnose",
  "doctor.readyHint": "Choose an episode range, then click Run Doctor.",
  "doctor.failed": "Doctor could not complete the diagnosis",
  "doctor.version": "Version",
  "doctor.loadedLine_one":
    "Loaded {count} episode for data-backed checks · {duration} · TypeScript engine v{version}",
  "doctor.loadedLine_other":
    "Loaded {count} episodes for data-backed checks · {duration} · TypeScript engine v{version}",
  "doctor.cached": " · cached",
  "doctor.searchPh": "Search checks and messages…",
  "doctor.clearFilter": "Clear {severity} filter",
  "doctor.flagEpisodes": "Flag episodes {ids}",
  "doctor.flagN": "Flag {count}",
  "doctor.flagAllAffected": "Flag all affected ({count})",
  "doctor.copyAffected": "Copy affected episode IDs",
  "doctor.copyDetailsWait": "Waiting for the episode length distribution",
  "doctor.copyDetailsTitle":
    "Copy all Doctor checks and the episode length distribution",
  "doctor.copiedDetails": "Copied details",
  "doctor.preparingDetails": "Preparing details…",
  "doctor.copyDetails": "Copy details",
  "doctor.noDetail": "No detail messages.",
  "doctor.clean": "clean",
  "doctor.noChecksMatch": "No checks match this filter.",
  "doctor.footnote":
    "Sample limits apply to parquet-backed checks. Dataset metadata and file-layout checks may still inspect the complete directory. Doctor does not modify dataset files.",

  // ── Parquet tab ─────────────────────────────────────────────────────────
  "pq.localOnly": "Raw parquet browsing is only available for local datasets.",
  "pq.groupData": "Data",
  "pq.groupEpisodes": "Episode metadata",
  "pq.groupMeta": "Meta",
  "pq.groupOther": "Other",
  "pq.filterFiles": "Filter files…",
  "pq.scanning": "Scanning dataset…",
  "pq.noFiles": "No parquet files found in this dataset.",
  "pq.noFileSelected": "No file selected",
  "pq.rows": "rows",
  "pq.columns": "columns",
  "pq.rowGroups": "row groups",
  "pq.readingSchema": "Reading schema…",
  "pq.jumpTitle": "{path} rows {from}–{to}",
  "pq.jumpToEpisode": "Jump to episode {index} (rows {from}–{to})",
  "pq.columnsBtn": "Columns {selected}/{total} ▾",
  "pq.filterColumns": "Filter columns…",
  "pq.all": "All",
  "pq.none": "None",
  "pq.reset": "Reset",
  "pq.rowsLabel": "Rows",
  "pq.goToRow": "Go to row",
  "pq.exportCsv": "Export page CSV",
  "pq.reading": "Reading…",
  "pq.noColumns": "No columns selected — pick some in the Columns menu.",
  "pq.selectFile": "Select a parquet file to inspect.",
  "pq.noRows": "No rows in this range.",
  "pq.clickExpand": "Click to expand",

  // ── 3D Replay tab ───────────────────────────────────────────────────────
  "urdf.noTrajectory": "No trajectory data available.",
  "urdf.loadingModel": "Loading 3D model…",
  "urdf.loadingEpisode": "Loading episode {index}…",
  "urdf.jointMapping": "Joint Mapping",
  "urdf.mapped": "({mapped}/{total} mapped)",
  "urdf.dataSource": "Data source",
  "urdf.thJoint": "URDF Joint",
  "urdf.thColumn": "Dataset Column",
  "urdf.thValue": "Value",
  "urdf.unmapped": "-- unmapped --",
  "urdf.trail": "Trail",
  "urdf.showTrail": "Show trail",
  "urdf.hideTrail": "Hide trail",
  "urdf.hintSeek5": "back/forward 5 seconds",
  "urdf.resizeVideo": "Drag to resize video window",
  "urdf.resetVideoSize": "Double-click to reset size",
  "urdf.tacCapMapping": "TacCap Gripper Mapping",
  "urdf.tacCapMapped": "({mapped}/{total} grippers mapped)",
  "urdf.tacCapSide": "Gripper",
  "urdf.tacCapPose": "Recorded Pose",
  "urdf.tacCapGripper": "Opening Column",
  "urdf.tacCapOpening": "Opening",
  "urdf.tacCapLink4Note":
    "TCP frame: +X forward, +Y left, +Z up (red/green/blue reference axes). Complete head.xyz+r1-r6 data adds a yellow trail, schematic HMD, and playback frame. The HMD is centered on the recorded head pose with its visor facing +X; no uncalibrated offset is added. Head video alone does not create a trajectory.",
  "urdf.tacCapNoPose":
    "No complete left_tcp/right_tcp xyz+r1-r6 trajectories were found for TacCap replay.",
  "urdf.axisForward": "forward",
  "urdf.axisLeft": "left",
  "urdf.axisUp": "up",

  // ── charts (Episodes tab) ───────────────────────────────────────────────
  "chart.aria": "Episode chart data",
  "chart.position": "Position",
  "chart.velocity": "Velocity",
  "chart.threeD": "3D",
  "chart.noPose": "No complete xyz or r1-r6 pose groups were found",
  "chart.threeDLoading": "Loading 3D pose view…",
  "chart.threeDNoData": "No complete named xyz pose groups were found",
  "chart.threeDPointCount": "{count} rendered points",
  "chart.threeDPlayback": "{current}s / {duration}s",
  "chart.threeDHoverPrompt": "Hover a line to identify its source and pose.",
  "chart.threeDSelectTrajectory": "Select at least one trajectory.",
  "chart.threeDControls": "Drag to rotate · Scroll to zoom · Right-drag to pan",
  "chart.threeDCoordinate": "Z up · position unit: m",
  "chart.threeDRotationAxes": "Playback frame: X red · Y green · Z blue",
  "chart.split": "Split charts",
  "chart.combine": "Combine all",

  // ── client-side failures rendered verbatim by the calling panel ─────────
  "err.doctorRequest": "Doctor request failed ({status}).",
  "err.doctorProgress": "Doctor returned an invalid progress stream.",
  "err.doctorNoStream": "Doctor did not return a readable progress stream.",
  "err.doctorNoResult": "Doctor progress stream ended without a result.",
  "err.syncNoStream": "Sync returned no stream.",
  "err.syncNoResult": "Sync ended without a result.",
  "err.trashListFailed": "Trash listing failed ({status})",
  "err.datasetInfoFetch": "Failed to fetch dataset info: {status}",
  "err.noCodebaseVersion":
    "Dataset info.json does not contain codebase_version",
  "err.episodeNotFound": "Episode {id} not found in metadata",
  "subtask.exportedDefault": "Exported subtasks to dataset.",

  // ── error / diagnostic pages ────────────────────────────────────────────
  "err.title": "Something went wrong",
  "err.invalidEpisode": "Invalid episode id.",
  "err.unknown": "Unknown error",
  "err.retry": "Try Again",
  "err.incompleteBadge": "⚠ Incomplete dataset",
  "err.emptyBadge": "⚠ Empty dataset",
  "err.cannotOpen": "Cannot open this dataset",
  "err.infoMissing": "meta/info.json is missing or unreadable",
  "err.expected": "Expected: {path}",
  "err.noEpisodes": "This dataset has no episodes",
  "err.zeroEpisodes": "info.json reports total_episodes = 0",
  "err.payloadMissing": "Dataset payload is missing from disk",
  "err.payloadDetail":
    "info.json claims {count} episodes, but the following directories are empty or missing:",
  "err.howToFix": "How to fix",
  "err.fixHint":
    "Re-download the dataset payload with {cmd} so that {data} and {videos} are populated, or remove the empty entry from your local cache.",
  "err.back": "← Back to dataset browser",
} as const;

export type MessageKey = keyof typeof en;
