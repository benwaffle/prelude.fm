/**
 * The submission ledger, `mb_submission`: what we told MusicBrainz, read and
 * written in one place.
 *
 * A row is written when somebody confirms an edit (or the bot makes one) and
 * closed when the cache shows it landed (`submission-kinds`). Evidence is
 * parsed once here, so nothing downstream probes the JSON.
 */
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

/** Ledger rows matching `where`, oldest first, evidence parsed. */
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

/**
 * One kind's ledger for the given keys, as the submission in hand and the
 * latest rejected or withdrawn one per key. `keyOf` names the key when it is
 * not the column read (an ISRC is keyed by recording and code together).
 */
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

/**
 * Write confirmed or accepted edits, in one statement.
 *
 * One multi-row insert rather than a row at a time: once MusicBrainz has an
 * edit, a failure part-way through would leave edits made but never
 * recorded, and an unrecorded gap is offered (and, by the bot, submitted)
 * again. The unique index skips an edit already in hand. A draft's own note
 * wins over the shared one.
 */
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
