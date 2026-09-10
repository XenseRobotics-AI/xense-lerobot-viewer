import { NextRequest } from "next/server";
import {
  defaultHfDownloadRoot,
  parseHfDownloadRequest,
  runHfDownloadCheck,
} from "@/lib/hf-download-runtime";
import { isSameOriginRequest, noStoreHeaders } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    return Response.json(
      { destinationRoot: defaultHfDownloadRoot() },
      { headers: noStoreHeaders() },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: noStoreHeaders() },
    );
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return Response.json(
      { error: "Cross-origin download checks are not allowed." },
      { status: 403, headers: noStoreHeaders() },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Expected a JSON body." },
      { status: 400, headers: noStoreHeaders() },
    );
  }
  try {
    const parsed = await parseHfDownloadRequest(body);
    return Response.json(await runHfDownloadCheck(parsed), {
      headers: noStoreHeaders(),
    });
  } catch (error) {
    const status = error instanceof TypeError ? 400 : 502;
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status, headers: noStoreHeaders() },
    );
  }
}
