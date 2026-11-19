// Real Chromium/H.264 regression checks for media events crossing React commits.
// Run with `bun run test:video-playback`; requires ffmpeg and Chrome/Chromium.
// Set VIDEO_PLAYBACK_STRESS=1 for continuous eight-camera playback under load.
// VIDEO_PLAYBACK_DATASET may point to a TacCap v3 dataset with eight camera MP4s.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { NextRequest } from "next/server";
import {
  GET as serveDatasetFile,
  HEAD as prepareDatasetFile,
} from "../src/app/api/local-datasets/[encodedPath]/[...filePath]/route.ts";
import { encodeLocalDatasetPath } from "../src/utils/datasetRoute.ts";
import { DELETE as releasePlaybackLease } from "../src/app/api/video-playback-cache/[key]/route.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const temp = await fs.mkdtemp(path.join(repo, ".tmp-playback-test-"));
let browser, server, socket;
const originalCacheDir = process.env.XENSE_VIDEO_CACHE_DIR;
process.env.XENSE_VIDEO_CACHE_DIR = path.join(temp, "playback-cache");
try {
  const chrome =
    process.env.CHROME_BIN ||
    ["google-chrome", "chromium", "chromium-browser"]
      .map((name) => Bun.which(name))
      .find(Boolean);
  assert.ok(chrome, "Install Chrome/Chromium or set CHROME_BIN");
  assert.ok(Bun.which("ffmpeg"), "Install ffmpeg for H.264 fixtures");
  const clip = path.join(temp, "clip.mp4");
  const made = Bun.spawnSync([
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=192x108:rate=30:duration=60",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "30",
    "-y",
    clip,
  ]);
  assert.equal(made.exitCode, 0, made.stderr.toString());
  const hevc = path.join(temp, "compat.mp4");
  const hasHevc =
    !process.env.VIDEO_PLAYBACK_DATASET &&
    !process.env.VIDEO_PLAYBACK_STRESS &&
    Bun.spawnSync(["ffmpeg", "-hide_banner", "-encoders"])
      .stdout.toString()
      .includes("libx265");
  if (hasHevc) {
    const madeHevc = Bun.spawnSync([
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      clip,
      "-an",
      "-c:v",
      "libx265",
      "-preset",
      "ultrafast",
      "-x265-params",
      "pools=1:frame-threads=1:log-level=error",
      "-pix_fmt",
      "yuv420p",
      "-y",
      hevc,
    ]);
    assert.equal(madeHevc.exitCode, 0, madeHevc.stderr.toString());
  }
  const entry = path.join(temp, "entry.tsx");
  const modulePath = (name) => JSON.stringify(path.join(repo, "src", name));
  // Optional real eight-camera dataset, without changing or transcoding it.
  const dataset = process.env.VIDEO_PLAYBACK_DATASET;
  const fixtureFrames = dataset
    ? JSON.parse(
        await fs.readFile(path.join(dataset, "meta/info.json"), "utf8"),
      ).total_frames
    : 1800;
  const cameraNames = [
    "left_wrist",
    "head_left",
    "head_right",
    "right_wrist",
    "left_tactile_left",
    "left_tactile_right",
    "right_tactile_left",
    "right_tactile_right",
  ];
  const fixtureUrls = cameraNames.map((name) =>
    dataset
      ? "/api/local-datasets/" +
        encodeLocalDatasetPath(dataset) +
        "/videos/observation.images." +
        name +
        "/chunk-000/file-000.mp4"
      : "/api/local-datasets/" + encodeLocalDatasetPath(temp) + "/clip.mp4",
  );
  await fs.writeFile(
    entry,
    `
    import React, {useCallback, useRef, useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {LocaleProvider} from ${modulePath("context/locale-context.tsx")};
    import {TimeProvider,useTimeControls} from ${modulePath("context/time-context.tsx")};
    import {SimpleVideosPlayer} from ${modulePath("components/simple-videos-player.tsx")};
    import Replay from ${modulePath("components/urdf-video-overlay.tsx")};
    import {ReplayPlaybackDriver} from ${modulePath("components/replay-playback-driver.tsx")};
    import {useDocumentVisible} from ${modulePath("hooks/use-document-visible.ts")};
    import PlaybackBar from ${modulePath("components/playback-bar.tsx")};
    import {REPLAY_VIDEO_SYNC} from ${modulePath("utils/replayVideoSync.ts")};
    window.replaySyncTolerance=REPLAY_VIDEO_SYNC.HARD_SEEK_SECONDS;
    const params=new URLSearchParams(location.search);
    const segmented = params.has('episodes');
    const cameras=Number(params.get('cameras'))||2;
    window.fixtureId=location.search;
    window.cameraCount=cameras;
    window.setDocumentVisible=visible=>{
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>!visible});
      document.dispatchEvent(new Event('visibilitychange'));
    };
    const videos = Array.from({length:cameras},(_,i)=>({
      filename:${JSON.stringify(cameraNames)}[i]??('camera_'+i),
      url:(params.has('hevc')?${JSON.stringify("/api/local-datasets/" + encodeLocalDatasetPath(temp) + "/compat.mp4")}:${JSON.stringify(fixtureUrls)}[i % 8])+(params.has('prepare-delay')?'?prepare_delay=1':''),
      ...(segmented?{isSegmented:true,segmentStart:1,segmentEnd:55}:{})
    }));
    function Controls() {
      const controls=useTimeControls();
      // Queue boundary events in the SAME task as pause, before React commits.
      window.pauseAtBoundary=()=>{
        controls.setIsPlaying(false);
        for (const video of document.querySelectorAll('video')) {
          Object.defineProperty(video,'currentTime',{
            configurable:true, get:()=>54.98,
            set(value){ delete this.currentTime; this.currentTime=value; }
          });
          video.dispatchEvent(new Event('timeupdate'));
          video.dispatchEvent(new Event('ended'));
          delete video.currentTime;
        }
      };
      window.seekPaused=time=>controls.seek(time);
      return null;
    }
    function EpisodesFixture() {
      const [episode,setEpisode]=useState(0);
      const [mediaVideos,setMediaVideos]=useState(videos);
      window.changeEpisode=time=>{
        setEpisode(v=>v+1);
        setMediaVideos(previous=>previous.map(video=>({...video,segmentStart:time})));
      };
      window.changeSource=time=>setMediaVideos(previous=>previous.map(video=>({...video,
        segmentStart:time,url:video.url+(video.url.includes('?')?'&':'?')+'source=next'
      })));
      return <TimeProvider duration={54} resetKey={episode}><Controls/>
        <SimpleVideosPlayer datasetKey="fixture" episodeId={episode} videosInfo={mediaVideos}/>
        <PlaybackBar/>
      </TimeProvider>;
    }
    function ReplayFixture() {
      const [active,setActive]=useState(true);
      const documentVisible=useDocumentVisible();
      const mediaActive=active&&documentVisible;
      const [playing,setPlaying]=useState(false);
      const [frame,setFrame]=useState(9);
      const [revision,setRevision]=useState(0);
      const [episode,setEpisode]=useState(0);
      const [mediaVideos,setMediaVideos]=useState(videos);
      const frameRef=useRef(9),smoothTimeRef=useRef(null);
      const timeAtRow=useCallback(row=>row/30,[]);
      const time=timeAtRow(frame);
      window.replayTime=time;
      window.replayPlaying=mediaActive&&playing;
      const setTime=time=>{frameRef.current=Math.round(time*30);setFrame(frameRef.current)};
      window.setActive=setActive;
      window.isActive=active;
      window.toggle=()=>setPlaying(v=>!v);
      window.pauseWithLateClock=()=>{
        setPlaying(false);
        setTimeout(()=>setTime(Math.max(0,document.querySelector('video').currentTime-.45)),35);
      };
      window.seekPaused=time=>{setTime(time);setRevision(v=>v+1)};
      window.changeEpisode=time=>{setTime(time);setEpisode(v=>v+1)};
      window.changeSource=time=>{
        setTime(time);
        setMediaVideos(previous=>previous.map(video=>({...video,
          url:video.url+(video.url.includes('?')?'&':'?')+'source=next'
        })));
      };
      return <><ReplayPlaybackDriver playing={mediaActive&&playing} rowsPerSecond={30}
        replayRevision={revision} totalFrames={${fixtureFrames}} frameRef={frameRef} setFrame={setFrame}
        smoothTimeRef={smoothTimeRef} timeAtRow={timeAtRow}/>
        <Replay active={mediaActive} datasetKey="fixture" episodeId={episode} videos={mediaVideos}
        playing={playing} episodeTimeSeconds={time} replayRevision={revision}/></>;
    }
    createRoot(document.getElementById('root')!).render(
      <React.StrictMode><LocaleProvider initialLocale="en">{segmented?
        <EpisodesFixture/>:<ReplayFixture/>}
      </LocaleProvider></React.StrictMode>
    );
  `,
  );
  const built = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" },
  });
  assert.ok(built.success, JSON.stringify(built.logs));
  const bundle = await built.outputs[0].text();
  // Use the components' real utilities so viewport regressions are checked
  // against the same sizing rules as the application, not fixture CSS.
  const { css } = await postcss([tailwind()]).process(
    `@import "tailwindcss" source(none);
     @source "../src/components/simple-videos-player.tsx";
     @source "../src/components/first-frame-video.tsx";
     @source "../src/components/playback-bar.tsx";`,
    { from: path.join(temp, "styles.css") },
  );
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/app.js")
        return new Response(bundle, {
          headers: { "content-type": "text/javascript" },
        });
      if (url.pathname === "/styles.css")
        return new Response(css, {
          headers: { "content-type": "text/css" },
        });
      if (url.pathname.startsWith("/api/video-playback-cache/")) {
        return releasePlaybackLease(new NextRequest(req), {
          params: Promise.resolve({ key: url.pathname.split("/").at(-1) }),
        });
      }
      if (url.pathname.startsWith("/api/local-datasets/")) {
        if (req.method === "HEAD" && url.searchParams.has("prepare_delay"))
          await Bun.sleep(500);
        const segments = url.pathname
          .slice("/api/local-datasets/".length)
          .split("/")
          .map(decodeURIComponent);
        return (req.method === "HEAD" ? prepareDatasetFile : serveDatasetFile)(
          new NextRequest(req),
          {
            params: Promise.resolve({
              encodedPath: segments[0],
              filePath: segments.slice(1),
            }),
          },
        );
      }
      return new Response(
        `<!doctype html><meta charset="utf-8">
        <link rel="stylesheet" href="/styles.css">
        <style>body{background:#172033}</style>
        <div id="root"></div><script>
          window.metrics={seeks:[],loads:0,phases:[],errors:[]};
          window.seekDetails=[];
          if(new URLSearchParams(location.search).has('delayed')) {
            // Simulate a covered video's compositor callback being withheld,
            // with data becoming usable after the initial RAF/media events.
            const frame=HTMLVideoElement.prototype.requestVideoFrameCallback;
            if(frame)HTMLVideoElement.prototype.requestVideoFrameCallback=function(){
              return frame.call(this,()=>{});
            };
            const delayed=new WeakSet();
            document.addEventListener('loadeddata',event=>{
              const video=event.target;
              if(!(video instanceof HTMLVideoElement)||delayed.has(video))return;
              delayed.add(video);
              Object.defineProperty(video,'readyState',{configurable:true,get:()=>1});
              setTimeout(()=>delete video.readyState,1000);
            },true);
          }
          const proto=HTMLMediaElement.prototype;
          const current=Object.getOwnPropertyDescriptor(proto,'currentTime');
          Object.defineProperty(proto,'currentTime',{configurable:true,
            get(){return current.get.call(this)},
            set(value){metrics.seeks.push(value);seekDetails.push({target:value,before:current.get.call(this),paused:this.paused,ended:this.ended,playing:window.replayPlaying});current.set.call(this,value)}});
          const load=proto.load; proto.load=function(){metrics.loads++;return load.call(this)};
          new MutationObserver(records=>{for(const r of records){
            metrics.phases.push([r.oldValue,r.target.dataset.videoFrameState]);
          }}).observe(document,{subtree:true,attributes:true,attributeOldValue:true,
            attributeFilter:['data-video-frame-state']});
          addEventListener('error',e=>metrics.errors.push(e.message));
          addEventListener('unhandledrejection',e=>metrics.errors.push(String(e.reason)));
        </script><script type="module" src="/app.js"></script>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const profile = path.join(temp, "chrome");
  const stderrPath = path.join(temp, "chrome-stderr.log");
  const stderrHandle = await fs.open(stderrPath, "w");
  try {
    browser = Bun.spawn(
      [
        chrome,
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--no-proxy-server",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-port=0",
        "--user-data-dir=" + profile,
        "about:blank",
      ],
      { stdout: "ignore", stderr: stderrHandle.fd },
    );
  } finally {
    await stderrHandle.close();
  }
  let active;
  const startupDeadline = performance.now() + 30_000;
  while (performance.now() < startupDeadline) {
    if (browser.exitCode !== null) break;
    try {
      const contents = await fs.readFile(
        path.join(profile, "DevToolsActivePort"),
        "utf8",
      );
      const [port, endpoint] = contents.trim().split("\n");
      if (
        Number.isInteger(Number(port)) &&
        Number(port) > 0 &&
        Number(port) <= 65535 &&
        endpoint?.startsWith("/devtools/browser/")
      ) {
        active = contents;
        break;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await Bun.sleep(50);
  }
  if (!active) {
    const diagnostic = (await fs.readFile(stderrPath, "utf8")).slice(-8192);
    throw new Error(
      "Chrome did not start (" +
        chrome +
        "; exit " +
        (browser.exitCode ?? "still running") +
        ")\n" +
        diagnostic,
    );
  }
  const [port, endpoint] = active.trim().split("\n");
  socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    clearTimeout(task.timer);
    if (message.error) task.reject(Error(JSON.stringify(message.error)));
    else task.resolve(message.result);
  };
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Browser command timed out: " + method));
      }, 45000);
      pending.set(id, { resolve, reject, timer });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  const target = await call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await call("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  await call("Target.activateTarget", { targetId: target.targetId });
  await call("Page.enable", {}, sessionId);
  await call("Page.stopLoading", {}, sessionId);
  const evaluate = async (expression) => {
    const result = await call(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (result.exceptionDetails)
      throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (expression) => {
    // Large real MP4s need more startup/seek time than the small fixture.
    const deadline = performance.now() + (dataset ? 30_000 : 6_000);
    while (performance.now() < deadline) {
      if (await evaluate(expression)) return;
      await Bun.sleep(25);
    }
    throw Error(
      "Timeout: " +
        expression +
        " " +
        JSON.stringify(
          await evaluate(`({compatibility:document.querySelector("[data-video-compatibility]")?.parentElement.innerText,sources:[...document.querySelectorAll("video")].map(v=>v.src),metrics:window.metrics,
            media:[...document.querySelectorAll('video')].map(v=>({
              name:v.getAttribute('aria-label'),readyState:v.readyState,
              networkState:v.networkState,time:v.currentTime,seeking:v.seeking,
              paused:v.paused,phase:v.parentElement.dataset.videoFrameState,
              error:v.error&&{code:v.error.code,message:v.error.message}
            }))})`),
        ),
    );
  };
  const reset =
    "window.metrics={seeks:[],loads:0,phases:[],errors:[]};window.seekDetails=[]";
  const ready =
    "document.querySelectorAll('[data-video-frame-state=ready]').length===window.cameraCount";
  const mediaPaused = (value) =>
    `[...document.querySelectorAll('video')].length===window.cameraCount && [...document.querySelectorAll('video')].every(v=>v.paused===${value})`;
  const assertUnchanged = async (label, allowPlayingDrift = false) => {
    await until(ready);
    const metrics = await evaluate("window.metrics");
    if (allowPlayingDrift && metrics.seeks.length) {
      const details = await evaluate("window.seekDetails");
      const tolerance = await evaluate("window.replaySyncTolerance");
      assert.equal(details.length, metrics.seeks.length);
      for (const detail of details) {
        assert.ok(
          detail.playing && (!detail.paused || detail.ended),
          label + ": seek while paused: " + JSON.stringify(detail),
        );
        assert.ok(
          Math.abs(detail.target - detail.before) >= tolerance,
          label + ": unnecessary decoder seek: " + JSON.stringify(detail),
        );
      }
      assert.equal(metrics.loads, 0, label + ": unexpected media reload");
      assert.deepEqual(metrics.errors, []);
      assert.deepEqual(
        metrics.phases,
        [],
        label + ": playback hides decoded frames",
      );
      console.log(
        label +
          ": validated " +
          details.length +
          " genuine playing drift corrections",
      );
    } else {
      assert.deepEqual(
        metrics,
        { seeks: [], loads: 0, phases: [], errors: [] },
        label + ": " + JSON.stringify(metrics),
      );
    }
    assert.equal(await evaluate(ready), true, label + ": frames ready");
    assert.equal(
      await evaluate(
        "[...document.querySelectorAll('video')].every(v=>getComputedStyle(v).visibility==='visible')",
      ),
      true,
      label + ": frames visible",
    );
  };
  const checkExpansion = async () => {
    await evaluate(
      `window.expansionNodes=[...document.querySelectorAll('video')];
      window.expansionOverflow=document.body.style.overflow;` + reset,
    );
    const open = `document.querySelector('button[title="Enlarge"]').focus();
      document.querySelector('button[title="Enlarge"]').click();`;
    await evaluate(open);
    await until("!!document.querySelector('[role=dialog]')");
    for (const [width, height] of [
      [2560, 1100],
      [1280, 720],
      [640, 360],
    ]) {
      await call(
        "Emulation.setDeviceMetricsOverride",
        { width, height, deviceScaleFactor: 1, mobile: false },
        sessionId,
      );
      await until(`(() => {
        const dialog=document.querySelector('[role=dialog]');
        const control=dialog.querySelector('button[title="Minimize"]');
        const video=dialog.querySelector('video');
        return [control,video].every(el=>{
          const r=el.getBoundingClientRect();
          return r.width>0&&r.height>0&&r.top>=0&&r.left>=0
            &&r.bottom<=innerHeight&&r.right<=innerWidth;
        }) && control.contains(document.elementFromPoint(
          control.getBoundingClientRect().x+control.offsetWidth/2,
          control.getBoundingClientRect().y+control.offsetHeight/2));
      })()`);
    }
    assert.equal(
      await evaluate(`document.activeElement===document.querySelector('[role=dialog] button[title="Minimize"]')
        && document.body.style.overflow==='hidden'`),
      true,
      "enlargement focuses the restore control and locks background scrolling",
    );
    await evaluate(
      `document.querySelector('[role=dialog] button[title="Minimize"]').click()`,
    );
    await until("!document.querySelector('[role=dialog]')");
    await evaluate(open);
    await until("!!document.querySelector('[role=dialog]')");
    await call(
      "Input.dispatchKeyEvent",
      {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      },
      sessionId,
    );
    await until("!document.querySelector('[role=dialog]')");
    assert.equal(
      await evaluate(`document.body.style.overflow===window.expansionOverflow
        && [...document.querySelectorAll('video')].every((v,i)=>v===window.expansionNodes[i])
        && document.activeElement===document.querySelector('button[title="Enlarge"]')`),
      true,
      "button and Escape restore the original nodes, focus and scroll state",
    );
    await assertUnchanged("video enlargement retains the media decoder");
  };
  if (hasHevc) {
    const delayed = "?replay&cameras=8&prepare-delay=1";
    await call(
      "Page.navigate",
      { url: server.url.toString() + delayed },
      sessionId,
    );
    await until(`window.fixtureId===${JSON.stringify(delayed)} && ${ready}`);
    await evaluate(
      `window.compatNodes=[...document.querySelectorAll('video')];window.compatSources=compatNodes.map(v=>v.src);document.querySelector('[data-video-compatibility=original]').click()`,
    );
    await until(
      `!!document.querySelector('[data-video-compatibility=preparing]')`,
    );
    assert.equal(
      await evaluate(
        `[...document.querySelectorAll('video')].every((v,i)=>v===compatNodes[i]&&v.src===compatSources[i])&&document.querySelectorAll('[data-video-frame-state=ready]').length===8`,
      ),
      true,
      "first frames remain visible while preparing",
    );
    await evaluate(
      `document.querySelector('[data-video-compatibility=preparing]').click()`,
    );
    await until(
      `!!document.querySelector('[data-video-compatibility=original]')`,
    );
    await Bun.sleep(600);
    assert.equal(
      await evaluate(
        `[...document.querySelectorAll('video')].every((v,i)=>v.src===compatSources[i])`,
      ),
      true,
      "cancelled preparation retains original sources",
    );
    const query = "?episodes&cameras=8&hevc=1";
    await call(
      "Page.navigate",
      { url: server.url.toString() + query },
      sessionId,
    );
    await until(
      `window.fixtureId===${JSON.stringify(query)} && !!document.querySelector('[data-video-compatibility=original]')`,
    );
    await evaluate(
      `window.compatNodes=[...document.querySelectorAll('video')];document.querySelector('[data-video-compatibility=original]').click()`,
    );
    await until(
      `!!document.querySelector('[data-video-compatibility=compatible]') && ${ready}`,
    );
    assert.equal(
      await evaluate(
        `[...document.querySelectorAll('video')].every((v,i)=>v===compatNodes[i]&&new URL(v.src).searchParams.get('compat')==='lossless-h264')`,
      ),
      true,
      "all compatible sources switch without replacing media nodes",
    );
    await evaluate(`window.seekPaused(2.5)`);
    await until(
      `${ready}&&[...document.querySelectorAll('video')].every(v=>Math.abs(v.currentTime-2.5)<0.15)`,
    );
    console.log(
      "HEVC compatibility: retained first frames, cancellation, all-camera source switch and episode-local seek passed",
    );
  }
  if (!process.env.VIDEO_PLAYBACK_STRESS) {
    const query = "?replay&cameras=8&delayed=1";
    await call(
      "Page.navigate",
      { url: server.url.toString() + query },
      sessionId,
    );
    await until(`window.fixtureId===${JSON.stringify(query)} && ${ready}`);
    await evaluate(reset);
    await Bun.sleep(300);
    await assertUnchanged(
      "eight delayed cameras recover without compositor callbacks",
    );
    console.log(
      "delayed decoder readiness: all eight frames recovered without a reload",
    );
  }
  if (process.env.VIDEO_PLAYBACK_STRESS) {
    await call("Emulation.setCPUThrottlingRate", { rate: 4 }, sessionId);
    await call(
      "Page.navigate",
      { url: server.url.toString() + "?replay&cameras=8" },
      sessionId,
    );
    await until(ready);
    await evaluate("window.toggle()");
    await until(mediaPaused(false));
    await Bun.sleep(800);
    await until(ready);
    await evaluate(reset);
    // A heavy Canvas/React task delays RAF while the media clock keeps playing.
    for (let i = 0; i < 3; i++) {
      await evaluate(
        "{const end=performance.now()+650;while(performance.now()<end){}};",
      );
      await Bun.sleep(500);
    }
    await Bun.sleep(1000);
    await until(ready);
    const stalls = await evaluate("window.metrics");
    console.log(
      "eight-camera playback through main-thread stalls:",
      JSON.stringify(stalls),
    );
    assert.deepEqual(stalls, { seeks: [], loads: 0, phases: [], errors: [] });

    // Small drift must converge without resetting all eight GOP decoders.
    await evaluate(
      "for(const v of document.querySelectorAll('video'))v.currentTime-=.3;",
    );
    await Bun.sleep(100);
    await until(ready);
    await evaluate(reset);
    await Bun.sleep(6000);
    await assertUnchanged("eight-camera soft drift recovery");
    assert.ok(
      await evaluate(
        "[...document.querySelectorAll('video')].every(v=>Math.abs(v.currentTime-window.replayTime)<.2)",
      ),
    );
    await evaluate(
      "for(const v of document.querySelectorAll('video'))v.currentTime+=2;",
    );
    await Bun.sleep(100);
    await evaluate(reset);
    await until("window.metrics.seeks.length>0");
    await Bun.sleep(500);
    await assertUnchanged(
      "eight-camera large drift recovery retains frames",
      true,
    );

    await evaluate(`window.seekPaused(${fixtureFrames / 30 - 0.6})`);
    await Bun.sleep(100);
    await until(ready);
    await evaluate(reset);
    await Bun.sleep(1800);
    await assertUnchanged("eight-camera loop recovery retains frames", true);
    assert.ok(await evaluate("window.replayTime<3"), "timeline loops");
    assert.ok(
      await evaluate(
        "[...document.querySelectorAll('video')].every(v=>v.currentTime<3&&!v.paused)",
      ),
      "all cameras resume after looping",
    );
    console.log(
      "eight-camera continuous playback and soft drift recovery passed" +
        (dataset ? " with real dataset" : ""),
    );
  }
  for (const { mode, cameras, cycles, cpu } of process.env.VIDEO_PLAYBACK_STRESS
    ? []
    : [
        { mode: "episodes", cameras: 2, cycles: 400, cpu: 1 },
        { mode: "replay", cameras: 2, cycles: 400, cpu: 1 },
        { mode: "replay", cameras: 8, cycles: 200, cpu: 4 },
      ]) {
    const label = `${mode} (${cameras} cameras, CPU x${cpu})`;
    const query = "?" + mode + "&cameras=" + cameras;
    await call("Emulation.setCPUThrottlingRate", { rate: cpu }, sessionId);
    await call(
      "Page.navigate",
      { url: server.url.toString() + query },
      sessionId,
    );
    await until(`window.fixtureId===${JSON.stringify(query)} && ${ready}`);
    // Finish Strict Mode's first mount/readiness and its queued media events.
    await Bun.sleep(100);
    await evaluate(
      mode === "episodes"
        ? "document.querySelector('button[title^=Play]').click()"
        : "window.toggle()",
    );
    await until(mediaPaused(false));
    await Bun.sleep(300);
    await evaluate(reset);
    await evaluate(
      mode === "episodes"
        ? "window.pauseAtBoundary()"
        : "window.pauseWithLateClock()",
    );
    await until(mediaPaused(true));
    await Bun.sleep(180);
    await assertUnchanged(label + " pause race");

    // Explicit paused seeks must still update the actual decoder position.
    await evaluate("window.seekPaused(.8)");
    const targetTime = mode === "episodes" ? 1.8 : 0.8;
    await until(
      `${ready} && [...document.querySelectorAll('video')].every(v=>!v.seeking&&Math.abs(v.currentTime-${targetTime})<.05)`,
    );
    await evaluate(reset);
    for (let i = 0; i < cycles; i++) {
      await evaluate(
        mode === "episodes"
          ? "document.querySelector('button[title^=Play]').click()"
          : "window.toggle()",
      );
      await until(mediaPaused(false));
      await Bun.sleep(8 + (i % 13));
      await evaluate(
        mode === "episodes"
          ? "document.querySelector('button[title^=Pause]').click()"
          : "window.toggle()",
      );
      await until(mediaPaused(true));
      await Bun.sleep(8);
    }
    await assertUnchanged(
      label + " " + cycles + " play/pause cycles",
      mode === "replay",
    );
    await evaluate(reset);
    if (mode === "replay") {
      // Continuous playback intentionally corrects material drift; paused
      // clocks and sub-threshold offsets must still never cause a decoder seek.
      await evaluate("window.toggle()");
      await until(mediaPaused(false));
      await Bun.sleep(100);
      await evaluate("document.querySelector('video').currentTime+=2;" + reset);
      await until("window.metrics.seeks.length>0 && " + ready);
      await evaluate("window.toggle()");
      await until(mediaPaused(true));
      await assertUnchanged(label + " intentional drift recovery", true);
      await evaluate(reset);
      for (let i = 0; i < 40; i++) {
        await evaluate("window.setActive(false)");
        await until("window.isActive===false");
        await evaluate("window.setActive(true)");
        await until("window.isActive===true");
        await Bun.sleep(8);
      }
      await assertUnchanged(
        "replay visibility toggles retain the paused frame",
      );
      // A seek issued while inactive must wait, then apply exactly on return.
      await evaluate("window.setActive(false)");
      await until("window.isActive===false");
      const retainedTime = await evaluate(
        "document.querySelector('video').currentTime",
      );
      await evaluate("window.seekPaused(2.4)");
      await Bun.sleep(40);
      assert.equal(
        await evaluate("document.querySelector('video').currentTime"),
        retainedTime,
      );
      await evaluate("window.setActive(true)");
      await until(
        `${ready} && [...document.querySelectorAll('video')].every(v=>!v.seeking&&Math.abs(v.currentTime-2.4)<.05)`,
      );
      await evaluate(reset);
    }
    // Both memoized players must read the latest target on source/episode
    // changes, including v3 episodes retaining the same MP4.
    await evaluate("window.changeEpisode(1.6)");
    await until(
      `${ready} && [...document.querySelectorAll('video')].every(v=>!v.seeking&&Math.abs(v.currentTime-1.6)<.05)`,
    );
    const episodeMetrics = await evaluate("window.metrics");
    assert.equal(episodeMetrics.loads, 0, "episode retains its MP4");
    assert.deepEqual(episodeMetrics.errors, []);
    await evaluate(reset);
    await evaluate("window.changeSource(3.2)");
    await until(
      `${ready} && [...document.querySelectorAll('video')].every(v=>!v.seeking&&Math.abs(v.currentTime-3.2)<.05)`,
    );
    const sourceMetrics = await evaluate("window.metrics");
    assert.equal(sourceMetrics.loads, cameras, "load each new source once");
    assert.deepEqual(sourceMetrics.errors, []);
    await evaluate(reset);
    for (let i = 0; i < 40; i++) {
      await evaluate("window.setDocumentVisible(false)");
      await Bun.sleep(8);
      await evaluate("window.setDocumentVisible(true)");
      await Bun.sleep(8);
    }
    await assertUnchanged(label + " browser visibility changes");
    if (mode === "episodes") await checkExpansion();
    await evaluate(
      mode === "episodes"
        ? "document.querySelector('button[title^=Play]').click()"
        : "window.toggle()",
    );
    await until(mediaPaused(false));
    if (mode === "episodes") await checkExpansion();
    for (let i = 0; i < 20; i++) {
      await evaluate("window.setDocumentVisible(false)");
      await until(mediaPaused(true));
      await evaluate("window.setDocumentVisible(true)");
      await until(mediaPaused(false));
      await Bun.sleep(8);
    }
    if (mode === "replay") {
      for (let i = 0; i < 20; i++) {
        await evaluate("window.setActive(false)");
        await until(mediaPaused(true));
        await evaluate("window.setActive(true)");
        await until(mediaPaused(false));
        await Bun.sleep(8);
      }
    }
    await evaluate(
      mode === "episodes"
        ? "document.querySelector('button[title^=Pause]').click()"
        : "window.toggle()",
    );
    await until(mediaPaused(true));
    await assertUnchanged(
      label + " visibility changes during playback",
      mode === "replay",
    );
    console.log(
      `${label}: pause race, explicit seek, ${cycles} play/pause cycles and visibility changes passed`,
    );
  }
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      socket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      try {
        socket.send(
          JSON.stringify({
            id: Number.MAX_SAFE_INTEGER,
            method: "Browser.close",
          }),
        );
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
  socket?.close();
  server?.stop(true);
  if (browser) {
    browser.kill();
    await browser.exited;
  }
  await fs.rm(temp, { recursive: true, force: true });
  if (originalCacheDir === undefined) delete process.env.XENSE_VIDEO_CACHE_DIR;
  else process.env.XENSE_VIDEO_CACHE_DIR = originalCacheDir;
}
