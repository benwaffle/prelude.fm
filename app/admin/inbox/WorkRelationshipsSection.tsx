'use client';

import type { ContributionView } from '../actions/inbox-view';
import {
  recheckSubmission,
  recordWorkCreationSubmission,
  recordWorkRelationshipSubmission,
} from '../actions/submissions';
import { MbPicker } from '../components/MbPicker';
import { mbWorkPickHit } from '@/lib/musicbrainz-pick';
import { ConfirmDisclosure } from './ConfirmDisclosure';
import { InboxRow } from './InboxRow';
import { RowActionStatus } from './RowActionStatus';
import { InboxSection } from './InboxSection';
import { LoadMoreRows } from './LoadMoreRows';
import { EditIdInput, useRowForms, useRowMutation } from './LedgerGapRow';
import { WorkProposalsPanel } from './WorkProposalsPanel';

export function WorkRelationshipsSection({
  rows,
  total,
  onReload,
  onLoadMore,
}: {
  rows: ContributionView['workGaps'];
  total: number;
  onReload: () => Promise<void>;
  onLoadMore: () => void;
}) {
  const { pending, busy, row: rowAction, mutate } = useRowMutation(onReload);
  const relationshipForms = useRowForms({ editId: '' });
  const createForms = useRowForms({ workMbid: '', editId: '' });

  return (
    <InboxSection
      inboxClass="work"
      title="Recordings with no work relationship"
      channel="HAND"
      total={total}
      shown={rows.length}
      pending={pending}
      description="Candidates come from sibling recordings on the same cached MusicBrainz release. They are possibilities, not inferred relationships."
    >
      <WorkProposalsPanel onRecorded={onReload} />
      {rows.map((gap) => {
        const { current: created, previous: createdBefore } = gap.createdWork;
        const createForm = createForms.formOf(gap.recordingMbid);
        const hits = gap.candidates.map(mbWorkPickHit);
        const candidatesByMbid = new Map(
          gap.candidates.map((candidate) => [candidate.workMbid, candidate]),
        );
        const seed = gap.recordingTitle;
        const state = rowAction(gap.recordingMbid);

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
                  {gap.recorded > 0 &&
                    ` · ${gap.recorded} recorded${gap.recordedWithoutEditId ? ', edit ID missing' : ''}`}
                  {gap.earlier > 0 && ` · ${gap.earlier} rejected or withdrawn before`}
                </span>
                <RowActionStatus row={state} />
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
          >
            <MbPicker
              seed={seed}
              hits={hits}
              busy={state.busy}
              pickNote="Confirming a candidate records only the relationship you submitted. Opening a work writes nothing."
              renderHitActions={(hit) => {
                const candidate = candidatesByMbid.get(hit.mbid);
                if (!candidate) return null;
                const { current: recorded, previous: before } = gap.links[candidate.workMbid] ?? {
                  current: null,
                  previous: null,
                };
                if (recorded) {
                  return (
                    <>
                      <span className="album-meta shrink-0">
                        {candidate.evidence.join(', ')} · {recorded.label}
                      </span>
                      <button
                        className="act shrink-0"
                        disabled={state.busy}
                        onClick={() =>
                          mutate(gap.recordingMbid, 'Rechecking work relationship…', () =>
                            recheckSubmission({
                              kind: 'work_relationship',
                              recordingMbid: gap.recordingMbid,
                              workMbid: candidate.workMbid,
                            }),
                          )
                        }
                      >
                        Recheck
                      </button>
                    </>
                  );
                }
                const key = `${gap.recordingMbid}:${candidate.workMbid}`;
                const form = relationshipForms.formOf(key);
                return (
                  <>
                    <span className="album-meta shrink-0">
                      {candidate.evidence.join(', ')}
                      {before && ` · ${before.label}`}
                    </span>
                    <EditIdInput
                      className="w-36 shrink-0"
                      value={form.editId}
                      onChange={(editId) => relationshipForms.setForm(key, { editId })}
                    />
                    <button
                      className="act shrink-0"
                      data-variant="primary"
                      disabled={state.busy}
                      onClick={() =>
                        mutate(gap.recordingMbid, 'Confirming work relationship…', () =>
                          recordWorkRelationshipSubmission(
                            gap.recordingMbid,
                            candidate.workMbid,
                            form,
                          ),
                        )
                      }
                    >
                      Confirm link
                    </button>
                  </>
                );
              }}
            />

            <div className="mt-4 border-t border-[var(--rule)] pt-3">
              {gap.candidates.length === 0 && (
                <p className="mb-3 absent">
                  No MusicBrainz work candidate is available for this recording.
                </p>
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
                      disabled={state.busy || !created.workMbid}
                      onClick={() => {
                        const workMbid = created.workMbid;
                        if (!workMbid) return;
                        void mutate(gap.recordingMbid, 'Rechecking created work…', () =>
                          recheckSubmission({ kind: 'work', workMbid }),
                        );
                      }}
                    >
                      Recheck
                    </button>
                  }
                />
              ) : (
                <div className="toolbar px-0">
                  {createdBefore && (
                    <span className="album-meta">
                      created work {createdBefore.workMbid} · {createdBefore.label}
                    </span>
                  )}
                  <input
                    className="mono min-w-52 flex-1"
                    placeholder="new work MBID"
                    value={createForm.workMbid}
                    onChange={(event) =>
                      createForms.setForm(gap.recordingMbid, { workMbid: event.target.value })
                    }
                  />
                  <EditIdInput
                    className="w-36"
                    value={createForm.editId}
                    onChange={(editId) => createForms.setForm(gap.recordingMbid, { editId })}
                  />
                  <button
                    className="act"
                    data-variant="primary"
                    disabled={state.busy || createForm.workMbid.trim() === ''}
                    onClick={() =>
                      mutate(gap.recordingMbid, 'Confirming created work…', () =>
                        recordWorkCreationSubmission(gap.recordingMbid, createForm.workMbid, {
                          editId: createForm.editId,
                        }),
                      )
                    }
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
