import { buildExtractionPrompt } from './groq-prompt.js';
import type { Config } from './config.js';

// Falhas classificadas: REJECTED não se cura com retry (pedido malformado,
// modelo rejeitado) e vira fallback determinístico; TRANSIENT (rede/5xx)
// volta para a fila da inbox com retry limitado.
export class GroqFailure extends Error {
  constructor(message: string, readonly outcome: 'REJECTED' | 'TRANSIENT') {
    super(message);
    this.name = 'GroqFailure';
  }
}

async function postJson(cfg: Config, path: string, body: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${cfg.GROQ_BASE_URL.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.GROQ_API_KEY}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new GroqFailure(`GROQ_HTTP_${response.status}`, response.status < 500 ? 'REJECTED' : 'TRANSIENT');
    }
    let parsedBody: unknown;
    try {
      parsedBody = await response.json();
    } catch {
      // Provider respondeu 200 mas com corpo inutilizável: retry não cura.
      throw new GroqFailure('GROQ_MALFORMED_BODY', 'REJECTED');
    }
    return parsedBody;
  } catch (error) {
    if (error instanceof GroqFailure) throw error;
    throw new GroqFailure(error instanceof Error ? error.name : 'GROQ_NETWORK_ERROR', 'TRANSIENT');
  } finally {
    clearTimeout(timer);
  }
}

export async function transcribeAudio(cfg: Config, audio: Buffer, filename: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    // Groq faz sniffing pela EXTENSÃO do filename no multipart: notas de voz do
    // WhatsApp chegam como .oga, que não está na lista aceita (ogg/opus estão).
    const uploadName = filename.replace(/\.oga$/i, '.ogg');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)]), uploadName);
    form.append('model', cfg.GROQ_STT_MODEL);
    form.append('temperature', '0');
    form.append('response_format', 'json');
    const response = await fetch(`${cfg.GROQ_BASE_URL.replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { authorization: `Bearer ${cfg.GROQ_API_KEY}` },
      body: form,
    });
    if (!response.ok) {
      throw new GroqFailure(`GROQ_STT_HTTP_${response.status}`, response.status < 500 ? 'REJECTED' : 'TRANSIENT');
    }
    let parsed: { text?: unknown };
    try {
      parsed = await response.json() as { text?: unknown };
    } catch {
      throw new GroqFailure('GROQ_STT_MALFORMED_BODY', 'REJECTED');
    }
    if (typeof parsed.text !== 'string') {
      throw new GroqFailure('GROQ_STT_MALFORMED', 'REJECTED');
    }
    return parsed.text;
  } catch (error) {
    if (error instanceof GroqFailure) throw error;
    throw new GroqFailure(error instanceof Error ? error.name : 'GROQ_STT_NETWORK_ERROR', 'TRANSIENT');
  } finally {
    clearTimeout(timer);
  }
}

export type ExtractionMaterial = { name: string; quantity: number };
export type Extraction = {
  intent: 'REGISTRAR_SERVICO' | 'OUTRO';
  customerName: string | null;
  serviceDescription: string | null;
  serviceAmount: number | null;
  materialsAmount: number | null;
  dueDate: string | null;
  materials: ExtractionMaterial[];
};

function parseExtractionMaterials(value: unknown): ExtractionMaterial[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new GroqFailure('GROQ_LLM_HALLUCINATED_FIELD', 'REJECTED');
  const materials: ExtractionMaterial[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) throw new GroqFailure('GROQ_LLM_HALLUCINATED_FIELD', 'REJECTED');
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const quantity = typeof record.quantity === 'number' ? record.quantity : Number.NaN;
    // Material malformado invalida a extração inteira (mesma regra do due_date).
    if (name.length === 0 || !Number.isFinite(quantity) || quantity <= 0 || quantity > 999999999.999) {
      throw new GroqFailure('GROQ_LLM_HALLUCINATED_FIELD', 'REJECTED');
    }
    materials.push({ name, quantity });
  }
  return materials;
}

function parseExtraction(value: unknown): Extraction {
  if (typeof value !== 'object' || value === null) throw new GroqFailure('GROQ_LLM_MALFORMED', 'REJECTED');
  const record = value as Record<string, unknown>;
  const intent = record.intent === 'REGISTRAR_SERVICO' ? 'REGISTRAR_SERVICO' : 'OUTRO';
  const text = (key: string): string | null =>
    typeof record[key] === 'string' && (record[key] as string).trim().length > 0
      ? (record[key] as string).trim()
      : null;
  const amount = (key: string): number | null => {
    const raw = record[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 21_474_836.47) return null;
    return raw;
  };
  const dueDate = typeof record.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.due_date)
    && !Number.isNaN(Date.parse(record.due_date))
    ? record.due_date
    : null;
  // due_date presente mas malformado ("amanha") = modelo violou o formato
  // obrigatório: a extração inteira não é confiável → fallback determinístico.
  if (record.due_date !== null && record.due_date !== undefined && dueDate === null) {
    throw new GroqFailure('GROQ_LLM_HALLUCINATED_FIELD', 'REJECTED');
  }
  return {
    intent,
    customerName: text('customer_name'),
    serviceDescription: text('service_description'),
    serviceAmount: amount('service_amount'),
    materialsAmount: amount('materials_amount'),
    dueDate,
    materials: parseExtractionMaterials(record.materials),
  };
}

export async function extractServiceIntent(cfg: Config, transcription: string): Promise<Extraction> {
  const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const payload = {
    model: cfg.GROQ_LLM_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' as const },
    messages: [
      { role: 'system' as const, content: buildExtractionPrompt(todayIso) },
      { role: 'user' as const, content: transcription },
    ],
  };
  const response = await postJson(cfg, '/chat/completions', payload) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new GroqFailure('GROQ_LLM_MALFORMED', 'REJECTED');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new GroqFailure('GROQ_LLM_BAD_JSON', 'REJECTED');
  }
  return parseExtraction(parsed);
}
