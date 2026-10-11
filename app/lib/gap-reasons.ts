import type { MusicBrainzGapCode } from './musicbrainz-library';

/**
 * What each gap means, in words a reader can act on. Shared by the library's
 * gap strip and the work cards, so a gap reads the same wherever it shows.
 */
export const GAP_REASONS: Record<MusicBrainzGapCode, string> = {
  'provider-track-not-fetched': 'Spotify track not read yet',
  'provider-album-not-fetched': 'Spotify album not read yet',
  'classification-unreviewed': 'Nobody has decided whether this is classical',
  'classification-uncertain': 'MusicBrainz does not settle whether this is classical',
  'classification-not-classical': 'Ruled not classical',
  'release-not-checked': 'Nobody has looked for this album in MusicBrainz',
  'release-missing': 'MusicBrainz has no release for this album',
  'release-ambiguous': 'Several MusicBrainz releases carry this barcode',
  'release-tracklist-misaligned': 'The MusicBrainz tracklist does not line up',
  'release-cache-missing': 'The matched release has not been fetched',
  'release-title-missing': 'The MusicBrainz release has no title',
  'release-date-missing': 'The MusicBrainz release has no date',
  'release-spotify-streaming-url-missing':
    'The MusicBrainz release has no Spotify free-streaming URL',
  'release-track-position-mismatch': 'The release position contradicts the anchor',
  'recording-unanchored': 'No MusicBrainz recording matched this track',
  'recording-anchor-conflict': 'One ISRC names more than one MusicBrainz recording',
  'recording-cache-missing': 'The matched recording has not been fetched',
  'recording-stub': 'Only the recording’s name is known',
  'recording-title-missing': 'The MusicBrainz recording has no title',
  'recording-work-missing': 'MusicBrainz does not relate this recording to a work',
  'work-cache-missing': 'The work has not been fetched',
  'work-stub': 'Only the work’s name is known',
  'work-title-missing': 'The MusicBrainz work has no title',
  'work-type-missing': 'The MusicBrainz work has no type',
  'work-catalogue-missing': 'No catalogue reference on the work or above it',
  'work-composer-missing': 'MusicBrainz does not say who wrote this',
  'composer-cache-missing': 'The composer has not been fetched',
  'composer-name-missing': 'The MusicBrainz composer has no name',
  'work-hierarchy-parent-missing': 'The work’s parent has not been fetched',
  'work-hierarchy-cycle': 'The cached work hierarchy loops',
  'work-level-ambiguous': 'Unclear whether to show this work or the one above it',
  'work-linked-by-us': 'We matched the work ourselves; MusicBrainz does not link it yet',
  'recording-credits-missing': 'MusicBrainz does not say who performed',
  'recording-credit-artist-missing': 'A credited artist has not been fetched',
};
