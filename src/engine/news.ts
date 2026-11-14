import type { CountryId, NewsItem, RegionId, WorldState } from "../../contracts/types.ts";
import { getHallOfFame } from "../social/culture.ts";

export function addNewsItem(
  state: WorldState,
  scope: "region" | "country" | "world",
  targetId: string | null,
  text: string
): NewsItem {
  const item: NewsItem = {
    id: `n${state.nextIds.news++}`,
    day: state.day,
    scope,
    targetId,
    text,
  };
  state.news.push(item);
  return item;
}

export function generateEndOfDayNews(state: WorldState): void {
  // Top 3 culture works by likes (map-wide headline if any works have likes)
  const topWorks = getHallOfFame(state, 3).filter((w) => w.likes.length > 0);
  if (topWorks.length > 0) {
    const summary = topWorks
      .map((w) => `"${w.text.slice(0, 40)}${w.text.length > 40 ? "..." : ""}" by ${w.authorName} (${w.likes.length} likes)`)
      .join("; ");
    addNewsItem(state, "world", null, `Top cultural works in Aldoria: ${summary}.`);
  }
}

export function getNewsForAgent(
  state: WorldState,
  regionId: RegionId,
  countryId: CountryId,
  day: number
): NewsItem[] {
  const targetDay = day === 0 ? 0 : day - 1;
  return state.news.filter((n) => {
    if (n.day !== targetDay && n.day !== day) return false;
    if (n.scope === "world") return true;
    if (n.scope === "country" && n.targetId === countryId) return true;
    if (n.scope === "region" && n.targetId === regionId) return true;
    return false;
  });
}
