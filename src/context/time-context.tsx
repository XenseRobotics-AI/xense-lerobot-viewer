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

type TimeContextType = {
  currentTime: number;
  seek: (t: number, source?: TimeUpdateSource) => void;
  // Monotonically increasing counter that bumps on every `external` seek.
  // Sync effects compare the current value against a stored ref to detect
  // user-initiated seeks without relying on heuristics like "did the time
  // jump by more than 0.3s".
  externalSeekVersion: number;
  subscribe: (cb: (t: number) => void) => () => void;
  isPlaying: boolean;
  setIsPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  duration: number;
  setDuration: React.Dispatch<React.SetStateAction<number>>;
};

const TimeContext = createContext<TimeContextType | undefined>(undefined);

export const useTime = () => {
  const ctx = useContext(TimeContext);
  if (!ctx) throw new Error("useTime must be used within a TimeProvider");
  return ctx;
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

  return (
    <TimeContext.Provider
      value={{
        currentTime,
        seek: updateTime,
        externalSeekVersion,
        subscribe,
        isPlaying,
        setIsPlaying,
        duration,
        setDuration,
      }}
    >
      {children}
    </TimeContext.Provider>
  );
};
