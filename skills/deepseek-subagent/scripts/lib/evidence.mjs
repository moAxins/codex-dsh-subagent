import { readFile } from 'node:fs/promises';

export const EVIDENCE_SCHEMA_VERSION = 1;
export const EVIDENCE_KINDS = ['fact', 'citation', 'image'];
export const NOT_REQUIRED = 'not_required';
export const MISSING = 'missing';
export const INVALID = 'invalid';
export const READY = 'ready';

const absoluteHttp = /^https?:\/\/[^\s]+$/i;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/**
 * Read evidenceRequirements from a task packet.
 * Defaults to not required when the field is absent.
 */
export function requirements(packet) {
  const raw = packet?.evidenceRequirements;
  if (raw === undefined || raw === null) return { required: false, kinds: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Task field evidenceRequirements must be an object.');
  if (raw.required !== undefined && typeof raw.required !== 'boolean') throw new Error('Task field evidenceRequirements.required must be a boolean.');
  const required = raw.required === true;
  if (raw.kinds === undefined) return { required, kinds: required ? [...EVIDENCE_KINDS] : [] };
  if (!Array.isArray(raw.kinds) || !raw.kinds.every(kind => EVIDENCE_KINDS.includes(kind))) {
    throw new Error(`Task field evidenceRequirements.kinds must be an array from ${EVIDENCE_KINDS.join(', ')}.`);
  }
  return { required, kinds: [...raw.kinds] };
}

/**
 * Validate one evidence item against schema version 1.
 * Returns an array of human-readable problems; empty means valid.
 */
export function validateItem(item) {
  const errors = [];
  if (!item || typeof item !== 'object' || Array.isArray(item)) return ['item must be an object'];
  if (!isNonEmptyString(item.id)) errors.push('item.id must be a non-empty string');
  if (!EVIDENCE_KINDS.includes(item.kind)) errors.push(`item.kind must be one of ${EVIDENCE_KINDS.join(', ')}`);
  if (typeof item.selected !== 'boolean') errors.push('item.selected must be a boolean');
  if (!isStringArray(item.useLocations)) errors.push('item.useLocations must be an array of strings');
  if (!isNonEmptyString(item.claim)) errors.push('item.claim must be a non-empty string');
  if (typeof item.sourceUrl !== 'string' || !absoluteHttp.test(item.sourceUrl)) errors.push('item.sourceUrl must be an absolute http(s) URL');
  if (!isNonEmptyString(item.publisher)) errors.push('item.publisher must be a non-empty string');
  if (item.publishedAt !== null && !isNonEmptyString(item.publishedAt)) errors.push('item.publishedAt must be a non-empty string or null');
  if (!isNonEmptyString(item.verificationNotes)) errors.push('item.verificationNotes must be a non-empty string');
  if (!isStringArray(item.uncertainties)) errors.push('item.uncertainties must be an array of strings');
  if (item.selected === true && !(Array.isArray(item.useLocations) && item.useLocations.length > 0)) {
    errors.push('a selected item requires at least one useLocation');
  }
  if (item.kind === 'image') {
    if (typeof item.imageUrl !== 'string' || !absoluteHttp.test(item.imageUrl)) errors.push('image item.imageUrl must be an absolute http(s) URL');
    if (item.caption !== null && !isNonEmptyString(item.caption)) errors.push('image item.caption must be a non-empty string or null');
  }
  return errors;
}

/**
 * Validate a parsed evidence file object against schema version 1.
 * Returns { items, errors } where errors is empty for a ready file.
 */
export function validateParsed(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { items: [], errors: ['evidence file must be a JSON object with "version": 1 and an "items" array'] };
  }
  const errors = [];
  if (parsed.version !== EVIDENCE_SCHEMA_VERSION) errors.push(`evidence file version must be ${EVIDENCE_SCHEMA_VERSION}`);
  if (!Array.isArray(parsed.items)) errors.push('evidence file items must be an array');
  if (errors.length > 0) return { items: [], errors };

  const items = parsed.items;
  const ids = new Set();
  for (const [index, item] of items.entries()) {
    for (const problem of validateItem(item)) errors.push(`items[${index}].${problem}`);
    if (item && typeof item === 'object' && isNonEmptyString(item.id)) {
      if (ids.has(item.id)) errors.push(`items[${index}].id "${item.id}" is duplicated`);
      ids.add(item.id);
    }
  }
  return { items, errors };
}

/**
 * Read and validate the per-job evidence file.
 * status is missing, invalid, or ready. parsed items are returned when valid.
 */
export async function readEvidence(file, requiredKinds = []) {
  let content;
  try {
    content = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { status: MISSING, schemaVersion: null, items: [], errors: [] };
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return { status: INVALID, schemaVersion: null, items: [], errors: [`evidence file is not valid JSON: ${error.message}`] };
  }
  const { items, errors } = validateParsed(parsed);
  if (errors.length === 0) {
    for (const kind of requiredKinds) {
      if (!items.some(item => item.kind === kind)) errors.push(`evidence file is missing required kind "${kind}"`);
    }
  }
  return {
    status: errors.length ? INVALID : READY,
    schemaVersion: parsed?.version ?? null,
    items: errors.length ? [] : items,
    errors,
  };
}
