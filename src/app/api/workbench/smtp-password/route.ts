import { NextRequest } from "next/server";
import { isSameOriginRequest, noStoreHeaders } from "@/lib/request-security";
import {
  normalizeWorkbenchSmtpPassword,
  writeWorkbenchSmtpPassword,
} from "@/lib/workbench-mail-runtime";
import { resolveWorkbenchMailSender } from "@/lib/workbench-mail-sender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function credentialsFromRequestBody(value: unknown):
  | {
      sender: Extract<
        ReturnType<typeof resolveWorkbenchMailSender>,
        { ok: true }
      >["config"];
      password: string;
    }
  | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "Expected a JSON object body." };
  }
  const raw = value as { sender?: unknown; password?: unknown };
  const sender = resolveWorkbenchMailSender(raw.sender);
  if (!sender.ok) return { error: sender.error };
  const password = normalizeWorkbenchSmtpPassword(raw.password);
  if (!password) return { error: "SMTP authorization code is required." };
  return { sender: sender.config, password };
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

  const credentials = credentialsFromRequestBody(body);
  if ("error" in credentials) {
    return Response.json(
      { error: credentials.error },
      { status: 400, headers: noStoreHeaders() },
    );
  }

  try {
    await writeWorkbenchSmtpPassword(
      credentials.password,
      credentials.sender.provider,
    );
    return Response.json(
      {
        message: `${credentials.sender.provider.toUpperCase()} SMTP authorization code saved.`,
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
