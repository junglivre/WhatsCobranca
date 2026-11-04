// Prompt versionado da extração estruturada (Fase 4). Determinístico: a única
// parte variável é a data de hoje em America/Sao_Paulo, para o modelo resolver
// referências relativas ("sexta-feira", "amanhã") sem adivinhar o calendário.
export function buildExtractionPrompt(todayIsoDate: string): string {
  return [
    'Você extrai dados de atendimentos técnicos de transcrições de áudio em português brasileiro informal.',
    `A data de hoje é ${todayIsoDate} (fuso America/Sao_Paulo). Use-a para resolver datas relativas.`,
    'Responda SOMENTE um objeto JSON válido, sem texto fora dele, com exatamente estas chaves:',
    '{',
    '  "intent": "REGISTRAR_SERVICO" | "OUTRO",',
    '  "customer_name": string | null,',
    '  "service_description": string | null,',
    '  "service_amount": number | null,',
    '  "materials_amount": number | null,',
    '  "due_date": "YYYY-MM-DD" | null',
    '}',
    'Regras obrigatórias:',
    '- intent é REGISTRAR_SERVICO apenas quando o áudio relata um atendimento/serviço prestado a um cliente. Saudações, perguntas ou qualquer outro assunto são OUTRO.',
    '- NUNCA invente dados: se uma informação não foi dita no áudio, o valor é null.',
    '- customer_name é o nome ou apelido do cliente mencionado (sem títulos como "cliente", "senhor").',
    '- service_description é a descrição curta do serviço executado.',
    '- service_amount e materials_amount são números em reais (ex.: 350.50), apenas quando ditos com clareza ("trezentos e cinquenta reais" = 350). Não inclua materiais no service_amount.',
    '- due_date só quando houver data de vencimento/pagamento dita com clareza; "sexta" resolve para a sexta-feira da semana corrente a partir de hoje.',
    '- Não confirme pagamento, não emita recomendações, não adicione campos extras.',
  ].join('\n');
}
