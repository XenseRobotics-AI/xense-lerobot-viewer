import type {
  HfDownloadCheck,
  HfDownloadRequest,
  HfDownloadStreamEvent,
} from "@/types/hf-download.types";

async function errorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  return payload.error || fallback;
}

export async function readHfDownloadRoot(
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch("/api/workbench/hf-download/check", {
    cache: "no-store",
    signal,
  });
  if (!response.ok)
    throw new Error(
      await errorMessage(response, "Unable to read the download root."),
    );
  const payload = (await response.json()) as { destinationRoot?: unknown };
  if (typeof payload.destinationRoot !== "string") {
    throw new Error("The download root response is incomplete.");
  }
  return payload.destinationRoot;
}

export async function checkHfDownload(
  request: HfDownloadRequest,
  signal?: AbortSignal,
): Promise<HfDownloadCheck> {
  const response = await fetch("/api/workbench/hf-download/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    cache: "no-store",
    signal,
  });
  if (!response.ok)
    throw new Error(
      await errorMessage(
        response,
        `Download check failed (${response.status}).`,
      ),
    );
  return (await response.json()) as HfDownloadCheck;
}

export async function startHfDownload(
  request: HfDownloadRequest & { revisionSha: string },
  onEvent: (event: HfDownloadStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/workbench/hf-download/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    cache: "no-store",
    signal,
  });
  if (!response.ok)
    throw new Error(
      await errorMessage(response, `Download failed (${response.status}).`),
    );
  if (!response.body)
    throw new Error("The download returned no progress stream.");
  const reader = response.body.getReader();
  const abortReader = () => {
    void reader.cancel();
  };
  signal?.addEventListener("abort", abortReader, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = (line: string) => {
    if (!line.trim()) return;
    onEvent(JSON.parse(line) as HfDownloadStreamEvent);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) consume(line);
    }
    consume(buffer);
  } finally {
    signal?.removeEventListener("abort", abortReader);
  }
}
