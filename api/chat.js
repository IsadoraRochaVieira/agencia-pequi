const WINDOW_MS = 60_000;
const MAX_REQUESTS = 12;
const visitors = new Map();

function getClientId(request) {
  return String(request.headers['x-forwarded-for'] || request.socket?.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
}

function isRateLimited(clientId) {
  const now = Date.now();
  const recent = (visitors.get(clientId) || []).filter(time => now - time < WINDOW_MS);
  recent.push(now);
  visitors.set(clientId, recent);
  return recent.length > MAX_REQUESTS;
}

function cleanText(value, max = 320) {
  return String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

function parseJsonContent(content) {
  const cleaned = String(content || '').replace(/```json|```/gi, '').trim();
  const parsed = JSON.parse(cleaned);
  return {
    title: cleanText(parsed.title, 70),
    text: cleanText(parsed.text, 700)
  };
}

async function requestGroq(messages, maxCompletionTokens = 260) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature: 0.82,
      max_completion_tokens: maxCompletionTokens
    }),
    signal: AbortSignal.timeout(12_000)
  });

  if (!response.ok) throw new Error(`Groq ${response.status}`);
  const data = await response.json();
  return data?.choices?.[0]?.message?.content || '';
}

export default async function handler(request, response) {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');

  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'Método não permitido.' });
  }

  if (!process.env.GROQ_API_KEY) {
    return response.status(503).json({ error: 'A IA está aguardando configuração.' });
  }

  if (isRateLimited(getClientId(request))) {
    return response.status(429).json({ error: 'Muitas mensagens. Aguarde um minuto.' });
  }

  try {
    const mode = request.body?.mode === 'chat' ? 'chat' : 'concept';

    if (mode === 'concept') {
      const idea = cleanText(request.body?.idea, 300);
      if (idea.length < 4) return response.status(400).json({ error: 'Descreva melhor a ideia.' });

      const content = await requestGroq([
        {
          role: 'system',
          content: 'Você é diretor criativo da Agência Pequi, um estúdio brasileiro de design, tecnologia, motion e IA. Responda apenas em JSON válido com title (máximo 4 palavras) e text (máximo 65 palavras). Crie um conceito original de marca e um primeiro movimento concreto. Português brasileiro, inteligente, sensorial e sem clichês.'
        },
        { role: 'user', content: idea }
      ], 240);

      const concept = parseJsonContent(content);
      if (!concept.title || !concept.text) throw new Error('Resposta incompleta');
      return response.status(200).json(concept);
    }

    const history = Array.isArray(request.body?.history) ? request.body.history.slice(-8) : [];
    const messages = history
      .map(item => ({
        role: item?.role === 'assistant' ? 'assistant' : 'user',
        content: cleanText(item?.content, 320)
      }))
      .filter(item => item.content);

    if (!messages.length) return response.status(400).json({ error: 'Escreva uma mensagem.' });

    const content = await requestGroq([
      {
        role: 'system',
        content: 'Você é a Pequi IA, concierge da Agência Pequi. Responda em português brasileiro com personalidade, simpatia e objetividade, em até 3 frases. A agência cria experiências digitais, sites, produtos, direção de arte, motion design, branding e soluções com IA. Os cases são Caryo Map e Esporte Brasília. Para orçamento ou reunião, convide a pessoa a chamar no WhatsApp (61) 99273-9117. Não invente preços, prazos, clientes ou resultados.'
      },
      ...messages
    ], 220);

    return response.status(200).json({ reply: cleanText(content, 900) });
  } catch (error) {
    console.error('Pequi AI error:', error?.message || error);
    return response.status(502).json({ error: 'A IA ficou sem sinal por um instante.' });
  }
}
