import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from './db';
import { forChunks } from './db/chunked';
import { mbSubmission } from './db/schema';
import { normalizeEditId, submissionHistoryBy } from './musicbrainz-manual-submissions';
import {
  parseEvidence,
  type SubmissionDraft,
  type SubmissionEvidence,
  type SubmissionKind,
  type SubmissionOutcome,
} from './submission-evidence';

export type LedgerRow = {
  id: number;
  kind: SubmissionKind;
  targetMbid: string | null;
  subject: string;
  value: string | null;
  outcome: SubmissionOutcome;
  editId: string | null;
  submittedBy: string;
  submittedAt: Date;
  note: string | null;
  evidence: SubmissionEvidence;
};

export async function readLedger(where: SQL | undefined): Promise<LedgerRow[]> {
  const rows = await db
    .select({
      id: mbSubmission.id,
      kind: mbSubmission.kind,
      targetMbid: mbSubmission.targetMbid,
      subject: mbSubmission.subject,
      value: mbSubmission.value,
      outcome: mbSubmission.outcome,
      editId: mbSubmission.editId,
      submittedBy: mbSubmission.submittedBy,
      submittedAt: mbSubmission.submittedAt,
      note: mbSubmission.note,
      evidence: mbSubmission.evidence,
    })
    .from(mbSubmission)
    .where(where)
    .orderBy(asc(mbSubmission.id));
  return rows.map((row) => ({ ...row, evidence: parseEvidence(row.kind, row.evidence) }));
}

export type LedgerHistory = { current: LedgerRow | null; previous: LedgerRow | null };

export async function ledgerIndex(
  kind: SubmissionKind,
  column: 'targetMbid' | 'subject' | 'value',
  keys: readonly string[],
  keyOf: (row: LedgerRow) => string | null = (row) => row[column],
): Promise<Map<string, LedgerHistory>> {
  const rows = await forChunks(keys, (chunk) =>
    readLedger(and(eq(mbSubmission.kind, kind), inArray(mbSubmission[column], chunk))),
  );
  return submissionHistoryBy(rows, keyOf);
}

// One multi-row insert: a part-way failure would leave edits made but unrecorded, and they'd be
// submitted again.
export async function insertSubmissions(
  drafts: readonly (SubmissionDraft & { note?: string | null })[],
  options: { submittedBy: string; note?: string | null; editId?: string | null },
): Promise<void> {
  if (drafts.length === 0) return;
  const note = options.note?.trim() || null;
  const editId = normalizeEditId(options.editId);
  await db
    .insert(mbSubmission)
    .values(
      drafts.map((draft) => ({
        kind: draft.kind,
        targetMbid: draft.targetMbid,
        subject: draft.subject,
        value: draft.value,
        evidence: draft.evidence,
        submittedBy: options.submittedBy,
        note: draft.note ?? note,
        editId,
      })),
    )
    .onConflictDoNothing();
}
