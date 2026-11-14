/**
 * Клиент OpenAI-совместимого API.
 * Поддержка streaming (SSE), tool calls, отмены и нормализации ошибок.
 */

/** Убирает пробелы и завершающие слэши: «…/v1/ » и «…/v1у» ловятся отдельно. */
export function normalizeBaseUrl(raw) {
  let b = String(raw || '').trim();
  b = b.replace(/\s+/g, '');
  b = b.replace(/\/+$/, '');
  return b;
}

/** Похоже ли на опечатку в конце адреса (кириллица, лишние буквы после версии). */
export function looksLikeBadUrl(baseUrl) {
  const b = normalizeBaseUrl(baseUrl);
  if (!b) return false;
  // Путь должен заканчиваться на версию (/v1, /v1beta, /openai/v1) или /chat/completions
  if (/\/chat\/completions$/.test(b)) return false;
  const tail = b.split('/').pop() || '';
  if (!tail) return false;
  return !/^(v\d+(beta\d*)?|openai|api|completions|chat)$/i.test(tail) && /[^\x00-\x7F]/.test(tail);
}

/**
 * Собирает поля встроенного поиска из настроек.
 * Возвращает null, если поиск выключен или провайдер неизвестен.
 */
export function buildNativeBody(settings) {
  const s = (settings && settings.search) || {};
  const mode = s.native || 'auto';
  if (mode === 'off') return null;
  if (mode === 'custom') {
    try {
      const parsed = JSON.parse(s.nativeBody || '{}');
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return nativeSearchBody(mode, settings?.provider?.baseUrl);
}

function joinUrl(base, path) {
  const b = normalizeBaseUrl(base);
  if (!b) return path;
  if (/\/chat\/completions$/.test(b)) return b;
  return b + path;
}

/**
 * Сливает дополнительные поля в тело запроса.
 * Массивы (`tools`, `plugins`) объединяются: встроенный поиск не должен
 * затирать обычные инструменты агента.
 */
export function mergeBody(body, extra) {
  const out = { ...body };
  Object.entries(extra || {}).forEach(([k, v]) => {
    if (Array.isArray(v) && Array.isArray(out[k])) out[k] = [...out[k], ...v];
    else if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
      out[k] = { ...out[k], ...v };
    } else out[k] = v;
  });
  return out;
}

/**
 * Встроенный поиск провайдера по адресу API.
 * Возвращает поля тела запроса или null. Неизвестные шлюзы — null: лучше
 * не отправлять ничего, чем сломать запрос незнакомым полем.
 */
export function nativeSearchBody(mode, baseUrl) {
  if (!mode || mode === 'off') return null;
  const host = String(baseUrl || '').toLowerCase();

  if (mode === 'openrouter') return { plugins: [{ id: 'web' }] };
  if (mode === 'openai') return { tools: [{ type: 'web_search_preview' }] };
  // У xAI поле идёт рядом с messages, но тоже в теле запроса.
  if (mode === 'xai') return { search_parameters: { mode: 'auto', return_citations: true } };

  if (mode !== 'auto') return null;
  if (host.includes('openrouter.ai')) return { plugins: [{ id: 'web' }] };
  if (host.includes('api.x.ai')) return { search_parameters: { mode: 'auto', return_citations: true } };
  if (host.includes('api.openai.com')) return { tools: [{ type: 'web_search_preview' }] };
  return null;
}

export function parseExtraHeaders(raw) {
  const out = {};
  String(raw || '')
    .split('\n')
    .forEach((line) => {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k) out[k] = v;
      }
    });
  return out;
}

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function describeError(status, body) {
  let detail = '';
  try {
    const j = typeof body === 'string' ? JSON.parse(body) : body;
    detail = j?.error?.message || j?.message || j?.detail || '';
  } catch {
    detail = typeof body === 'string' ? body.slice(0, 300) : '';
  }
  if (status === 401 || status === 403) return `Ключ не подошёл или доступ запрещён (${status}). ${detail}`.trim();
  if (status === 404) return `URL не найден (404). Проверьте адрес API. ${detail}`.trim();
  if (status === 429) return `Слишком много запросов или закончилась квота (429). ${detail}`.trim();
  if (status >= 500) return `Ошибка на стороне провайдера (${status}). ${detail}`.trim();
  if (detail) return `${detail} (${status})`;
  return `Запрос не удался (${status}).`;
}

