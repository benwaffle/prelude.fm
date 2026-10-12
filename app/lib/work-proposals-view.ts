// Unchecked gaps and gaps with no proposal both stay listed, so what the matcher couldn't answer
// stays visible.
import type { ProposalConfidence, WorkProposal } from './work-proposals';

export type ProposalStatus = 'proposed' | 'approved' | 'dismissed';

export type ProposalGapInput = {
  recordingMbid: string;
  title: string;
  albumId: string;
  albumTitle: string;
  releaseMbid: string | null;
  medium: number | null;
  position: number | null;
};

export type StoredProposal = {
  recordingMbid: string;
  proposal: WorkProposal | null;
  status: ProposalStatus;
};

export type ProposalRowView = {
  recordingMbid: string;
  title: string;
  medium: number | null;
  position: number | null;
  /** `unchecked`: the matcher has not looked yet; `none`: it looked and found nothing. */
  state: 'unchecked' | 'none' | ProposalStatus;
  proposal: WorkProposal | null;
};

export type ProposalAlbumView = {
  albumId: string;
  albumTitle: string;
  releaseMbid: string | null;
  rows: ProposalRowView[];
};

export type ProposalCounts = Record<ProposalConfidence, number> & {
  none: number;
  unchecked: number;
  approved: number;
  dismissed: number;
};

export function relationshipEditorUrl(releaseMbid: string): string {
  return `https://musicbrainz.org/release/${releaseMbid}/edit-relationships`;
}

/** Recordings whose link is already ledgered are left to the ledger's own rows. */
export function proposalAlbums(
  gaps: readonly ProposalGapInput[],
  stored: readonly StoredProposal[],
  recorded: ReadonlySet<string>,
): { albums: ProposalAlbumView[]; counts: ProposalCounts } {
  const byRecording = new Map(stored.map((row) => [row.recordingMbid, row]));
  const counts: ProposalCounts = {
    high: 0,
    medium: 0,
    low: 0,
    none: 0,
    unchecked: 0,
    approved: 0,
    dismissed: 0,
  };
  const albums = new Map<string, ProposalAlbumView>();
  for (const gap of gaps) {
    if (recorded.has(gap.recordingMbid)) continue;
    const row = byRecording.get(gap.recordingMbid);
    const state: ProposalRowView['state'] = !row
      ? 'unchecked'
      : !row.proposal
        ? 'none'
        : row.status;
    if (state === 'unchecked' || state === 'none') counts[state]++;
    else if (state === 'proposed' && row?.proposal) counts[row.proposal.confidence]++;
    else if (state === 'approved' || state === 'dismissed') counts[state]++;

    const album = albums.get(gap.albumId) ?? {
      albumId: gap.albumId,
      albumTitle: gap.albumTitle,
      releaseMbid: gap.releaseMbid,
      rows: [],
    };
    album.rows.push({
      recordingMbid: gap.recordingMbid,
      title: gap.title,
      medium: gap.medium,
      position: gap.position,
      state,
      proposal: row?.proposal ?? null,
    });
    albums.set(gap.albumId, album);
  }

  const waiting = (album: ProposalAlbumView) =>
    album.rows.filter((row) => row.state === 'proposed' || row.state === 'approved').length;
  const ordered = [...albums.values()];
  for (const album of ordered) {
    album.rows.sort(
      (a, b) =>
        (a.medium ?? Infinity) - (b.medium ?? Infinity) ||
        (a.position ?? Infinity) - (b.position ?? Infinity) ||
        a.title.localeCompare(b.title),
    );
  }
  ordered.sort((a, b) => waiting(b) - waiting(a) || a.albumTitle.localeCompare(b.albumTitle));
  return { albums: ordered, counts };
}
