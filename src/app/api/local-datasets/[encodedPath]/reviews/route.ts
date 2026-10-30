import { NextRequest } from "next/server";
import { resolveDatasetRoot } from "@/lib/local-dataset-paths";
import {
  readEpisodeReviews,
  readReviewCollection,
  reviewDatasetKey,
  reviewsFilePath,
  updateEpisodeReview,
  ReviewStoreError,
} from "@/lib/episode-reviews-store";
import {
  readReviewerProfiles,
  resolveReviewBrowsePath,
} from "@/lib/episode-review-scope";
import { parseReviewUpdate } from "@/types/episode-review.types";
import { BROWSE_PATH_COOKIE } from "@/utils/browsePath";
import { ReviewWriteLockError } from "@/lib/review-write-lock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ encodedPath: string }> };
const headers = { "Cache-Control": "no-store" };

function failure(error: unknown): Response {
  const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
  return Response.json(
    {
      error:
        error instanceof Error
          ? error.message
          : "Failed to access episode reviews",
    },
    {
      status:
        error instanceof ReviewStoreError ||
        error instanceof ReviewWriteLockError
          ? error.status
          : missing
            ? 404
            : 500,
    },
  );
}

async function scope(req: NextRequest, ctx: Context) {
  const root = resolveDatasetRoot((await ctx.params).encodedPath);
  if (!root) throw new ReviewStoreError("Invalid dataset path", 400);
  const browsePath = await resolveReviewBrowsePath(
    req.nextUrl.searchParams.get("browsePath") ??
      req.cookies.get(BROWSE_PATH_COOKIE)?.value,
  );
  const key = await reviewDatasetKey(browsePath, root);
  return { root, browsePath, key };
}

export async function GET(req: NextRequest, ctx: Context): Promise<Response> {
  try {
    const { root, browsePath, key } = await scope(req, ctx);
    if (req.nextUrl.searchParams.get("download") === "1")
      return Response.json(await readReviewCollection(browsePath), {
        headers: {
          ...headers,
          "Content-Disposition": 'attachment; filename="episode-reviews.json"',
        },
      });
    const profiles = await readReviewerProfiles(browsePath);
    return Response.json(
      {
        profiles,
        file: await readEpisodeReviews(browsePath, root),
        reviewers: profiles.map((profile) => profile.name),
        storage_path: reviewsFilePath(browsePath),
        dataset_key: key,
      },
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(req: NextRequest, ctx: Context): Promise<Response> {
  let update;
  try {
    update = parseReviewUpdate(await req.json());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid JSON body" },
      { status: 400 },
    );
  }
  try {
    const { root, browsePath } = await scope(req, ctx);
    const profile = (await readReviewerProfiles(browsePath)).find(
      (entry) => entry.name === update.reviewer,
    );
    if (!profile)
      throw new ReviewStoreError(
        "Select a preset inspector from the dropdown",
        400,
      );
    return Response.json(
      await updateEpisodeReview(browsePath, root, {
        ...update,
        role: profile.role,
      }),
      {
        headers,
      },
    );
  } catch (error) {
    return failure(error);
  }
}
