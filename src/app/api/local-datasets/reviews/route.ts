import { NextRequest } from "next/server";
import { resolveReviewBrowsePath } from "@/lib/episode-review-scope";
import {
  readReviewCollection,
  reviewsFilePath,
  ReviewStoreError,
} from "@/lib/episode-reviews-store";
import { reviewCollectionCsv } from "@/lib/episode-reviews-export";
import { reviewCollectionSummary } from "@/types/episode-review.types";
import { BROWSE_PATH_COOKIE } from "@/utils/browsePath";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const browsePath = await resolveReviewBrowsePath(
      req.nextUrl.searchParams.get("browsePath") ??
        req.cookies.get(BROWSE_PATH_COOKIE)?.value,
    );
    // Only read the small shared record file; never rescan videos/parquet here.
    const collection = await readReviewCollection(browsePath);
    const format = req.nextUrl.searchParams.get("format");
    if (format === "csv")
      return new Response(reviewCollectionCsv(collection), {
        headers: {
          ...headers,
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="episode-reviews.csv"',
        },
      });
    if (format === "json")
      return Response.json(collection, {
        headers: {
          ...headers,
          "Content-Disposition": 'attachment; filename="episode-reviews.json"',
        },
      });
    return Response.json(
      {
        summary: reviewCollectionSummary(collection),
        storage_path: reviewsFilePath(browsePath),
      },
      { headers },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Cannot read inspection records",
      },
      {
        status:
          error instanceof ReviewStoreError
            ? error.status
            : (error as NodeJS.ErrnoException)?.code === "ENOENT"
              ? 404
              : 500,
        headers,
      },
    );
  }
}
