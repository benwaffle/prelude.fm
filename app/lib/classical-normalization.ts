export function normalizeCatalogSystem(value: string) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[.\s]/g, '').toLowerCase();
}

export function normalizeCatalogNumber(value: string) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').replace(/\s+/g, '').toLowerCase();
}

export function normalizeMetadataText(value: string | null | undefined) {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\p{Pd}/gu, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}
