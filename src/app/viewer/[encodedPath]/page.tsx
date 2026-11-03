import { redirect } from "next/navigation";

export default async function LocalDatasetRootPage({
  params,
}: {
  params: Promise<{ encodedPath: string }>;
}) {
  const { encodedPath } = await params;
  const episodeN =
    process.env.EPISODES?.split(/\s+/)
      .map((x) => parseInt(x.trim(), 10))
      .filter((x) => !isNaN(x))[0] ?? 0;

  redirect(`/_local/${encodedPath}/episode_${episodeN}`);
}
