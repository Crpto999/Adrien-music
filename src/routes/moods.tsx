import { createFileRoute } from "@tanstack/react-router";
import { FeedView } from "@/components/shared/feed-view";
import { fetchMoodsAndGenresFeedPage } from "@/lib/innertube/explore";
import { useT } from "@/lib/i18n";

export const Route = createFileRoute("/moods")({
  component: MoodsPage,
});

function MoodsPage() {
  const t = useT();
  return (
    <FeedView
      title={t("nav.moods")}
      queryKey={["moods", "v1"]}
      fetcher={fetchMoodsAndGenresFeedPage}
      errorLabel={t("explore.couldNotLoadMoods")}
    />
  );
}
