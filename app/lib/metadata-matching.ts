import { normalizeMetadataText } from '@/lib/classical-normalization';

export function titlesAreCompatible(left: string, right: string) {
  const normalizedLeft = normalizeMetadataText(left);
  const normalizedRight = normalizeMetadataText(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (
    normalizedLeft === normalizedRight ||
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  ) {
    return true;
  }
  const leftTokens = new Set(normalizedLeft.split(' ').filter((token) => token.length > 1));
  const rightTokens = new Set(normalizedRight.split(' ').filter((token) => token.length > 1));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / Math.max(leftTokens.size, rightTokens.size) >= 0.6;
}
