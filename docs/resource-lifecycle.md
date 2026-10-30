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
After foreground media is ready, idle work warms the current page's already-fetched
metadata in small yielding batches (at most 100 selected episodes). It never
starts extra video or data-Parquet downloads. Hidden/offline/data-saving/2G states
skip new background work. Episode changes cancel queued idle callbacks; already
shared data is retained and browsing/marking never waits for the warm-up.

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
