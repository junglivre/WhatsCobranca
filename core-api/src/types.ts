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

export const osLabel = (number: number) => `OS ${String(number).padStart(6, '0')}`;
