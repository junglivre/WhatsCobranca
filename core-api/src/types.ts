import type { Prisma } from '@prisma/client';

export type Tx = Prisma.TransactionClient;
export type JsonRecord = Record<string, unknown>;

export const normalize = (value: string) =>
  value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
export const isNo = (value: string) => /^(nao|não|cancelar)$/i.test(value.trim());
export const isYes = (value: string) => /^(sim|confirmo|ok)$/i.test(value.trim());

export function parseMoney(input: string): number | null {
  const value = input.trim().replace(/^R\$\s*/i, '').trim();
  if (!/^\d+(?:,\d{1,2})?$/.test(value)) return null;

  const [whole, fraction = ''] = value.split(',');
  const cents = Number(`${whole}${fraction.padEnd(2, '0')}`);
  return Number.isSafeInteger(cents) && cents <= 2_147_483_647 ? cents : null;
}

export const formatMoney = (cents: number | null) =>
  cents === null ? 'não informado' : `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

// Quantidades usam numeric(12,3) no banco e STRING no Node (node-postgres).
// Nenhuma aritmética em Float: parse restrito, formatação por string.
export const parseQuantity = (input: string): string | null => {
  const value = input.trim().replace(',', '.');
  if (!/^\d{1,9}(?:\.\d{1,3})?$/.test(value)) return null;
  const normalized = value.replace(/(\.\d{1,3})$/, (m) => m).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  const numeric = Number(normalized);
  return numeric > 0 && numeric <= 999999999.999 ? normalized : null;
};

export const formatQty = (value: string | number | null): string => {
  if (value === null) return '—';
  const fixed = typeof value === 'number' ? value.toFixed(3) : String(value);
  const [whole, dec = ''] = fixed.split('.');
  const trimmedDec = dec.replace(/0+$/, '');
  return `${whole}${trimmedDec ? ',' + trimmedDec : ''}`;
};

export const osLabel = (number: number) => `OS ${String(number).padStart(6, '0')}`;
