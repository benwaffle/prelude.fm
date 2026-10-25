// Picks the classical part of a MusicBrainz dump and writes it, in our `mb_*` tables' own shape,
// to a local SQLite file that `sync` then copies into Turso.
//
// Classical starts from composers: anyone MusicBrainz catalogues (BWV, K., Op. series) plus our own
// composer list. Their works and the works' parts are the index; a recording is classical when it
// performs one of them, and every release carrying such a recording comes in whole, so release
// positions line up with Spotify's track list. Rows are derived with the same functions the web
// service path uses (`composerOf`, `cataloguesOf`, ...), so both paths store the same thing.
import type { DatabaseSync } from 'node:sqlite';
import { normalizeIsrc } from '@/lib/isrc';
import { cataloguesOf, composerOf, imslpUrlOf, parentPartOf } from '@/lib/musicbrainz';
import { splitCatalogueReference } from '@/lib/musicbrainz-catalogue';
import type { MbRelation, MbWork } from '@/lib/musicbrainz-source';
import CLASSICAL_COMPOSERS from '@/lib/classical-composers.json';
import { field, intField, partialDate, rawRows } from './tsv';

type Log = (message: string) => void;

/** The `mb_*` tables this import owns rows in, in the order they are written. */
export const DUMP_TABLES = [
  'mb_artist',
  'mb_work',
  'mb_work_catalogue',
  'mb_recording',
  'mb_recording_isrc',
  'mb_recording_work',
  'mb_recording_credit',
  'mb_release',
  'mb_release_url',
  'mb_release_track',
] as const;

const SPOTIFY_ARTIST = /^https?:\/\/open\.spotify\.com\/artist\/([A-Za-z0-9]+)\/?$/;

