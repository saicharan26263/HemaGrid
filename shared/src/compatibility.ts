// Blood compatibility matrix.
// Row = donor type, Column = recipient type. true = can donate to.
// Standard ABO/RhD red-cell compatibility (packed RBC).
import type { BloodGroup } from './types.js';

const M: Record<BloodGroup, Record<BloodGroup, boolean>> = {
  //        O-     O+     A-     A+     B-     B+     AB-    AB+
  'O-':  { 'O-': true, 'O+': true, 'A-': true, 'A+': true, 'B-': true, 'B+': true, 'AB-': true, 'AB+': true },
  'O+':  { 'O-': false,'O+': true, 'A-': false,'A+': true, 'B-': false,'B+': true, 'AB-': false,'AB+': true },
  'A-':  { 'O-': false,'O+': false,'A-': true, 'A+': true, 'B-': false,'B+': false,'AB-': true, 'AB+': true },
  'A+':  { 'O-': false,'O+': false,'A-': false,'A+': true, 'B-': false,'B+': false,'AB-': false,'AB+': true },
  'B-':  { 'O-': false,'O+': false,'A-': false,'A+': false,'B-': true, 'B+': true, 'AB-': true, 'AB+': true },
  'B+':  { 'O-': false,'O+': false,'A-': false,'A+': false,'B-': false,'B+': true, 'AB-': false,'AB+': true },
  'AB-': { 'O-': false,'O+': false,'A-': false,'A+': false,'B-': false,'B+': false,'AB-': true, 'AB+': true },
  'AB+': { 'O-': false,'O+': false,'A-': false,'A+': false,'B-': false,'B+': false,'AB-': false,'AB+': true },
};

export type Compatibility = 'EXACT' | 'COMPATIBLE' | 'UNIVERSAL_DONOR';

/**
 * Determine if `donor` blood type can be given to a patient needing `recipient`.
 */
export function isCompatible(donor: BloodGroup, recipient: BloodGroup): boolean {
  return M[donor][recipient];
}

/**
 * Classify the compatibility relationship between donor and requested type.
 * - EXACT: same type
 * - UNIVERSAL_DONOR: donor is O- (safe for anyone)
 * - COMPATIBLE: otherwise allowed by matrix
 * - null: not compatible
 */
export function classifyCompatibility(donor: BloodGroup, recipient: BloodGroup): Compatibility | null {
  if (donor === recipient) return 'EXACT';
  if (!isCompatible(donor, recipient)) return null;
  if (donor === 'O-') return 'UNIVERSAL_DONOR';
  return 'COMPATIBLE';
}

/**
 * Ordered list of acceptable donor types for a requested recipient type,
 * best (exact) first, then compatible, universal donor (O-) last as fallback.
 */
export function donorPreferenceOrder(recipient: BloodGroup): BloodGroup[] {
  const exact = [recipient];
  const compatible: BloodGroup[] = [];
  for (const d of ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'] as BloodGroup[]) {
    if (d === recipient) continue;
    if (M[d][recipient]) {
      if (d === 'O-') continue; // handle universal donor last separately
      compatible.push(d);
    }
  }
  // stability: append O- universal donor as final fallback
  if (recipient !== 'O-' && M['O-'][recipient]) compatible.push('O-');
  return [...exact, ...compatible];
}

/**
 * Convert a compatibility classification into a sort score (lower = better).
 */
export function compatibilityScore(c: Compatibility): number {
  switch (c) {
    case 'EXACT': return 0;
    case 'COMPATIBLE': return 1;
    case 'UNIVERSAL_DONOR': return 2;
  }
}