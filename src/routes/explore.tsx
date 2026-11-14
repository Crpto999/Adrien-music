import { useCallback } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  IconMoodSmile,
  IconSparkles,
  IconTrendingUp,
  type TablerIcon,
} from "@tabler/icons-react";
import { ArtworkOutline } from "@/components/shared/artwork-outline";
import { FeedView } from "@/components/shared/feed-view";
import { fetchExploreFeedPage } from "@/lib/innertube/explore";
import { useT } from "@/lib/i18n";

export const Route = createFileRoute("/explore")({
  component: ExplorePage,
});

const SUBPAGES: {
  to: "/charts" | "/new-releases" | "/moods";
  labelKey: string;
  blurbKey: string;
  icon: TablerIcon;
  // Tailwind gradient classes — kept inline so each tile has its own
  // distinct accent without a theme-wide token.
  gradient: string;
}[] = [
  {
    to: "/charts",
    labelKey: "nav.charts",
    blurbKey: "explore.chartsBlurb",
    icon: IconTrendingUp,
    gradient: "bg-gradient-to-br from-[#170D35] to-[#560157]",
  },
  {
    to: "/new-releases",
    labelKey: "nav.newReleases",
    blurbKey: "explore.newReleasesBlurb",
    icon: IconSparkles,
    // This tile's wash follows the theme's accent rather than a fixed
    // red, so it is red on the light ground and green on the dark one.
    gradient:
      "bg-[linear-gradient(140deg,var(--tile-accent-from),var(--tile-accent-to))]",
  },
  {
    to: "/moods",
    labelKey: "nav.moods",
    blurbKey: "explore.moodsBlurb",
    icon: IconMoodSmile,
    gradient: "bg-gradient-to-br from-[#03112E] to-[#263A7D]",
  },
];

function ExplorePage() {
  const t = useT();
  // The Explore feed has a top "grid of nav buttons" shelf that points
  // back at /charts, /new-releases, /moods — exactly what the hero tiles
  // below the title already cover. Strip those grid shelves so we don't
  // render the same three links twice.
  const fetcher = useCallback(async (cursor?: string) => {
    const page = await fetchExploreFeedPage(cursor);
    return {
      ...page,
      shelves: page.shelves.filter((s) => s.display !== "grid"),
    };
  }, []);

  return (
    <FeedView
      title={t("nav.explore")}
      queryKey={["explore", "v1"]}
      fetcher={fetcher}
      errorLabel={t("explore.couldNotLoad")}
      header={
        <div className="@container">
          <div className="grid gap-3 grid-cols-1 @[50rem]:grid-cols-3">
            {SUBPAGES.map(({ to, labelKey, blurbKey, icon: Icon, gradient }) => (
              <Link
                key={to}
                to={to}
                className={`group relative overflow-hidden rounded-xl ${gradient} px-5 py-4 transition-transform hover:scale-[1.01] active:scale-[0.99]`}
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xl leading-none font-semibold text-white">
                      {t(labelKey)}
                    </span>
                    <span className="text-sm leading-none text-white/70">
                      {t(blurbKey)}
                    </span>
                  </div>
                <div className="relative size-12 shrink-0">
                  <div className="flex size-full items-center justify-center rounded-full bg-white/10 transition-colors group-hover:bg-white/15">
                    <Icon className="size-6 text-white" />
                  </div>
                  <ArtworkOutline className="rounded-full" />
                </div>
              </div>
              <ArtworkOutline className="rounded-xl" />
            </Link>
          ))}
          </div>
        </div>
      }
    />
  );
}
