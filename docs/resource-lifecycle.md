# Resource lifecycle boundaries

Browser visibility is a scheduling signal, not a cancellation signal. Do not
translate visibilitychange, document.hidden or blur into AbortController.abort(),
media source removal, or a lost diagnostic/review result.

| Operation                                                                          | Playback / scheduling                                                         | Requests / task ownership                                                          |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Switch browser tabs or minimise the window                                         | Pause playback/animation; skip new periodic polls                             | Retain media sources and let in-flight reads, reviews and diagnostics finish       |
| Return to the browser tab                                                          | Reuse media/data; refresh stale summaries without duplicating in-flight polls | Do not restart or cancel an existing task                                          |
| Pause playback or leave a thumbnail with the pointer                               | Pause media                                                                   | Retain its source and buffered data                                                |
| Scroll a homepage preview out of view                                              | Release that preview source                                                   | Only that obsolete preview request may be cancelled                                |
| Navigate away / unmount, replace a data request, or explicitly cancel a diagnostic | Release the resources owned by that view/request                              | Cancel obsolete read-only work; do not roll back confirmed writes                  |
| HTTP connection actually closes                                                    | Detach the response                                                           | This is a transport event; the server cannot infer user intent from the error name |
| Diagnostic deadline expires                                                        | Finish the response with a timeout error                                      | Abort that job with TimeoutError; do not classify it as a user cancellation        |

## Resource ownership

- File responses (200 and 206): one response owns one filesystem stream. Attach
  lifecycle handlers before propagating a request abort. An explicit bridge owns
  data/backpressure and a single terminal Web action; do not use Node 18's
  Readable.toWeb adapter here. Cancelling between EOF and descriptor close must
  mark the bridge terminal before destroying the source, without closing the
  already-cancelled Web controller again. Keep the error handler until descriptor
  close, discard late callbacks, then detach all handlers. Before opening a file, recheck cancellation
  after asynchronous path lookup. Pre-cancelled requests return an empty 499;
  cancellation after headers terminates the body. Consumer cancellation must also
  close the file. The queue is bounded in bytes. HEAD owns no file stream; byte
  ranges on empty files return 416.
- Streaming diagnostics: the request/reader owns one read-only job. Cancellation
  marks the output closed before aborting the job, clears listeners/timers, and
  ignores late progress/completion. Timeouts and real errors remain visible.
  Aborted or timed-out runs must not populate the result cache.
- Shared JSON diagnostics: each request owns a subscription. One departing
  subscriber cannot cancel the others. The shared job owns its deadline; the last
  departing subscriber aborts the job and evicts it. Late settlement of an old
  job cannot evict its replacement.
- Parquet handles and metadata caches are shared. A request cancellation must not
  destroy another reader's cache entry. Diagnostic cancellation is cooperative:
  it is checked between filesystem/Parquet operations and CPU checks. An already
  executing decode or uninterruptible filesystem operation may finish, but must
  not initiate fallback scans or publish/cache a cancelled result.
- Confirmed background writes own their subprocess and write lock independently
  of HTTP. A disconnected reader detaches output and resumes/drains any paused
  stdout. Only subprocess termination releases the lock, exactly once. The sync
  feature remains disabled; these lifecycle fixes do not enable it.
- NDJSON clients own their reader locks. On parsing/callback/transport failure,
  cancel unread output and release the lock without masking the original error.
- Review/annotation mutations keep their existing atomic persistence semantics;
  visibility changes must not cancel a write or imply that it was rolled back.
- Review saves run in a per-provider serial queue to keep server snapshots in
  order. Pending/error state is keyed by episode and person, independently of the
  visible episode. Capture dataset/work directory, person and entry point when
  marking; navigating cannot retarget the write. Only that record's mark button
  is locked. Navigation, playback, other episodes and reviewer selection remain
  available. Save status has a separate React context so it does not rerender the
  whole viewer/sidebar; confirmed record updates use a transition. A failed save
  is shown on its record and does not stop later queued saves.

## Regression checks

Run bun run format followed by bun run validate. The Bun suite launches the real
node executable through src/lib/**tests**/stream-node.test.ts and transpiles only
the production helpers into a temporary directory. The child process uses no
uncaughtException or unhandledRejection suppression. CI pins this check to Node
18.19.1, the runtime that exposed the original failure.