/**
 * Потоковый запрос chat/completions.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.apiKey
 * @param {object} opts.extraHeaders
 * @param {string} opts.model
 * @param {Array} opts.messages
 * @param {Array} [opts.tools]
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {string|null} [opts.reasoningEffort]
 * @param {boolean} [opts.stream]
 * @param {AbortSignal} [opts.signal]
 * @param {(delta:string, full:string)=>void} [opts.onText]
 * @param {(delta:string, full:string)=>void} [opts.onReasoning]
 * @param {(call)=>void} [opts.onToolCall]
 */
export async function streamChat(opts) {
  const {
    baseUrl,
    apiKey,
    extraHeaders = {},
    model,
    messages,
    tools,
    temperature,
    maxTokens,
    reasoningEffort,
    stream = true,
    signal,
    /** Дополнительные поля тела запроса (например, встроенный поиск). */
    bodyExtra,
    onText,
    onReasoning,
    onToolCall,
  } = opts;

  const headers = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const body = {
    model,
    messages,
    stream: !!stream,
    temperature,
  };
  if (maxTokens) body.max_tokens = maxTokens;
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  if (looksLikeBadUrl(baseUrl)) {
    throw new ApiError(
      `URL API выглядит с опечаткой: «${normalizeBaseUrl(baseUrl)}». Адрес должен заканчиваться на /v1 (например https://api.deepseek.com/v1).`,
      0,
    );
  }

  const url = joinUrl(baseUrl, '/chat/completions');

  // Встроенный поиск: провайдер сам ищет в интернете, если принять его поля.
  // Не всякий шлюз их понимает, поэтому первый отказ повторяем без добавки —
  // иначе из-за одного необязательного поля ломался бы весь запрос.
  const extra = bodyExtra && typeof bodyExtra === 'object' ? bodyExtra : null;
  const attempt = async (payload) =>
    fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });

  let res;
  try {
    res = await attempt(extra ? mergeBody(body, extra) : body);
    if (!res.ok && extra && res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403) {
      await res.text().catch(() => '');
      res = await attempt(body);
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(
      `Не удалось подключиться к ${url}. Проверьте интернет, URL API и настройку CORS у провайдера.`,
      0,
      String(err),
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(describeError(res.status, text), res.status, text);
  }

  // Не потоковый ответ
  if (!stream || !res.body || !res.headers.get('content-type')?.includes('event-stream')) {
    const raw = await res.text();
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      // Некоторые провайдеры отвечают SSE даже без stream: true
      const parsed = collectFromSse(raw);
      if (parsed.text && onText) onText(parsed.text, parsed.text);
      if (parsed.reasoning && onReasoning) onReasoning(parsed.reasoning, parsed.reasoning);
      parsed.toolCalls.forEach((c) => onToolCall && onToolCall(c));
      return {
        text: parsed.text,
        reasoning: parsed.reasoning,
        toolCalls: parsed.toolCalls,
        finishReason: parsed.finishReason || 'stop',
        usage: parsed.usage,
      };
    }
    const choice = json?.choices?.[0] || {};
    const msg = choice.message || {};
    if (msg.content && onText) onText(msg.content, msg.content);
    if (msg.reasoning_content && onReasoning) onReasoning(msg.reasoning_content, msg.reasoning_content);
    const calls = (msg.tool_calls || []).map(normalizeToolCall);
    calls.forEach((c) => onToolCall && onToolCall(c));
    return {
      text: msg.content || '',
      reasoning: msg.reasoning_content || '',
      toolCalls: calls,
      finishReason: choice.finish_reason || 'stop',
      usage: normalizeUsage(json.usage),
      raw: json,
    };
  }

  // Поток
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let usage = null;
  let finishReason = null;
  const toolAcc = new Map();

  const handleEvent = (payload) => {
    if (payload === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    if (json.usage) usage = normalizeUsage(json.usage);
    const choice = json.choices && json.choices[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (delta.content) {
      text += delta.content;
      if (onText) onText(delta.content, text);
    }
    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      if (onReasoning) onReasoning(delta.reasoning_content, reasoning);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const acc = toolAcc.get(idx) || { id: '', name: '', args: '' };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = mergeFragment(acc.name, tc.function.name);
        if (tc.function?.arguments) acc.args = mergeArgs(acc.args, tc.function.arguments);
        toolAcc.set(idx, acc);
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('data:')) handleEvent(line.slice(5).trim());
    }
  }
  // Остаток буфера
  if (buffer.trim().startsWith('data:')) handleEvent(buffer.trim().slice(5).trim());

  // Некоторые провайдеры повторяют один и тот же вызов с тем же id.
  // Без дедупликации он выполнялся дважды и в ленте появлялись два поиска.
  const seenIds = new Set();
  const toolCalls = [...toolAcc.values()]
    .filter((c) => c.name)
    .filter((c) => {
      if (!c.id) return true;
      if (seenIds.has(c.id)) return false;
      seenIds.add(c.id);
      return true;
    })
    .map((c) => {
      let args = {};
      try {
        args = c.args ? JSON.parse(c.args) : {};
      } catch {
        args = { __raw: c.args };
      }
      return { id: c.id || 'call_' + Math.random().toString(36).slice(2, 8), name: c.name, args };
    });

  return { text, reasoning, toolCalls, finishReason: finishReason || 'stop', usage };
}

