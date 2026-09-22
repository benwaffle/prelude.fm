'use client';

import { useState } from 'react';
import {
  recordWorkCreationSubmission,
  recordWorkRelationshipSubmission,
  recheckCreatedWork,
  recheckWorkRelationship,
  type ContributionView,
} from '../actions/contribute';
import { MbPicker } from '../components/MbPicker';
import type { InboxClass } from '../lib/admin-url';
import { mbWorkPickHit } from '@/lib/musicbrainz-pick';
import { ConfirmDisclosure } from './ConfirmDisclosure';
import { InboxRow } from './InboxRow';
import { InboxSection } from './InboxSection';
import { LoadMoreRows } from './LoadMoreRows';

export function WorkRelationshipsSection({
  rows,
  total,
  activeClass,
  onReload,
  onLoadMore,
}: {
  rows: ContributionView['workGaps'];
  total: number;
  activeClass?: InboxClass;
  onReload: () => Promise<void>;
  onLoadMore: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [relationshipForms, setRelationshipForms] = useState<Record<string, { editId: string }>>(
    {},
  );
  const [createForms, setCreateForms] = useState<
    Record<string, { workMbid: string; editId: string }>
  >({});

  async function confirmRelationship(recordingMbid: string, workMbid: string) {
    const key = `${recordingMbid}:${workMbid}`;
    setBusy(true);
    try {
      await recordWorkRelationshipSubmission(
        recordingMbid,
        workMbid,
        relationshipForms[key] ?? { editId: '' },
      );
      await onReload();
    } finally {
      setBusy(false);
    }
  }

  async function recheckRelationship(recordingMbid: string, workMbid: string) {
    setBusy(true);
    try {
      await recheckWorkRelationship(recordingMbid, workMbid);
      await onReload();
    } finally {
      setBusy(false);
    }
  }

  async function confirmCreation(recordingMbid: string) {
    const form = createForms[recordingMbid] ?? { workMbid: '', editId: '' };
    setBusy(true);
    try {
      await recordWorkCreationSubmission(recordingMbid, form.workMbid, {
        editId: form.editId,
      });
      await onReload();
    } finally {
      setBusy(false);
    }
  }

  async function recheckWork(workMbid: string) {
    setBusy(true);
    try {
      await recheckCreatedWork(workMbid);
      await onReload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <InboxSection
      inboxClass="work"
      activeClass={activeClass}
      title="Recordings with no work relationship"
      channel="HAND"
      total={total}
      shown={rows.length}
      description="Candidates come from cached MusicBrainz identities or exact catalogue evidence. They are possibilities, not inferred relationships."
    >
      {rows.map((gap) => {
        const created = gap.ledger.find((row) => row.kind === 'work');
        const createForm = createForms[gap.recordingMbid] ?? { workMbid: '', editId: '' };
        const hits = gap.candidates.map(mbWorkPickHit);
        const candidatesByMbid = new Map(
          gap.candidates.map((candidate) => [candidate.workMbid, candidate]),
        );
        const seed =
          gap.proposals
            .flatMap((proposal) => [
              proposal.title,
              ...proposal.catalogues.map((catalogue) => `${catalogue.system} ${catalogue.number}`),
            ])
            .filter(Boolean)
            .join(' · ') || gap.recordingTitle;

        return (
          <ConfirmDisclosure
            key={gap.recordingMbid}
            data-inbox-album={gap.albumId}
            evidence={
              <span className="min-w-0">
                <span className="block truncate">{gap.recordingTitle}</span>
                <span className="album-meta">
                  {gap.albumTitle} · {gap.candidates.length} MusicBrainz candidate
                  {gap.candidates.length === 1 ? '' : 's'}
                  {gap.ledger.length > 0 &&
                    ` · ${gap.ledger.length} recorded${gap.ledger.some((row) => !row.editId) ? ', edit ID missing' : ''}`}
                </span>
              </span>
            }
            links={
              <>
                <a className="act" href={gap.recordingEdit} target="_blank" rel="noreferrer">
                  MusicBrainz
                </a>
                <a className="act" href={gap.workCreate} target="_blank" rel="noreferrer">
                  Create work
                </a>
              </>
            }
            label={gap.candidates.length > 0 ? 'Pick…' : 'Confirm…'}
            disabled={busy}
          >
            <MbPicker
              seed={seed}
              hits={hits}
              busy={busy}
              pickNote="Confirming a candidate records only the relationship you submitted. Opening a work writes nothing."
              renderHitActions={(hit) => {
                const candidate = candidatesByMbid.get(hit.mbid);
                if (!candidate) return null;
                const recorded = gap.ledger.find(
                  (row) => row.kind === 'work_relationship' && row.workMbid === candidate.workMbid,
                );
                if (recorded) {
                  return (
                    <>
                      <span className="album-meta shrink-0">
                        {candidate.evidence.join(', ')} · {recorded.label}
                      </span>
                      <button
                        className="act shrink-0"
                        disabled={busy}
                        onClick={() => recheckRelationship(gap.recordingMbid, candidate.workMbid)}
                      >
                        Recheck
                      </button>
                    </>
                  );
                }
                const key = `${gap.recordingMbid}:${candidate.workMbid}`;
                const form = relationshipForms[key] ?? { editId: '' };
                return (
                  <>
                    <span className="album-meta shrink-0">{candidate.evidence.join(', ')}</span>
                    <input
                      className="mono w-36 shrink-0"
                      placeholder="edit ID (optional)"
                      value={form.editId}
                      onChange={(event) =>
                        setRelationshipForms((current) => ({
                          ...current,
                          [key]: { editId: event.target.value },
                        }))
                      }
                    />
                    <button
                      className="act shrink-0"
                      data-variant="primary"
                      disabled={busy}
                      onClick={() => confirmRelationship(gap.recordingMbid, candidate.workMbid)}
                    >
                      Confirm link
                    </button>
                  </>
                );
              }}
            />

            <div className="mt-4 border-t border-[var(--rule)] pt-3">
              {gap.proposals.map((proposal) => (
                <div key={proposal.localWorkId} className="mb-3 border-l border-[var(--gall)] pl-3">
                  <div className="text-[11px] text-[var(--gall)]">
                    Proposal only — legacy parser/manual evidence, not MusicBrainz fact
                  </div>
                  <div>
                    <span className="text-[var(--faint)]">Title: </span>
                    <code className="select-all">{proposal.title}</code>
                  </div>
                  <div>
                    <span className="text-[var(--faint)]">Type: </span>
                    {proposal.type ? (
                      <code className="select-all">{proposal.type}</code>
                    ) : (
                      <span className="absent">missing</span>
                    )}
                  </div>
                  <div>
                    <span className="text-[var(--faint)]">Composer: </span>
                    <code className="select-all">{proposal.composerName}</code>
                    {proposal.composerMbid ? (
                      <a
                        className="mono ml-2 text-[11px]"
                        href={`https://musicbrainz.org/artist/${proposal.composerMbid}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        MusicBrainz
                      </a>
                    ) : (
                      <span className="absent ml-2">MusicBrainz identity missing</span>
                    )}
                  </div>
                  <div>
                    <span className="text-[var(--faint)]">Catalogue: </span>
                    {proposal.catalogues.length > 0 ? (
                      <code className="select-all">
                        {proposal.catalogues
                          .map((catalogue) => `${catalogue.system} ${catalogue.number}`)
                          .join(', ')}
                      </code>
                    ) : (
                      <span className="absent">missing</span>
                    )}
                  </div>
                </div>
              ))}
              {gap.proposals.length === 0 && (
                <p className="mb-3 absent">No local proposal evidence exists for this recording.</p>
              )}

              {created ? (
                <InboxRow
                  evidence={
                    <span>
                      <a
                        href={`https://musicbrainz.org/work/${created.workMbid}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {created.workMbid}
                      </a>
                      <span className="album-meta">{created.label}</span>
                    </span>
                  }
                  action={
                    <button
                      className="act"
                      disabled={busy || !created.workMbid}
                      onClick={() => created.workMbid && recheckWork(created.workMbid)}
                    >
                      Recheck
                    </button>
                  }
                />
              ) : (
                <div className="toolbar px-0">
                  <input
                    className="mono min-w-52 flex-1"
                    placeholder="new work MBID"
                    value={createForm.workMbid}
                    onChange={(event) =>
                      setCreateForms((current) => ({
                        ...current,
                        [gap.recordingMbid]: {
                          ...createForm,
                          workMbid: event.target.value,
                        },
                      }))
                    }
                  />
                  <input
                    className="mono w-36"
                    placeholder="edit ID (optional)"
                    value={createForm.editId}
                    onChange={(event) =>
                      setCreateForms((current) => ({
                        ...current,
                        [gap.recordingMbid]: {
                          ...createForm,
                          editId: event.target.value,
                        },
                      }))
                    }
                  />
                  <button
                    className="act"
                    data-variant="primary"
                    disabled={busy || createForm.workMbid.trim() === ''}
                    onClick={() => confirmCreation(gap.recordingMbid)}
                  >
                    Confirm created work
                  </button>
                </div>
              )}
            </div>
          </ConfirmDisclosure>
        );
      })}
      <LoadMoreRows shown={rows.length} total={total} busy={busy} onMore={onLoadMore} />
    </InboxSection>
  );
}