Coverage includes pre-aborted requests, cancellation across async setup and signal
subscription, mid-transfer abort, reader/body/request cancellation between EOF and
descriptor close in both listener orderings, bounded read-ahead, unexpected source
closure, empty files, real I/O failures, descriptor/listener cleanup, rapid aborts,
empty ranges, late diagnostic callbacks, timeouts, shared
subscribers, detached write completion/backpressure and NDJSON reader cleanup.

Manual visibility verification uses the production review provider, shared
visibility hook and homepage preview component in a temporary Chrome page:
switch to a second browser tab while the review response and MP4 are delayed;
assert the original tab is hidden, the video source remains attached, neither
request is aborted, and the review finishes while hidden. Returning to the tab
must retain the loaded review and media source. This check does not need to
restart or modify an existing viewer development server.

Review navigation verification uses the production provider and mark panel with
delayed PUT responses: mark an episode, immediately switch episodes/person/entry
point and mark again. Confirm navigation completes before the first save; data-only
viewer consumers do not rerender for save-status changes; queued payloads retain
their original targets. Inject one save failure, confirm later saves continue and
only the failed episode shows an error, then retry it. Replace the dataset while
another save is pending and confirm the write completes against the original
endpoint without overwriting the newly visible dataset's state.

## Inspection layout and background list work

Inspection controls live in the sidebar, outside the visualization flex column.
The sidebar header remains fixed; only the episode list scrolls, and selecting an
episode scrolls that list alone to reveal its active item. Details and storage
paths are collapsed initially, so marks, saves, errors and details do not resize
the video/3D viewport. Save state remains isolated from viewer data consumers.

The episode index list is prepared from info.json independently of full episode
loading and appears while the selected episode's data is loading. Concurrent list
and episode consumers share the same metadata request, including body consumption;
failed requests are removed from the in-flight map. Index arrays are reused.
After foreground media is ready and playback is paused, an IntersectionObserver
rooted in the sidebar scroll container selects only episode links actually on
screen. After 350 ms without scroll/navigation/input, requestIdleCallback starts
one background episode read, nearest to the active episode first. Subsequent idle
jobs have a 50 ms gap; any new interaction resets the settling period. Browsers without
that API use the delayed callback. This warms parsed chart/pose data and metadata,
not adjacent MP4s or every route rendered on the page. The preloader is a leaf
subscriber so its visibility/playback updates do not redraw the viewer.

Foreground reads have priority: a different episode starts immediately and the
same episode joins an existing read. Hidden/offline/data-saving/2G states skip
new work. Visibility changes and input cancel queued callbacks only; already
shared reads finish normally. Obsolete scope completions cannot populate another
dataset's cache. Failed preloads do not enter the visible episode's error state or
create quality marks, and a later foreground read can retry. The preloader never
owns a review save or its cancellation.

Parsed recent data is bounded to 8 entries and an estimated 192 MiB, protecting the
active episode if it alone exceeds that estimate. Background results have their
own 24-entry / estimated 128 MiB budget and cannot evict foreground history.
Offscreen entries within 2 episodes have 10-minute expiry, those within 12 have
4 minutes, and more distant/other-dataset entries have 1 minute. Age pruning
runs every 30 seconds; visible/current entries are protected from age eviction,
and capacity pressure releases distant offscreen entries sooner. Cleanup is also
scheduled after leaving the viewer. Periods and byte budgets are centralized in
src/utils/episodeCachePolicy.ts; capacity eviction is immediate even with the
longer retention. These limits bound retained caches, not
transient decodes, mounted views, browser video buffers or total process memory.
Budgets cap retained in-memory data per browser tab across datasets; they are
not preallocated memory, dataset/file-size limits, disk quotas or cumulative
network-read limits. Raising byte budgets does not raise the entry limits or
background concurrency.

The main thread and one background worker each cap raw Parquet caches at 16
handles, 512 ranges and 128 MiB across files, with 10-minute idle expiry. Combined
raw-cache ceilings are 256 MiB per tab; the named parsed/raw budgets total 576 MiB,
not a hard total-memory limit. Equivalent suffix/range requests
and concurrent file opens share reads. Failed requests are removed. Eviction only
releases cache references and never closes or cancels an active consumer. Endpoints
returning a full file instead of 206 do not retain an extra unbounded hidden copy.

Cold foreground reads take the direct core path, avoiding worker queueing and
large structured-clone overhead. One dedicated worker handles speculative reads;
unsupported/crashed workers disable preloading while foreground remains usable. A foreground selection that
adopts a failing preload retries once directly; concurrent selectors share the retry.
The worker has no permanent parsed-result cache and omits its episode index from
results; the UI reattaches its shared index. Results larger than the speculative
budget are rejected before cloning. Queued jobs are bounded to eight, newest
first; active jobs finish normally. Worker idle termination after 10 minutes
releases its caches. A 120-second task deadline is a separate failure boundary
with retry, never a response to hiding a tab or navigating away.

