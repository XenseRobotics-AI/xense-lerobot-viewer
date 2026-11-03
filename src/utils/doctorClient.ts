import type {
  DoctorCheckId,
  DoctorDimensionJumpThresholds,
  DoctorEpisodeRange,
  DoctorProgress,
  DoctorRunResponse,
  DoctorSpeedThresholds,
  DoctorStreamEvent,
} from "@/types/doctor.types";
import { tStandalone } from "@/i18n/standalone";
import { consumeResponseLines } from "@/utils/responseLines";

export interface RunDoctorOptions {
  maxEpisodes: number | null;
  episodeRange?: DoctorEpisodeRange | null;
  dimensionJumpThresholds?: DoctorDimensionJumpThresholds;
  speedThresholds?: DoctorSpeedThresholds;
  checks?: DoctorCheckId[];
  signal?: AbortSignal;
  onProgress?: (progress: DoctorProgress) => void;
  refresh?: boolean;
}

function doctorError(data: unknown, status: number): Error {
  if (data && typeof data === "object" && "error" in data) {
    const error = typeof data.error === "string" ? data.error : null;
    const hint =
      "hint" in data && typeof data.hint === "string" ? data.hint : null;
    if (error) return new Error(hint ? `${error}\n\n${hint}` : error);
  }
  return new Error(tStandalone("err.doctorRequest", { status }));
}

function parseStreamLine(line: string): DoctorStreamEvent | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as DoctorStreamEvent;
  } catch {
    throw new Error(tStandalone("err.doctorProgress"));
  }
}

export async function runDatasetDoctor(
  encodedPath: string,
  options: RunDoctorOptions,
): Promise<DoctorRunResponse> {
  const query = new URLSearchParams({ stream: "1" });
  if (options.refresh) query.set("refresh", "1");
  const response = await fetch(
    `/api/local-datasets/${encodedPath}/doctor?${query.toString()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: options.signal,
      body: JSON.stringify({
        maxEpisodes: options.maxEpisodes,
        episodeRange: options.episodeRange,
        dimensionJumpThresholds: options.dimensionJumpThresholds,
        speedThresholds: options.speedThresholds,
        checks: options.checks,
      }),
    },
  );

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as unknown;
    throw doctorError(data, response.status);
  }
  if (!response.body) {
    throw new Error(tStandalone("err.doctorNoStream"));
  }

  let result: DoctorRunResponse | null = null;

  const processEvent = (event: DoctorStreamEvent | null) => {
    if (!event) return;
    if (event.type === "progress") options.onProgress?.(event.progress);
    else if (event.type === "result") result = event.result;
    else if (event.type === "error") throw new Error(event.error);
  };

  await consumeResponseLines(response.body, (line) =>
    processEvent(parseStreamLine(line)),
  );

  if (!result) throw new Error(tStandalone("err.doctorNoResult"));
  return result;
}