/**
 * Имя функции приходит либо один раз, либо (у части провайдеров) целиком
 * в каждом чанке. Простое сложение давало «web_searchweb_search», модель
 * получала неизвестный инструмент и зацикливалась на повторных вызовах.
 */
function mergeFragment(acc, next) {
  if (!acc) return next;
  if (acc === next) return acc;
  if (next.startsWith(acc)) return next;
  return acc + next;
}

/** Аргументы инструмента — поток JSON-фрагментов; повтор целиком заменяет. */
function mergeArgs(acc, next) {
  if (!acc) return next;
  if (next === acc) return acc;
  if (next.startsWith(acc)) return next;
  if (acc.endsWith(next)) return acc;
  return acc + next;
}

function normalizeToolCall(tc) {
  let args = {};
  try {
    args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function?.arguments || {};
  } catch {
    args = { __raw: tc.function?.arguments };
  }
  return { id: tc.id || 'call_' + Math.random().toString(36).slice(2, 8), name: tc.function?.name || '', args };
}

/** На случай, если сервер прислал SSE вместо обычного JSON. */
function collectFromSse(raw) {
  const acc = new Map();
  let text = '';
  let reasoning = '';
  let finishReason = null;
  let usage = null;
  raw.split(/\r?\n/).forEach((line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    if (json.usage) usage = normalizeUsage(json.usage);
    const choice = json.choices && json.choices[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || choice.message || {};
    if (delta.content) text += delta.content;
    if (delta.reasoning_content) reasoning += delta.reasoning_content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const item = acc.get(idx) || { id: '', name: '', args: '' };
        if (tc.id) item.id = tc.id;
        if (tc.function?.name) item.name = mergeFragment(item.name, tc.function.name);
        if (tc.function?.arguments) item.args = mergeArgs(item.args, tc.function.arguments);
        acc.set(idx, item);
      }
    }
  });
  const toolCalls = [...acc.values()]
    .filter((c) => c.name)
    .map((c) => {
      let args = {};
      try {
        args = c.args ? JSON.parse(c.args) : {};
      } catch {
        args = { __raw: c.args };
      }
      return { id: c.id || 'call_' + Math.random().toString(36).slice(2, 8), name: c.name, args };
    });
  return { text, reasoning, toolCalls, finishReason, usage };
}

function normalizeUsage(u) {
  if (!u) return null;
  return {
    in: Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0,
    out: Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0,
    reasoning: Number(u.completion_tokens_details?.reasoning_tokens || 0) || 0,
    cached: Number(u.prompt_tokens_details?.cached_tokens || 0) || 0,
    total: Number(u.total_tokens || 0) || 0,
  };
}

/** Проверка соединения: запрашивает список моделей. */
export async function testConnection({ baseUrl, apiKey, extraHeaders }) {
  if (!baseUrl) throw new ApiError('Не указан URL API', 0);
  const url = joinUrl(baseUrl, '/models');
  const headers = { ...extraHeaders };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let res;
  try {
    res = await fetch(url, { headers });
  } catch {
    // Браузер не отдаёт подробности: либо нет сети, либо CORS, либо сервер не отвечает
    throw new ApiError(
      `Не удалось подключиться к ${url}. Проверьте адрес: сервер недоступен или не разрешает CORS для этого сайта.`,
      0,
    );
  }
  if (!res.ok) throw new ApiError(describeError(res.status, await res.text().catch(() => '')), res.status);
  const json = await res.json();
  return (json.data || json.models || []).map((m) => m.id || m.name).filter(Boolean);
}
