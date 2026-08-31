import React, {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  useEffect,
} from "react";

// `external` (default) — user-initiated seek (slider drag, chart click,
//                        loop boundary reset). Bumps `externalSeekVersion`
//                        so sync effects know to drive every video to the
//                        new position.
// `video`              — the primary video reporting its own currentTime
//                        via timeupdate. Does NOT bump the version; the
//                        sync effect should treat the change as a status
//                        report, not a command.
type TimeUpdateSource = "external" | "video";

type TimeState = {
  currentTime: number;
  externalSeekVersion: number;
  isPlaying: boolean;
  duration: number;
};

type TimeControls = {
  seek: (t: number, source?: TimeUpdateSource) => void;
  subscribe: (cb: (t: number) => void) => () => void;
  setIsPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  setDuration: React.Dispatch<React.SetStateAction<number>>;
};

// Keep high-frequency playback state separate from stable commands. The old
// single context changed its value on every throttled time tick, which made
// components that only needed `seek`/`setIsPlaying` re-render as well.
const TimeStateContext = createContext<TimeState | undefined>(undefined);
const TimeControlsContext = createContext<TimeControls | undefined>(undefined);

export const useTimeState = (): TimeState => {
  const ctx = useContext(TimeStateContext);
  if (!ctx) throw new Error("useTimeState must be used within TimeProvider");
  return ctx;
};

export const useTimeControls = (): TimeControls => {
  const ctx = useContext(TimeControlsContext);
  if (!ctx) throw new Error("useTimeControls must be used within TimeProvider");
  return ctx;
};

export const useTime = () => {
  return { ...useTimeState(), ...useTimeControls() };
};

const TIME_RENDER_THROTTLE_MS = 80;

export const TimeProvider: React.FC<{
  children: React.ReactNode;
  duration: number;
  resetKey?: string | number;
}> = ({ children, duration: initialDuration, resetKey }) => {
  const [currentTime, setCurrentTimeState] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(initialDuration);
  const [externalSeekVersion, setExternalSeekVersion] = useState(0);
  const listeners = useRef<Set<(t: number) => void>>(new Set());
  const resetStateRef = useRef({ duration: initialDuration, resetKey });

  // Keep the authoritative time in a ref so subscribers and sync effects
  // always see the latest value without waiting for a React render cycle.
  const timeRef = useRef(0);
  const rafId = useRef<number | null>(null);
  const lastRenderTime = useRef(0);

  const updateTime = useCallback(
    (t: number, source: TimeUpdateSource = "external") => {
      timeRef.current = t;
      listeners.current.forEach((fn) => fn(t));

      if (source === "external") {
        lastRenderTime.current = performance.now();
        setCurrentTimeState(t);
        setExternalSeekVersion((v) => v + 1);
        return;
      }

      // Throttle React state updates — during playback, timeupdate fires ~4×/sec
      // per video. Coalescing into rAF + a minimum interval avoids cascading
      // re-renders across PlaybackBar, charts, etc.
      if (rafId.current === null) {
        rafId.current = requestAnimationFrame(() => {
          rafId.current = null;
          const now = performance.now();
          if (now - lastRenderTime.current >= TIME_RENDER_THROTTLE_MS) {
            lastRenderTime.current = now;
            setCurrentTimeState(timeRef.current);
          }
        });
      }
    },
    [],
  );

  // Flush any pending rAF on unmount
  useEffect(() => {
    return () => {
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
    };
  }, []);

  // When playback stops, flush the exact final time so the UI matches
  useEffect(() => {
    if (!isPlaying) {
      setCurrentTimeState(timeRef.current);
    }
  }, [isPlaying]);

  // The provider intentionally survives episode navigation so heavyweight
  // children (notably the 3D/URDF scene) can remain mounted. Mirror the new
  // episode duration and reset playback without replacing that subtree.
  useEffect(() => {
    const previous = resetStateRef.current;
    resetStateRef.current = { duration: initialDuration, resetKey };
    if (
      previous.duration === initialDuration &&
      Object.is(previous.resetKey, resetKey)
    ) {
      return;
    }
    timeRef.current = 0;
    setCurrentTimeState(0);
    setIsPlaying(false);
    setDuration(initialDuration);
    setExternalSeekVersion((version) => version + 1);
    listeners.current.forEach((fn) => fn(0));
  }, [initialDuration, resetKey]);

  const subscribe = useCallback((cb: (t: number) => void) => {
    listeners.current.add(cb);
    return () => listeners.current.delete(cb);
  }, []);

  const timeState = React.useMemo<TimeState>(
    () => ({
      currentTime,
      externalSeekVersion,
      isPlaying,
      duration,
    }),
    [currentTime, duration, externalSeekVersion, isPlaying],
  );
  const timeControls = React.useMemo<TimeControls>(
    () => ({
      seek: updateTime,
      subscribe,
      setIsPlaying,
      setDuration,
    }),
    [subscribe, updateTime],
  );

  return (
    <TimeControlsContext.Provider value={timeControls}>
      <TimeStateContext.Provider value={timeState}>
        {children}
      </TimeStateContext.Provider>
    </TimeControlsContext.Provider>
  );
};
