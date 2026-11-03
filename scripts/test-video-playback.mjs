// Real Chromium/H.264 regression checks for media events crossing React commits.
// Run with `bun run test:video-playback`; requires ffmpeg and Chrome/Chromium.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const temp = await fs.mkdtemp(path.join(repo, ".tmp-playback-test-"));
let browser, server, socket;
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
    "-movflags",
    "+faststart",
    "-y",
    clip,
  ]);
  assert.equal(made.exitCode, 0, made.stderr.toString());
  const entry = path.join(temp, "entry.tsx");
  const modulePath = (name) => JSON.stringify(path.join(repo, "src", name));
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
      filename:'camera_'+i, url:'/clip.mp4', ...(segmented?{isSegmented:true,segmentStart:1,segmentEnd:55}:{})
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
    function ReplayFixture() {
      const [active,setActive]=useState(true);
      const documentVisible=useDocumentVisible();
      const mediaActive=active&&documentVisible;
      const [playing,setPlaying]=useState(false);
      const [frame,setFrame]=useState(9);
      const [revision,setRevision]=useState(0);
      const frameRef=useRef(9),smoothTimeRef=useRef(null);
      const timeAtRow=useCallback(row=>row/30,[]);
      const time=timeAtRow(frame);
      const setTime=time=>{frameRef.current=Math.round(time*30);setFrame(frameRef.current)};
      window.setActive=setActive;
      window.isActive=active;
      window.toggle=()=>setPlaying(v=>!v);
      window.pauseWithLateClock=()=>{
        setPlaying(false);
        setTimeout(()=>setTime(Math.max(0,document.querySelector('video').currentTime-.45)),35);
      };
      window.seekPaused=time=>{setTime(time);setRevision(v=>v+1)};
      return <><ReplayPlaybackDriver playing={mediaActive&&playing} rowsPerSecond={30}
        replayRevision={revision} totalFrames={1800} frameRef={frameRef} setFrame={setFrame}
        smoothTimeRef={smoothTimeRef} timeAtRow={timeAtRow}/>
        <Replay active={mediaActive} datasetKey="fixture" episodeId={0} videos={videos}
        playing={playing} episodeTimeSeconds={time} replayRevision={revision}/></>;
    }
    createRoot(document.getElementById('root')!).render(
      <React.StrictMode><LocaleProvider initialLocale="en">{segmented?
        <TimeProvider duration={54} resetKey="fixture"><Controls/>
          <SimpleVideosPlayer datasetKey="fixture" episodeId={0} videosInfo={videos}/>
          <PlaybackBar/>
        </TimeProvider>:<ReplayFixture/>}
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
  const bytes = new Uint8Array(await fs.readFile(clip));
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/app.js")
        return new Response(bundle, {
          headers: { "content-type": "text/javascript" },
        });
      if (url.pathname === "/clip.mp4") {
        const range = req.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2]
          ? Math.min(Number(range[2]), bytes.length - 1)
          : bytes.length - 1;
        return new Response(bytes.slice(start, end + 1), {
          status: range ? 206 : 200,
          headers: {
            "accept-ranges": "bytes",
            "content-type": "video/mp4",
            "content-length": String(end - start + 1),
            ...(range
              ? { "content-range": `bytes ${start}-${end}/${bytes.length}` }
              : {}),
          },
        });
      }
      return new Response(
        `<!doctype html><meta charset="utf-8">
        <style>body{background:#172033}.visible{visibility:visible}.invisible{visibility:hidden}
          video{width:240px;height:180px} [data-video-frame-state]{position:relative}</style>
        <div id="root"></div><script>
          window.metrics={seeks:[],loads:0,phases:[],errors:[]};
          const proto=HTMLMediaElement.prototype;
          const current=Object.getOwnPropertyDescriptor(proto,'currentTime');
          Object.defineProperty(proto,'currentTime',{configurable:true,
            get(){return current.get.call(this)},
            set(value){metrics.seeks.push(value);current.set.call(this,value)}});
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
  browser = Bun.spawn(
    [
      chrome,
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      "--user-data-dir=" + profile,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  let active;
  for (let i = 0; i < 100; i++) {
    try {
      active = await fs.readFile(
        path.join(profile, "DevToolsActivePort"),
        "utf8",
      );
      break;
    } catch {
      await Bun.sleep(50);
    }
  }
  assert.ok(active, "Chrome did not start");
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
    pending.delete(message.id);
    message.error
      ? task.reject(Error(JSON.stringify(message.error)))
      : task.resolve(message.result);
  };
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
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
    for (let i = 0; i < 240; i++) {
      if (await evaluate(expression)) return;
      await Bun.sleep(25);
    }
    throw Error(
      "Timeout: " +
        expression +
        " " +
        JSON.stringify(await evaluate("window.metrics")),
    );
  };
  const reset = "window.metrics={seeks:[],loads:0,phases:[],errors:[]}";
  const ready =
    "document.querySelectorAll('[data-video-frame-state=ready]').length===window.cameraCount";
  const mediaPaused = (value) =>
    `[...document.querySelectorAll('video')].length===window.cameraCount && [...document.querySelectorAll('video')].every(v=>v.paused===${value})`;
  const assertUnchanged = async (label) => {
    const metrics = await evaluate("window.metrics");
    assert.deepEqual(
      metrics,
      { seeks: [], loads: 0, phases: [], errors: [] },
      label + ": " + JSON.stringify(metrics),
    );
    assert.equal(await evaluate(ready), true, label + ": frames ready");
    assert.equal(
      await evaluate(
        "[...document.querySelectorAll('video')].every(v=>getComputedStyle(v).visibility==='visible')",
      ),
      true,
      label + ": frames visible",
    );
  };
  for (const { mode, cameras, cycles, cpu } of [
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
    await assertUnchanged(label + " " + cycles + " play/pause cycles");
    if (mode === "replay") {
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
    for (let i = 0; i < 40; i++) {
      await evaluate("window.setDocumentVisible(false)");
      await Bun.sleep(8);
      await evaluate("window.setDocumentVisible(true)");
      await Bun.sleep(8);
    }
    await assertUnchanged(label + " browser visibility changes");
    await evaluate(
      mode === "episodes"
        ? "document.querySelector('button[title^=Play]').click()"
        : "window.toggle()",
    );
    await until(mediaPaused(false));
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
    await assertUnchanged(label + " visibility changes during playback");
    console.log(
      `${label}: pause race, explicit seek, ${cycles} play/pause cycles and visibility changes passed`,
    );
  }
} finally {
  socket?.close();
  server?.stop(true);
  if (browser) {
    browser.kill();
    await browser.exited;
  }
  await fs.rm(temp, { recursive: true, force: true });
}
