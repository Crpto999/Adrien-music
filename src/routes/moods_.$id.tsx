import { useCallback } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { FeedView } from "@/components/shared/feed-view";
import { fetchMoodCategoryFeedPage } from "@/lib/innertube/explore";
import { useT } from "@/lib/i18n";

export const Route = createFileRoute("/moods_/$id")({
  component: MoodsCategoryPage,
  // The category tile carries an opaque `params` token (→ `p`) that we
  // pair with its browseId on the next browse call, plus the tile's
  // display title (→ `t`) so the page header matches what the user
  // clicked. Stashing both in the URL keeps the page reload-safe.
  validateSearch: (search: Record<string, unknown>) => ({
    p: typeof search.p === "string" ? search.p : "",
    t: typeof search.t === "string" ? search.t : "",
  }),
});

function MoodsCategoryPage() {
  const t = useT();
  const { id } = Route.useParams();
  const { p, t: title } = Route.useSearch();

  const fetcher = useCallback(
    (cursor?: string) => fetchMoodCategoryFeedPage(id, p, cursor),
    [id, p],
  );

  return (
    <FeedView
      title={title || t("nav.category")}
      queryKey={["mood-category", id, p]}
      fetcher={fetcher}
      errorLabel={t("explore.couldNotLoadCategory")}
    />
  );
}
