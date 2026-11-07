import { createFileRoute } from "@tanstack/react-router";
import { FeedView } from "@/components/shared/feed-view";
import { fetchNewReleasesFeedPage } from "@/lib/innertube/explore";
import { useT } from "@/lib/i18n";

export const Route = createFileRoute("/new-releases")({
  component: NewReleasesPage,
});

function NewReleasesPage() {
  const t = useT();
  return (
    <FeedView
      title={t("nav.newReleases")}
      queryKey={["new-releases", "v1"]}
      fetcher={fetchNewReleasesFeedPage}
      errorLabel={t("explore.couldNotLoadNewReleases")}
    />
  );
}
