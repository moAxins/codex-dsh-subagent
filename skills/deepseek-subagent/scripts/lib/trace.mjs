import { MAX_CORRECTIONS } from './policy.mjs';

/**
 * Observable ACP session updates the controller records verbatim. A valid
 * Harness turn may emit any subset of these, so trace completeness never
 * depends on every kind appearing.
 */
export const OBSERVABLE_UPDATES = [
  'plan',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'agent_message_chunk',
  'usage_update',
];

export function updateKind(update) {
  const kind = update?.sessionUpdate;
  return OBSERVABLE_UPDATES.includes(kind) ? kind : undefined;
}

function emptyCounts() {
  return Object.fromEntries(OBSERVABLE_UPDATES.map(kind => [kind, 0]));
}

/**
 * Deterministic summary of a persisted event snapshot.
 *
 * Completeness is defined by sequence numbers only: records must be unique
 * and contiguous from 1 through `eventSeq`, with no duplicates, gaps, or
 * out-of-order rows. Observable ACP update counts are reported per
 * sessionUpdate kind, and corrections count `prompt_started` records whose
 * correction flag is true.
 */
export function summarize(events, eventSeq) {
  const seqs = [];
  const counts = emptyCounts();
  let correctionCount = 0;
  for (const record of events ?? []) {
    if (Number.isInteger(record?.seq)) seqs.push(record.seq);
    if (record?.type === 'acp_update') {
      const kind = updateKind(record.data);
      if (kind) counts[kind] += 1;
    }
    if (record?.type === 'prompt_started' && record.data?.correction === true) correctionCount += 1;
  }

  const duplicateSeqs = [];
  const seen = new Set();
  for (const seq of seqs) {
    if (seen.has(seq) && !duplicateSeqs.includes(seq)) duplicateSeqs.push(seq);
    seen.add(seq);
  }
  const missingSeqs = [];
  for (let seq = 1; seq <= eventSeq; seq += 1) if (!seen.has(seq)) missingSeqs.push(seq);
  let outOfOrder = false;
  for (let index = 1; index < seqs.length; index += 1) if (seqs[index] < seqs[index - 1]) outOfOrder = true;

  const complete = eventSeq > 0
    && seqs.length === eventSeq
    && duplicateSeqs.length === 0
    && missingSeqs.length === 0
    && !outOfOrder;

  return {
    complete,
    expectedSeq: eventSeq,
    firstSeq: seqs.length ? seqs[0] : null,
    lastSeq: seqs.length ? seqs[seqs.length - 1] : null,
    eventCount: seqs.length,
    duplicateSeqs,
    missingSeqs,
    outOfOrder,
    counts,
    observableEventCount: Object.values(counts).reduce((sum, value) => sum + value, 0),
    corrections: {
      count: correctionCount,
      max: MAX_CORRECTIONS,
      limitReached: correctionCount >= MAX_CORRECTIONS,
    },
  };
}
