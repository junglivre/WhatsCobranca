#!/usr/bin/env node
// Leitor mínimo e deliberadamente literal para arquivos .env do Compose. Não
// executa conteúdo como shell: $, crases e substituições permanecem dados.
import { readFileSync } from 'node:fs';

const [file, key] = process.argv.slice(2);
if (!file || !key || !/^[A-Z][A-Z0-9_]*$/.test(key)) process.exit(2);
const text = readFileSync(file, 'utf8');
for (const line of text.split(/\r?\n/)) {
  if (!line || /^\s*#/.test(line)) continue;
  const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
  if (!match || match[1] !== key) continue;
  let value = match[2];
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
  process.stdout.write(value);
  process.exit(0);
}
process.exit(1);