/** Grows to the largest id seen; MusicBrainz ids are dense integers. */
class IntColumn {
  private data = new Int32Array(1 << 20);
  set(id: number, value: number) {
    if (id >= this.data.length) {
      let size = this.data.length;
      while (size <= id) size *= 2;
      const grown = new Int32Array(size);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[id] = value;
  }
  get(id: number): number {
    return id < this.data.length ? this.data[id] : 0;
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

type LinkType = { gid: string; name: string; entity0: string; entity1: string };
type ArtistWorkRel = { artist: number; type: string; attributes: string[]; order: number };

export type SelectOptions = {
  dumpDir: string;
  out: DatabaseSync;
  /** Spotify artists we hold, preferred when MusicBrainz links an artist to several. */
  heldSpotifyArtists: Set<string>;
  /** Unix ms stamped on `fetched_at`, so one import is one point in time. */
  fetchedAt: number;
  log: Log;
};

export async function selectClassical(options: SelectOptions) {
  const { dumpDir: dir, out, log } = options;
  const time = () => `${Math.round(process.uptime())}s`;

  // ---- vocabularies -------------------------------------------------------------------------
  const linkTypes = new Map<number, LinkType>();
  for await (const row of rawRows(dir, 'link_type')) {
    linkTypes.set(Number(row[0]), {
      gid: row[3],
      name: field(row, 6)!,
      entity0: row[4],
      entity1: row[5],
    });
  }
  const attributeNames = new Map<number, string>();
  for await (const row of rawRows(dir, 'link_attribute_type')) {
    attributeNames.set(Number(row[0]), field(row, 5)!);
  }
  const namesOf = async (table: string) => {
    const names = new Map<number, string>();
    for await (const row of rawRows(dir, table)) names.set(Number(row[0]), field(row, 1)!);
    return names;
  };
  const [workTypes, artistTypes, seriesTypes] = await Promise.all([
    namesOf('work_type'),
    namesOf('artist_type'),
    namesOf('series_type'),
  ]);

  const typeIdsFor = (entity0: string, entity1: string) =>
    new Set(
      [...linkTypes]
        .filter(([, type]) => type.entity0 === entity0 && type.entity1 === entity1)
        .map(([id]) => id),
    );
  const pairOf = new Map<number, string>(
    [...linkTypes].map(([id, type]) => [id, `${type.entity0}-${type.entity1}`]),
  );

  // ---- links: type, ended, dates (dates only where we store them) ---------------------------
  const linkType = new IntColumn();
  const linkEnded = new Set<number>();
  const releaseUrlTypes = typeIdsFor('release', 'url');
  const linkDates = new Map<number, { begin: string | null; end: string | null }>();
  for await (const row of rawRows(dir, 'link')) {
    const id = Number(row[0]);
    const type = Number(row[1]);
    linkType.set(id, type);
    if (row[10] === 't') linkEnded.add(id);
    if (releaseUrlTypes.has(type)) {
      const begin = partialDate(intField(row, 2), intField(row, 3), intField(row, 4));
      const end = partialDate(intField(row, 5), intField(row, 6), intField(row, 7));
      if (begin || end) linkDates.set(id, { begin, end });
    }
  }
  log(`${time()} links read`);

  const keepAttributesFor = new Set(['artist-work', 'artist-recording', 'release-url']);
  const linkAttributes = new Map<number, string[]>();
  for await (const row of rawRows(dir, 'link_attribute')) {
    const link = Number(row[0]);
    if (!keepAttributesFor.has(pairOf.get(linkType.get(link)) ?? '')) continue;
    push(linkAttributes, link, attributeNames.get(Number(row[1])) ?? '');
  }
  for (const names of linkAttributes.values()) names.sort();
  const numberAttribute = [...attributeNames].find(([, name]) => name === 'number')?.[0];
  const linkNumber = new Map<number, string>();
  for await (const row of rawRows(dir, 'link_attribute_text_value')) {
    if (Number(row[1]) === numberAttribute) linkNumber.set(Number(row[0]), field(row, 2)!);
  }
  log(`${time()} link attributes read`);

  // ---- works and what we need to derive their rows -------------------------------------------
  const catalogueType = [...seriesTypes].find(([, name]) => name === 'Catalogue')?.[0];
  const catalogueSeries = new Map<number, { gid: string; name: string }>();
  for await (const row of rawRows(dir, 'series')) {
    if (intField(row, 4) === catalogueType) {
      catalogueSeries.set(Number(row[0]), { gid: row[1], name: field(row, 2)! });
    }
  }
  const seriesOf = new Map<number, { series: number; number: string }[]>();
  for await (const row of rawRows(dir, 'l_series_work')) {
    const series = Number(row[2]);
    const number = linkNumber.get(Number(row[1]));
    if (catalogueSeries.has(series) && number !== undefined) {
      push(seriesOf, Number(row[3]), { series, number });
    }
  }

  const works = new Map<number, { gid: string; title: string; type: string | null }>();
  for await (const row of rawRows(dir, 'work')) {
    const type = intField(row, 3);
    works.set(Number(row[0]), {
      gid: row[1],
      title: field(row, 2)!,
      type: type === null ? null : (workTypes.get(type) ?? null),
    });
  }
  log(`${time()} ${works.size} works read`);

  const artistWork = new Map<number, ArtistWorkRel[]>();
  for await (const row of rawRows(dir, 'l_artist_work')) {
    const link = Number(row[1]);
    const type = linkTypes.get(linkType.get(link))?.name;
    if (type !== 'composer' && type !== 'arranger') continue;
    push(artistWork, Number(row[3]), {
      artist: Number(row[2]),
      type,
      attributes: linkAttributes.get(link) ?? [],
      order: Number(row[6]) * 1e9 + Number(row[0]),
    });
  }
  for (const rels of artistWork.values()) rels.sort((a, b) => a.order - b.order);

  const parentsOf = new Map<number, { parent: number; order: number; id: number }[]>();
  const childrenOf = new Map<number, number[]>();
  const arrangements = new Set<number>();
  for await (const row of rawRows(dir, 'l_work_work')) {
    const type = linkTypes.get(linkType.get(Number(row[1])))?.name;
    const [entity0, entity1] = [Number(row[2]), Number(row[3])];
    if (type === 'parts') {
      push(parentsOf, entity1, { parent: entity0, order: Number(row[6]), id: Number(row[0]) });
      push(childrenOf, entity0, entity1);
    } else if (type === 'arrangement') {
      // entity1 is the arrangement ("arrangement of" entity0).
      arrangements.add(entity1);
    }
  }
  for (const parents of parentsOf.values()) parents.sort((a, b) => a.id - b.id);

  const urlsOfWork = new Map<number, number[]>();
  for await (const row of rawRows(dir, 'l_url_work')) {
    if (!linkEnded.has(Number(row[1]))) push(urlsOfWork, Number(row[3]), Number(row[2]));
  }
  log(`${time()} work relationships read`);

  // MbWork as the web service would return it, with internal ids for artists and works: the
  // derivation functions only compare ids. URL resources are filled in after the url pass.
  const workUrls = new Map<number, string>();
  const asMbWork = (id: number): MbWork => {
    const work = works.get(id)!;
    const relations: MbRelation[] = [];
    for (const rel of artistWork.get(id) ?? []) {
      relations.push({
        type: rel.type,
        direction: 'backward',
        artist: { id: String(rel.artist), name: '' },
        attributes: rel.attributes,
      });
    }
    if (arrangements.has(id)) relations.push({ type: 'arrangement', direction: 'backward' });
    for (const parent of parentsOf.get(id) ?? []) {
      const parentWork = works.get(parent.parent);
      if (!parentWork) continue;
      relations.push({
        type: 'parts',
        direction: 'backward',
        work: { id: String(parent.parent), title: parentWork.title },
        ...(parent.order > 0 ? { 'ordering-key': parent.order } : {}),
      });
    }
    for (const entry of seriesOf.get(id) ?? []) {
      const series = catalogueSeries.get(entry.series)!;
      relations.push({
        type: 'part of',
        direction: 'backward',
        series: { id: series.gid, name: series.name, type: 'Catalogue' },
        'attribute-values': { number: entry.number },
      });
    }
    const url = workUrls.get(id);
    if (url) relations.push({ type: 'url', direction: 'forward', url: { resource: url } });
    return { id: String(id), title: work.title, type: work.type, relations };
  };
  const composerIdOf = (id: number) => {
    const composer = composerOf(asMbWork(id));
    return composer ? Number(composer.id) : null;
  };

  // ---- artists' Spotify links, for our own composer list -------------------------------------
  const artistUrls = new Map<number, number[]>();
  for await (const row of rawRows(dir, 'l_artist_url')) {
    if (!linkEnded.has(Number(row[1]))) push(artistUrls, Number(row[2]), Number(row[3]));
  }
  const spotifyUrlArtists = new Map<number, number[]>();
  for (const [artist, urls] of artistUrls)
    for (const url of urls) push(spotifyUrlArtists, url, artist);
  const spotifyIdsOf = new Map<number, string[]>();
  for await (const row of rawRows(dir, 'url')) {
    const artists = spotifyUrlArtists.get(Number(row[0]));
    if (!artists) continue;
    const match = SPOTIFY_ARTIST.exec(field(row, 2)!);
    if (match) for (const artist of artists) push(spotifyIdsOf, artist, match[1]);
  }
  spotifyUrlArtists.clear();
  log(`${time()} artist Spotify links read`);

  // ---- the index: composers, then their works ------------------------------------------------
  const listed = new Set(Object.keys(CLASSICAL_COMPOSERS));
  const composers = new Set<number>();
  let listedComposers = 0;
  for (const [artist, ids] of spotifyIdsOf) {
    if (ids.some((id) => listed.has(id))) {
      composers.add(artist);
      listedComposers++;
    }
  }
  for (const work of seriesOf.keys()) {
    const composer = composerIdOf(work);
    if (composer !== null) composers.add(composer);
  }
  log(`${time()} ${composers.size} classical composers (${listedComposers} from our list)`);

  const indexWorks = new Set<number>();
  for (const work of artistWork.keys()) {
    const composer = composerIdOf(work);
    if (composer !== null && composers.has(composer)) indexWorks.add(work);
  }
  // Parts often carry no composer of their own; the whole tree comes with the work, and so do
  // the works it is a part of.
  const pending = [...indexWorks];
  while (pending.length > 0) {
    const work = pending.pop()!;
    for (const related of [
      ...(childrenOf.get(work) ?? []),
      ...(parentsOf.get(work) ?? []).map((parent) => parent.parent),
    ]) {
      if (!indexWorks.has(related) && works.has(related)) {
        indexWorks.add(related);
        pending.push(related);
      }
    }
  }
  log(`${time()} ${indexWorks.size} works in the index`);

  // ---- recordings that perform them, and the releases carrying those -------------------------
  const isPerformance = (link: number) => linkTypes.get(linkType.get(link))?.name === 'performance';
  const classicalRecordings = new Set<number>();
  for await (const row of rawRows(dir, 'l_recording_work')) {
    if (isPerformance(Number(row[1])) && indexWorks.has(Number(row[3]))) {
      classicalRecordings.add(Number(row[2]));
    }
  }
  log(`${time()} ${classicalRecordings.size} recordings perform them`);

  const classicalMedia = new Set<number>();
  for await (const row of rawRows(dir, 'track')) {
    if (classicalRecordings.has(Number(row[2]))) classicalMedia.add(Number(row[3]));
  }
  const releases = new Set<number>();
  for await (const row of rawRows(dir, 'medium')) {
    if (classicalMedia.has(Number(row[0]))) releases.add(Number(row[1]));
  }
  classicalMedia.clear();
  const media = new Map<number, { release: number; position: number }>();
  for await (const row of rawRows(dir, 'medium')) {
    const release = Number(row[1]);
    if (releases.has(release)) media.set(Number(row[0]), { release, position: Number(row[2]) });
  }
  log(`${time()} ${releases.size} releases, ${media.size} media`);

  // ---- staging: integer ids, joined to MBIDs in SQL at the end -------------------------------
  out.exec(`
    create temp table s_track (release integer, medium integer, position integer, recording integer,
      title text, length integer, primary key (release, medium, position)) without rowid;
    create temp table s_recording (id integer primary key, gid text);
    create temp table s_release (id integer primary key, gid text);
    create temp table s_artist (id integer primary key, gid text);
    create temp table s_work (id integer primary key, gid text);
    create temp table s_recording_work (recording integer, work integer, primary key (recording, work)) without rowid;
    create temp table s_credit (recording integer, artist integer, role text, instrument text,
      primary key (recording, artist, role, instrument)) without rowid;
  `);
  const insert = (sql: string) => out.prepare(sql);
  const transaction = async (run: () => Promise<void>) => {
    out.exec('begin');
    try {
      await run();
      out.exec('commit');
    } catch (error) {
      out.exec('rollback');
      throw error;
    }
  };

  const allRecordings = new Set<number>();
  await transaction(async () => {
    const track = insert('insert or ignore into s_track values (?, ?, ?, ?, ?, ?)');
    for await (const row of rawRows(dir, 'track')) {
      const medium = media.get(Number(row[3]));
      if (!medium) continue;
      const recording = Number(row[2]);
      allRecordings.add(recording);
      track.run(
        medium.release,
        medium.position,
        Number(row[4]),
        recording,
        field(row, 6),
        intField(row, 8),
      );
    }
  });
  media.clear();
  log(`${time()} ${allRecordings.size} recordings on those releases`);

  const performedWorks = new Set<number>();
  await transaction(async () => {
    const link = insert('insert or ignore into s_recording_work values (?, ?)');
    for await (const row of rawRows(dir, 'l_recording_work')) {
      const recording = Number(row[2]);
      if (!allRecordings.has(recording) || !isPerformance(Number(row[1]))) continue;
      const work = Number(row[3]);
      if (!works.has(work)) continue;
      link.run(recording, work);
      performedWorks.add(work);
    }
  });
  // A medley's other work, or a non-classical track on a classical release: stored like any work
  // a cached release names, so a performance never points at a work we lack.
  for (const work of performedWorks) indexWorks.add(work);
  performedWorks.clear();

  const artists = new Set<number>(composers);
  await transaction(async () => {
    const credit = insert('insert or ignore into s_credit values (?, ?, ?, ?)');
    for await (const row of rawRows(dir, 'l_artist_recording')) {
      const recording = Number(row[3]);
      if (!allRecordings.has(recording)) continue;
      const link = Number(row[1]);
      const role = linkTypes.get(linkType.get(link))?.name;
      if (!role) continue;
      const artist = Number(row[2]);
      artists.add(artist);
      // As the web service path reads it: the attribute is an instrument only on these types.
      const instrument =
        role === 'instrument' || role === 'vocal' ? (linkAttributes.get(link)?.[0] ?? '') : '';
      credit.run(recording, artist, role, instrument);
    }
  });
  log(`${time()} credits read, ${artists.size} artists`);

  const releaseUrls: { release: number; url: number; link: number }[] = [];
  for await (const row of rawRows(dir, 'l_release_url')) {
    const release = Number(row[2]);
    if (releases.has(release)) {
      releaseUrls.push({ release, url: Number(row[3]), link: Number(row[1]) });
    }
  }

  // ---- url pass: release links, IMSLP pages -------------------------------------------------
  const wantedUrls = new Map<number, string>();
  for (const entry of releaseUrls) wantedUrls.set(entry.url, '');
  for (const work of indexWorks)
    for (const url of urlsOfWork.get(work) ?? []) wantedUrls.set(url, '');
  for await (const row of rawRows(dir, 'url')) {
    const id = Number(row[0]);
    if (wantedUrls.has(id)) wantedUrls.set(id, field(row, 2)!);
  }
  for (const work of indexWorks) {
    const imslp = (urlsOfWork.get(work) ?? [])
      .map((url) => wantedUrls.get(url) ?? '')
      .find((url) => /^https?:\/\/imslp\.org\//.test(url));
    if (imslp) workUrls.set(work, imslp);
  }
  log(`${time()} urls read`);

  // ---- write ---------------------------------------------------------------------------------
  const fetchedAt = options.fetchedAt;
  const workGid = (id: number) => works.get(id)?.gid ?? null;

  await transaction(async () => {
    const stage = insert('insert into s_work values (?, ?)');
    const work = insert(
      `insert into mb_work (mbid, title, type, parent_mbid, ordering_key, composer_mbid, imslp_url,
        detail, fetched_at) values (?, ?, ?, ?, ?, ?, ?, 'full', ?)`,
    );
    const catalogue = insert(
      `insert or ignore into mb_work_catalogue (work_mbid, series_mbid, system, number,
        normalized_system, normalized_number) values (?, ?, ?, ?, ?, ?)`,
    );
    const composerOfWork = new Map<number, number>();
    for (const id of indexWorks) {
      const data = works.get(id)!;
      const mbWork = asMbWork(id);
      const parent = parentPartOf(mbWork);
      const composer = composerOf(mbWork);
      if (composer) {
        composerOfWork.set(id, Number(composer.id));
        artists.add(Number(composer.id));
      }
      stage.run(id, data.gid);
      work.run(
        data.gid,
        data.title,
        data.type,
        parent ? workGid(Number(parent.id)) : null,
        parent?.orderingKey ?? null,
        null, // composer MBID, filled from s_artist below
        imslpUrlOf(mbWork),
        fetchedAt,
      );
      for (const reference of cataloguesOf(mbWork)) {
        const split = splitCatalogueReference(reference.system, reference.number);
        if (!split) continue;
        catalogue.run(
          data.gid,
          reference.seriesId,
          split.system,
          split.number,
          split.normalizedSystem,
          split.normalizedNumber,
        );
      }
    }
    out.exec('create temp table s_work_composer (work integer primary key, artist integer)');
    const workComposer = insert('insert into s_work_composer values (?, ?)');
    for (const [work, artist] of composerOfWork) workComposer.run(work, artist);
  });
  log(`${time()} works written`);

  await transaction(async () => {
    const stage = insert('insert into s_recording values (?, ?)');
    const recording = insert(
      `insert into mb_recording (mbid, title, length, detail, fetched_at)
        values (?, ?, ?, 'full', ?)`,
    );
    for await (const row of rawRows(dir, 'recording')) {
      const id = Number(row[0]);
      if (!allRecordings.has(id)) continue;
      stage.run(id, row[1]);
      recording.run(row[1], field(row, 2), intField(row, 4), fetchedAt);
    }
    const isrc = insert(
      `insert or ignore into mb_recording_isrc (isrc, recording_mbid)
        select ?, gid from s_recording where id = ?`,
    );
    for await (const row of rawRows(dir, 'isrc')) {
      const id = Number(row[1]);
      if (allRecordings.has(id)) isrc.run(normalizeIsrc(field(row, 2)!), id);
    }
  });
  allRecordings.clear();
  log(`${time()} recordings written`);

  // Release date and country: the earliest release event, as the web service reports them.
  const events = new Map<number, { date: string; country: number | null }>();
  const keepEarliest = (release: number, date: string | null, country: number | null) => {
    if (!date) {
      if (!events.has(release)) events.set(release, { date: '', country });
      return;
    }
    const current = events.get(release);
    if (!current || !current.date || date < current.date) events.set(release, { date, country });
  };
  for await (const row of rawRows(dir, 'release_country')) {
    const release = Number(row[0]);
    if (releases.has(release)) {
      keepEarliest(
        release,
        partialDate(intField(row, 2), intField(row, 3), intField(row, 4)),
        Number(row[1]),
      );
    }
  }
  for await (const row of rawRows(dir, 'release_unknown_country')) {
    const release = Number(row[0]);
    if (releases.has(release)) {
      keepEarliest(
        release,
        partialDate(intField(row, 1), intField(row, 2), intField(row, 3)),
        null,
      );
    }
  }
  const countryCodes = new Map<number, string>();
  for await (const row of rawRows(dir, 'iso_3166_1')) {
    if (!countryCodes.has(Number(row[0]))) countryCodes.set(Number(row[0]), row[1]);
  }

  await transaction(async () => {
    const stage = insert('insert into s_release values (?, ?)');
    const release = insert(
      `insert into mb_release (mbid, title, barcode, date, country, url_relations_fetched_at,
        fetched_at) values (?, ?, ?, ?, ?, ?, ?)`,
    );
    for await (const row of rawRows(dir, 'release')) {
      const id = Number(row[0]);
      if (!releases.has(id)) continue;
      const event = events.get(id);
      const country = event?.country;
      stage.run(id, row[1]);
      release.run(
        row[1],
        field(row, 2),
        field(row, 9) || null,
        event?.date || null,
        country === null || country === undefined ? null : (countryCodes.get(country) ?? null),
        fetchedAt,
        fetchedAt,
      );
    }
  });
  events.clear();
  log(`${time()} releases written`);

  // ---- artists -------------------------------------------------------------------------------
  await transaction(async () => {
    const stage = insert('insert into s_artist values (?, ?)');
    const artist = insert(
      `insert into mb_artist (mbid, name, sort_name, type, begin_year, end_year,
        spotify_artist_id, links_read_at, fetched_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for await (const row of rawRows(dir, 'artist')) {
      const id = Number(row[0]);
      if (!artists.has(id)) continue;
      const type = intField(row, 10);
      const linked = spotifyIdsOf.get(id) ?? [];
      stage.run(id, row[1]);
      artist.run(
        row[1],
        field(row, 2),
        field(row, 3),
        type === null ? null : (artistTypes.get(type) ?? null),
        intField(row, 4),
        intField(row, 7),
        linked.find((spotifyId) => options.heldSpotifyArtists.has(spotifyId)) ?? linked[0] ?? null,
        fetchedAt,
        fetchedAt,
      );
    }
  });
  log(`${time()} ${artists.size} artists written`);

  out.exec(`
    create index s_work_gid on s_work (gid);
    update mb_work set composer_mbid = (
      select a.gid from s_work w join s_work_composer c on c.work = w.id
        join s_artist a on a.id = c.artist where w.gid = mb_work.mbid);
    insert into mb_recording_work (recording_mbid, work_mbid)
      select r.gid, w.gid from s_recording_work l
        join s_recording r on r.id = l.recording join s_work w on w.id = l.work;
    insert into mb_recording_credit (recording_mbid, artist_mbid, role, instrument)
      select r.gid, a.gid, c.role, c.instrument from s_credit c
        join s_recording r on r.id = c.recording join s_artist a on a.id = c.artist;
    insert into mb_release_track (release_mbid, medium, position, recording_mbid, title, length)
      select rl.gid, t.medium, t.position, r.gid, t.title, t.length from s_track t
        join s_release rl on rl.id = t.release join s_recording r on r.id = t.recording;
  `);
  await transaction(async () => {
    const url = insert(
      `insert or ignore into mb_release_url (release_mbid, url, relationship_type,
        relationship_type_id, ended, begin, "end", attributes)
        select gid, ?, ?, ?, ?, ?, ?, ? from s_release where id = ?`,
    );
    for (const entry of releaseUrls) {
      const type = linkTypes.get(linkType.get(entry.link));
      const resource = wantedUrls.get(entry.url);
      if (!type || !resource) continue;
      const dates = linkDates.get(entry.link);
      url.run(
        resource,
        type.name,
        type.gid,
        linkEnded.has(entry.link) ? 1 : 0,
        dates?.begin ?? null,
        dates?.end ?? null,
        JSON.stringify(linkAttributes.get(entry.link) ?? []),
        entry.release,
      );
    }
  });
  log(`${time()} relationships written`);

  return {
    composers: composers.size,
    listedComposers,
    works: indexWorks.size,
    classicalRecordings: classicalRecordings.size,
    releases: releases.size,
    artists: artists.size,
  };
}