Parquet footer promises are shared per cached file object in a WeakMap, including
parallel column/object reads. Failed metadata is removed for retry, and data-page
errors propagate to callers instead of leaving unresolved reads. Ordinary chart
rows are flattened only after selecting the existing display indices. Full-rate
pose/gripper derivatives still run before sampling; source timestamps, endpoints
and the 4,000-point display limit are unchanged.

Regression checks use the actual sidebar, IntersectionObserver, time/visibility
providers and V2/V3 Parquet decoders in Chrome: only visible links are warmed,
rapid scrolling defers work, media readiness and playback gate background reads,
cache hits avoid duplicate fetches, foreground switches bypass background work,
and hiding the tab lets the in-flight request finish without starting another.
Unit tests cover distance expiry, cache capacity, failed-read retries, same-key
promotion, scope changes and 1,000 episode / 500 file switching cycles.

## Playback controls and decode boundaries

Play/pause changes media playback only; it does not invalidate an already
decoded frame. EPISODE's play intent updates synchronously with its control,
before React commits, so a queued segment-end event cannot loop a paused video.
3D Replay uses explicit seek revisions for slider, keyboard and replay commands.
Late sampled clock updates after pausing are status reports, not decoder seeks.
Replay's row clock preserves fractional frames across pauses and includes the
last partial RAF interval, even when playback stops before the first RAF. Only
timeline changes and explicit seek revisions reset that fraction. This avoids
cumulative drift from rapid toggles triggering corrective decoder seeks.
The driver sits alongside DOM media rather than inside Canvas, so playback
commands do not depend on separate 3D renderer commits.
Showing a retained replay view without a new seek revision keeps its paused
media position; a seek issued while inactive is applied when the view returns.
Pending seeks are idempotent and frame checks retain their scheduled callbacks,
so duplicate commands or frequent clock renders cannot starve presentation.
Source/episode changes and explicit seeks still gate stale frames until the new
target is available.

`bun run test:video-playback` exercises the real React components in Chromium
with generated H.264 video (requires ffmpeg and Chrome/Chromium; `CHROME_BIN`
can override the executable). It uses the production replay clock and driver,
and covers same-task pause/boundary events, late paused-clock updates, exact
paused/inactive seeks, 400 play/pause cycles per entry, and another 200 cycles
with eight cameras under 4x CPU throttling. Retained-view activation and document
visibility changes are checked separately from explicit seek commands.
The fixtures run in development Strict Mode, check every loading-state
transition and currentTime/load call, and remove their temporary files.

## Review write locks and old-version interoperability

Linux review writes require util-linux flock and filesystem shared-lock support.
A persistent episode-reviews.json.write-lock inode is locked by a tiny no-fork
helper waiting on the server's stdin pipe. The kernel releases its lease when the
server exits or crashes; no heartbeat or time-based lock stealing is used. Never
unlink this persistent file: its presence alone does not mean it is locked.

While holding that lease, a new writer also acquires the original .lock directory
so old-version viewers remain mutually exclusive with new writers. New-owned
directories contain a protocol, native inode identity and unique owner token. Only
an orphan carrying this recognized protocol can be recovered automatically, after
acquiring the same native lease. Device numbers are not compared across NFS clients.
Empty or unknown legacy locks are never stolen, regardless of age. Their writers
may be running on another machine. A tiny crash window between directory creation
and owner-record creation is conservatively treated as an unknown legacy lock too.
Reads, exports, navigation and playback do not acquire this write lease.

For a genuinely abandoned empty legacy lock, first pause saves on **all old-version
viewer servers** and wait for in-flight writes to finish. Browsing may continue.
Then run, from the viewer checkout:

    bun scripts/recover-review-lock.ts /absolute/browse/directory --no-legacy-writers

The command validates the storage scope, acquires the native lease, makes a uniquely
named UTC+8 backup, then removes only the empty legacy directory. It refuses active
native leases and nonempty/symlinked directories. It does not change review records,
replay an unfinished mark or delete temporary files. Retry the manual mark afterward.
An offline NFS mount may still delay filesystem operations; a lock timeout must not
be reported as a successful save or used to bypass the legacy writer boundary.
