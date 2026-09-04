import type { NextRequest } from "next/server";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import { resolveHfToken } from "@/lib/hf-token-store";
import { isSameOriginRequest, noStoreHeaders } from "@/lib/request-security";
import {
  WorkbenchSharedHubConflictError,
  runWorkbenchSharedHub,
  type WorkbenchSharedHubReadResult,
} from "@/lib/workbench-shared-hub";
import {
  WORKBENCH_SHARED_CONFIG_KINDS,
  WORKBENCH_SHARED_REPO_ID,
  WORKBENCH_SHARED_REPO_URL,
  applyRemoteWorkbenchSharedConfig,
  digestWorkbenchSharedValue,
  listPendingWorkbenchSharedEvents,
  markWorkbenchSharedEventsSent,
  normalizeWorkbenchSharedOrg,
  parseWorkbenchSharedConfig,
  readLocalWorkbenchSharedConfigs,
  readWorkbenchSharedSyncMetadata,
  resolveWorkbenchSharedConfig,
  serializeWorkbenchSharedValue,
  workbenchSharedConfigPath,
  writeWorkbenchSharedSyncMetadata,
  type WorkbenchSharedConfigDocument,
  type WorkbenchSharedConfigKind,
} from "@/lib/workbench-shared-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SYNC_ATTEMPTS = 3;

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: noStoreHeaders(),
  });
}

function organizationFromRequest(request: Request): string {
  return normalizeWorkbenchSharedOrg(
    new URL(request.url).searchParams.get("org"),
  );
}

function configTimestamps(
  configs: Record<WorkbenchSharedConfigKind, WorkbenchSharedConfigDocument>,
): Record<WorkbenchSharedConfigKind, string> {
  return Object.fromEntries(
    WORKBENCH_SHARED_CONFIG_KINDS.map((kind) => [
      kind,
      configs[kind].updatedAt,
    ]),
  ) as Record<WorkbenchSharedConfigKind, string>;
}

async function statusPayload(
  org: string,
  root: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const [configs, pending, metadata, credential] = await Promise.all([
    readLocalWorkbenchSharedConfigs(org, root),
    listPendingWorkbenchSharedEvents(root),
    readWorkbenchSharedSyncMetadata(root),
    resolveHfToken(root).catch(() => ({
      token: null,
      source: "none" as const,
    })),
  ]);
  return {
    ...metadata,
    repoId: WORKBENCH_SHARED_REPO_ID,
    repoUrl: WORKBENCH_SHARED_REPO_URL,
    public: true,
    organization: org,
    tokenPresent: Boolean(credential.token),
    tokenSource: credential.source,
    pendingEvents: pending.filter((item) => item.event.org === org).length,
    configUpdatedAt: configTimestamps(configs),
    privacy: {
      personnelEmailsPublished: true,
      runLogsPublished: true,
      excluded: "Authentication credentials such as HF tokens and passwords",
    },
    ...extra,
  };
}

function remoteDocuments(
  org: string,
  read: WorkbenchSharedHubReadResult,
): Record<WorkbenchSharedConfigKind, WorkbenchSharedConfigDocument | null> {
  return Object.fromEntries(
    WORKBENCH_SHARED_CONFIG_KINDS.map((kind) => {
      const repoPath = workbenchSharedConfigPath(org, kind);
      const raw = read.files[repoPath];
      return [
        kind,
        raw === null || raw === undefined
          ? null
          : parseWorkbenchSharedConfig(raw, kind, org),
      ];
    }),
  ) as Record<WorkbenchSharedConfigKind, WorkbenchSharedConfigDocument | null>;
}

