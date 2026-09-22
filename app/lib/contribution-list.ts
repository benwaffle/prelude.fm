/**
 * How many rows an Inbox section shows at a time.
 *
 * Counts are the real totals. The list is a page. Claiming the total while
 * rendering a 40-row slice is how "202 albums" became forty boxes.
 */
export const CONTRIBUTION_PAGE_SIZE = 40;

export type ContributionListLimits = {
  isrcReleases: number;
  workGaps: number;
  contested: number;
  missing: number;
  barcodes: number;
  streamingUrls: number;
  misaligned: number;
};

export const DEFAULT_CONTRIBUTION_LIMITS: ContributionListLimits = {
  isrcReleases: CONTRIBUTION_PAGE_SIZE,
  workGaps: CONTRIBUTION_PAGE_SIZE,
  contested: CONTRIBUTION_PAGE_SIZE,
  missing: CONTRIBUTION_PAGE_SIZE,
  barcodes: CONTRIBUTION_PAGE_SIZE,
  streamingUrls: CONTRIBUTION_PAGE_SIZE,
  misaligned: CONTRIBUTION_PAGE_SIZE,
};

export function resolveContributionLimits(
  limits?: Partial<ContributionListLimits> | null,
): ContributionListLimits {
  return { ...DEFAULT_CONTRIBUTION_LIMITS, ...limits };
}

export function shownOfTotalLabel(shown: number, total: number): string {
  if (total <= 0) return '0';
  if (shown >= total) return String(total);
  return `showing ${shown} of ${total}`;
}

export function hasMoreToLoad(shown: number, total: number): boolean {
  return shown < total;
}

export function nextListLimit(
  current: number,
  total: number,
  page = CONTRIBUTION_PAGE_SIZE,
): number {
  return Math.min(total, current + page);
}

export function pageSlice<T>(rows: T[], limit: number, offset = 0): T[] {
  return rows.slice(offset, offset + limit);
}
