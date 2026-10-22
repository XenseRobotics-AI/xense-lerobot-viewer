import {
  discoverLocalDatasets,
  serializeLocalDatasetsResponseForClient,
} from "@/lib/local-datasets-discovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const data = serializeLocalDatasetsResponseForClient(
    await discoverLocalDatasets(),
  );
  const status =
    data.errors.length > 0 && data.datasets.length === 0 && !data.root
      ? 500
      : 200;
  return Response.json(data, { status });
}
