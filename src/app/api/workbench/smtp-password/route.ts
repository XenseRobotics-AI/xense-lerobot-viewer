import { NextRequest } from "next/server";
import { isSameOriginRequest, noStoreHeaders } from "@/lib/request-security";
import {
  normalizeWorkbenchSmtpPassword,
  writeWorkbenchSmtpPassword,
} from "@/lib/workbench-mail-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function passwordFromRequestBody(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return normalizeWorkbenchSmtpPassword(
    (value as { password?: unknown }).password,
  );
}

export async function PUT(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return Response.json(
      {
        error: "Cross-origin SMTP password changes are not allowed.",
        code: "ORIGIN_REJECTED",
      },
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

  const password = passwordFromRequestBody(body);
  if (!password) {
    return Response.json(
      { error: "SMTP password is required." },
      { status: 400, headers: noStoreHeaders() },
    );
  }

  try {
    const result = await writeWorkbenchSmtpPassword(password);
    return Response.json(
      {
        message: "SMTP password saved.",
        passwordFile: result.filePath,
      },
      { headers: noStoreHeaders() },
    );
  } catch (error: unknown) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to save SMTP password.",
      },
      { status: 500, headers: noStoreHeaders() },
    );
  }
}
