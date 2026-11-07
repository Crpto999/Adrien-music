import { createFileRoute } from "@tanstack/react-router";
import { FeedView } from "@/components/shared/feed-view";
import { fetchChartsFeedPage } from "@/lib/innertube/explore";
import { useT } from "@/lib/i18n";

export const Route = createFileRoute("/charts")({
  component: ChartsPage,
});

function ChartsPage() {
  const t = useT();
  return (
    <FeedView
      title={t("nav.charts")}
      queryKey={["charts", "v1"]}
      fetcher={fetchChartsFeedPage}
      errorLabel={t("explore.couldNotLoadCharts")}
    />
  );
}