async function readRemote(
  org: string,
  token: string | null,
): Promise<{
  read: WorkbenchSharedHubReadResult;
  documents: Record<
    WorkbenchSharedConfigKind,
    WorkbenchSharedConfigDocument | null
  >;
}> {
  const result = await runWorkbenchSharedHub(
    {
      action: "read",
      repoId: WORKBENCH_SHARED_REPO_ID,
      paths: WORKBENCH_SHARED_CONFIG_KINDS.map((kind) =>
        workbenchSharedConfigPath(org, kind),
      ),
    },
    token,
  );
  if (result.action !== "read") {
    throw new Error("Unexpected Hugging Face shared-state response.");
  }
  return { read: result, documents: remoteDocuments(org, result) };
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const org = organizationFromRequest(request);
    const root = resolveLocalDatasetRoot();
    return json(await statusPayload(org, root));
  } catch (error: unknown) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to read Workbench shared sync status.",
      },
      400,
    );
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return json(
      { error: "Cross-origin Workbench shared sync is not allowed." },
      403,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be JSON." }, 400);
  }

  try {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "Request body must be an object." }, 400);
    }
    const org = normalizeWorkbenchSharedOrg((body as { org?: unknown }).org);
    const root = resolveLocalDatasetRoot();
    const credential = await resolveHfToken(root);
    const token = credential.token;
    let lastConflict: Error | null = null;

    for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
      const [{ read, documents: remote }, local, allPending] =
        await Promise.all([
          readRemote(org, token),
          readLocalWorkbenchSharedConfigs(org, root),
          listPendingWorkbenchSharedEvents(root),
        ]);
      const resolutions = WORKBENCH_SHARED_CONFIG_KINDS.map((kind) =>
        resolveWorkbenchSharedConfig(local[kind], remote[kind]),
      );

      const pulled: WorkbenchSharedConfigKind[] = [];
      for (const resolution of resolutions) {
        if (resolution.winner !== "remote") continue;
        await applyRemoteWorkbenchSharedConfig(resolution.document, root);
        pulled.push(resolution.kind);
      }

      const desired = await readLocalWorkbenchSharedConfigs(org, root);
      const configFiles = WORKBENCH_SHARED_CONFIG_KINDS.flatMap((kind) => {
        const remoteDocument = remote[kind];
        if (
          remoteDocument &&
          digestWorkbenchSharedValue(remoteDocument) ===
            digestWorkbenchSharedValue(desired[kind])
        ) {
          return [];
        }
        return [
          {
            path: workbenchSharedConfigPath(org, kind),
            content: serializeWorkbenchSharedValue(desired[kind]),
          },
        ];
      });
      const pending = allPending.filter((item) => item.event.org === org);
      const eventFiles = pending.map((item) => ({
        path: item.remotePath,
        content: item.content,
      }));
      const files = [...configFiles, ...eventFiles];
      const conflicts = resolutions
        .filter((resolution) => resolution.conflict)
        .map((resolution) => resolution.kind);

      if (!token) {
        const metadata = await writeWorkbenchSharedSyncMetadata(
          {
            lastSyncAt: new Date().toISOString(),
            lastCommit: read.head,
            lastCommitUrl: WORKBENCH_SHARED_REPO_URL + "/commit/" + read.head,
          },
          root,
        );
        return json(
          await statusPayload(org, root, {
            ...metadata,
            remoteHead: read.head,
            remoteUsername: read.username,
            pulled,
            published: [],
            conflicts,
            pendingConfigs: configFiles.length,
            readOnly: true,
            message:
              files.length === 0
                ? "Shared state is current (public read-only mode)."
                : "Remote changes were pulled; a write-enabled HF token is required to publish local changes.",
          }),
        );
      }

      if (files.length === 0) {
        const metadata = await writeWorkbenchSharedSyncMetadata(
          {
            lastSyncAt: new Date().toISOString(),
            lastCommit: read.head,
            lastCommitUrl: WORKBENCH_SHARED_REPO_URL + "/commit/" + read.head,
          },
          root,
        );
        return json(
          await statusPayload(org, root, {
            ...metadata,
            remoteHead: read.head,
            remoteUsername: read.username,
            pulled,
            published: [],
            conflicts,
            pendingConfigs: 0,
            readOnly: false,
            message: "Shared state is already up to date.",
          }),
        );
      }

      try {
        const committed = await runWorkbenchSharedHub(
          {
            action: "commit",
            repoId: WORKBENCH_SHARED_REPO_ID,
            expectedHead: read.head,
            message: "sync(workbench): update " + org + " shared state",
            files,
          },
          token,
        );
        if (committed.action !== "commit") {
          throw new Error("Unexpected Hugging Face commit response.");
        }
        await markWorkbenchSharedEventsSent(pending, root);
        const metadata = await writeWorkbenchSharedSyncMetadata(
          {
            lastSyncAt: new Date().toISOString(),
            lastCommit: committed.commit || read.head,
            lastCommitUrl:
              committed.commitUrl ||
              WORKBENCH_SHARED_REPO_URL +
                "/commit/" +
                (committed.commit || read.head),
          },
          root,
        );
        return json(
          await statusPayload(org, root, {
            ...metadata,
            remoteHead: committed.commit || read.head,
            remoteUsername: committed.username,
            pulled,
            published: configFiles.map((file) => file.path),
            publishedEvents: pending.length,
            conflicts,
            pendingConfigs: 0,
            readOnly: false,
            message:
              "Shared state synchronized: " +
              String(configFiles.length) +
              " config file(s), " +
              String(pending.length) +
              " event(s) published.",
          }),
        );
      } catch (error: unknown) {
        if (error instanceof WorkbenchSharedHubConflictError) {
          lastConflict = error;
          continue;
        }
        throw error;
      }
    }

    throw (
      lastConflict ??
      new Error("The shared repository changed repeatedly during sync.")
    );
  } catch (error: unknown) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to synchronize Workbench shared state.",
      },
      error instanceof WorkbenchSharedHubConflictError ? 409 : 502,
    );
  }
}
