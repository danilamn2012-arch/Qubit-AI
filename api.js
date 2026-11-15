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
  if (reasoningEffort) Object.assign(body, reasoningBody(baseUrl, reasoningEffort));
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

    // Провайдер может не понять добавку (встроенный поиск). Повторяем без неё.
    if (!res.ok && extra && res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403) {
      await res.text().catch(() => '');
      res = await attempt(body);
    }

    // Или не принять слишком большой max_tokens: у DeepSeek потолок 8К.
    // Уменьшаем вдвое, пока не станет приемлемо, — но не больше трёх попыток.
    let limit = body.max_tokens || 0;
    for (let tries = 0; !res.ok && limit > 2048 && tries < 3; tries++) {
      if (res.status !== 400 && res.status !== 422) break;
      const text = await res.text().catch(() => '');
      if (!/max_tokens|max_completion_tokens|too large|maximum/i.test(text)) {
        // Не про лимит — отдаём как есть, чтобы показать настоящую ошибку.
        res = new Response(text, { status: res.status, headers: res.headers });
        break;
      }
      limit = Math.max(2048, Math.floor(limit / 2));
      res = await attempt({ ...(extra ? mergeBody(body, extra) : body), max_tokens: limit });
    }

    // Уровень рассуждений — необязательное поле и не всем шлюзам знакомо.
    // Если именно из-за него отказ, повторяем без него: работа важнее настройки.
    const hasReasoning = !!(body.reasoning_effort || body.reasoning);
    if (!res.ok && (res.status === 400 || res.status === 422) && hasReasoning) {
      const text = await res.text().catch(() => '');
      if (/reasoning|unsupported|unknown|unrecognized/i.test(text)) {
        const { reasoning_effort, reasoning, ...rest } = body;
        res = await attempt(extra ? mergeBody(rest, extra) : rest);
        if (!res.ok) res = new Response(await res.text().catch(() => ''), { status: res.status, headers: res.headers });
      } else {
        res = new Response(text, { status: res.status, headers: res.headers });
      }
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
      let sseText = parsed.text;
      let sseCalls = parsed.toolCalls;
      if (sseText) {
        const dsml = extractDsml(sseText);
        sseText = dsml.text;
        if (!sseCalls.length) sseCalls = dsml.calls;
      }
      if (sseText && onText) onText(sseText, sseText);
      if (parsed.reasoning && onReasoning) onReasoning(parsed.reasoning, parsed.reasoning);
      sseCalls.forEach((c) => onToolCall && onToolCall(c));
      return {
        text: sseText,
        reasoning: parsed.reasoning,
        toolCalls: sseCalls,
        finishReason: parsed.finishReason || 'stop',
        truncated: isCut(parsed.finishReason),
        usage: parsed.usage,
      };
    }
    const choice = json?.choices?.[0] || {};
    const msg = choice.message || {};
    const calls = (msg.tool_calls || []).map(normalizeToolCall);
    // Служебная разметка вместо tool_calls — тоже разбираем, а теги вырезаем
    // в любом случае.
    let outText = msg.content || '';
    if (outText) {
      const parsed = extractDsml(outText);
      outText = parsed.text;
      if (!calls.length) calls.push(...parsed.calls);
    }
    if (outText && onText) onText(outText, outText);
    if (msg.reasoning_content && onReasoning) onReasoning(msg.reasoning_content, msg.reasoning_content);
    calls.forEach((c) => onToolCall && onToolCall(c));
    return {
      text: outText,
      reasoning: msg.reasoning_content || '',
      toolCalls: calls,
      finishReason: choice.finish_reason || 'stop',
      truncated: isCut(choice.finish_reason),
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
      if (onText) onText(delta.content, stripDsmlLive(text));
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
      const parsed = parseArgs(c.args);
      return {
        id: c.id || 'call_' + Math.random().toString(36).slice(2, 8),
        name: c.name,
        args: parsed.args,
        truncatedArgs: parsed.truncated,
      };
    });

  // Ответ оборван на лимите: провайдер ставит finish_reason 'length' (или
  // 'max_tokens'). Это значит, что аргументы инструмента пришли не целиком.
  const cut = isCut(finishReason);

  // Модель иногда печатает служебную разметку вызова вместо tool_calls.
  // Превращаем её в настоящие вызовы, чтобы работа выполнялась, а не висела
  // текстом в ленте. Разметку вырезаем всегда — даже если вызовы уже пришли
  // штатно, иначе пользователь снова увидит «странные буквы».
  let outText = text;
  let calls = toolCalls;
  const dsml = extractDsml(text);
  if (dsml.calls.length) {
    outText = dsml.text;
    if (!calls.length) calls = dsml.calls;
  } else if (DSML_MARK.test(outText)) {
    outText = dsml.text;
  }

  return { text: outText, reasoning, toolCalls: calls, finishReason: finishReason || 'stop', truncated: cut, usage };
}

/** Признак обрыва ответа на лимите длины. */
function isCut(reason) {
  return reason === 'length' || reason === 'max_tokens';
}

/**
 * Служебная разметка DeepSeek, попавшая в обычный текст.
 *
 * Иногда модель вместо поля `tool_calls` печатает внутренний формат:
 *
 *   <｜｜DSML｜｜ calls>
 *   <｜｜DSML｜｜ invoke name="edit_file">
 *   <｜｜DSML｜｜ parameter name="path">index.html</｜｜DSML｜｜ parameter>
 *   </｜｜DSML｜｜ invoke>
 *   </｜｜DSML｜｜ calls>
 *
 * Пользователь видел это как «странные буквы», а инструмент не выполнялся,
 * поэтому модель повторяла вызов и упиралась в защиту от циклов. Разбираем
 * разметку в настоящие вызовы и убираем её из текста ответа.
 */
const DSML_MARK = /<[｜|]{1,2}\s*DSML\s*[｜|]{1,2}/i;

function extractDsml(text) {
  const source = String(text || '');
  if (!DSML_MARK.test(source)) return { text: source, calls: [] };

  const calls = [];
  const invokeRe =
    /<[｜|]+\s*DSML\s*[｜|]+\s*invoke\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/[｜|]+\s*DSML\s*[｜|]+\s*invoke\s*>/gi;
  let m;
  while ((m = invokeRe.exec(source))) {
    const name = m[1];
    const body = m[2];
    const args = {};
    const paramRe =
      /<[｜|]+\s*DSML\s*[｜|]+\s*parameter\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/[｜|]+\s*DSML\s*[｜|]+\s*parameter\s*>/gi;
    let p;
    while ((p = paramRe.exec(body))) {
      const key = p[1];
      const raw = p[2];
      // Значение может быть строкой (path) или готовым JSON (edits).
      let value = raw;
      const trimmed = raw.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          value = JSON.parse(trimmed);
        } catch {
          value = raw;
        }
      }
      args[key] = value;
    }
    if (name) calls.push({ id: 'call_' + Math.random().toString(36).slice(2, 8), name, args, truncatedArgs: false });
  }

  // Вырезаем разметку: сначала блок целиком, затем остатки отдельных тегов.
  let cleaned = source.replace(
    /<[｜|]+\s*DSML[\s\S]*?<\/[｜|]+\s*DSML\s*[｜|]+\s*calls\s*>/gi,
    '',
  );
  if (!cleaned.trim()) {
    cleaned = source.replace(/<[｜|]+\s*DSML[\s\S]*$/i, '');
  }
  cleaned = cleaned
    .split('\n')
    .filter((line) => !DSML_MARK.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text: cleaned, calls };
}

/**
 * Живой текст без служебной разметки.
 *
 * Разбор идёт по мере стрима: незакрытый блок DSML обрезается до конца, чтобы
 * пользователь не видел теги, пока ответ ещё печатается.
 */
function stripDsmlLive(text) {
  const source = String(text || '');
  if (!DSML_MARK.test(source)) return source;
  const cleaned = source.replace(/<[｜|]+\s*DSML[\s\S]*?<\/[｜|]+\s*DSML\s*[｜|]+\s*calls\s*>/gi, '');
  const openAt = cleaned.search(/<[｜|]+\s*DSML/i);
  return (openAt >= 0 ? cleaned.slice(0, openAt) : cleaned).trimEnd();
}

/**
 * Поля тела для выбранного уровня рассуждений.
 *
 * Провайдеры называют это по-разному: OpenRouter понимает
 * `reasoning: { effort: 'high' }`, а большинство OpenAI-совместимых шлюзов —
 * `reasoning_effort: 'high'`. Раньше мы всегда слали второе, и OpenRouter
 * отвечал 400 на незнакомое поле. Значение берётся из списка модели, поэтому
 * сюда попадает только то, что провайдер действительно объявил.
 */
function reasoningBody(baseUrl, effort) {
  if (/openrouter\.ai/i.test(String(baseUrl || ''))) {
    return { reasoning: { effort } };
  }
  return { reasoning_effort: effort };
}

/**
 * Имя функции приходит либо один раз, либо (у части провайдеров) целиком
 * в каждом чанке. Простое сложение давало «web_searchweb_search», модель
 * получала неизвестный инструмент и зацикливалась на повторных вызовах.
 */
/**
 * Разбирает аргументы вызова инструмента, спасая обрезанный ответ.
 *
 * Провайдер обрывает генерацию на `max_tokens` прямо посреди JSON. Раньше
 * получался `{ __raw: ... }`, инструмент вызывался без обязательных полей
 * («Параметр content обязателен»), и модель шла по кругу. Теперь частичный
 * JSON достраивается, а факт обрезки помечается флагом.
 */
function parseArgs(raw) {
  const text = String(raw == null ? '' : raw);
  if (!text.trim()) return { args: {}, truncated: false };

  try {
    return { args: JSON.parse(text), truncated: false };
  } catch {
    // Ниже пробуем восстановить.
  }

  const salvaged = salvageJson(text);
  if (salvaged) return { args: salvaged, truncated: true };
  return { args: { __raw: text.slice(0, 2000) }, truncated: true };
}

/**
 * Достраивает обрезанный JSON: закрывает строку и незакрытые скобки.
 *
 * Сначала пробуем самый вероятный случай — обрыв внутри строкового значения
 * (`{"path":"a","content":"…`): хватает закрыть кавычку и `}`. Если не вышло,
 * откатываемся к последней запятой вне строки и закрываем уже оттуда.
 */
function salvageJson(text) {
  const attempt = (cut) => {
    let s = text.slice(0, cut);
    // Незакрытая строка? Считаем кавычки с учётом экранирования.
    let inString = false;
    let escaped = false;
    const stack = [];
    for (const ch of s) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{' || ch === '[') stack.push(ch);
      else if (ch === '}' || ch === ']') stack.pop();
    }
    if (inString) s += '"';
    s = s.replace(/[,\s]+$/, '');
    for (let i = stack.length - 1; i >= 0; i--) s += stack[i] === '{' ? '}' : ']';
    try {
      const parsed = JSON.parse(s);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  };

  const direct = attempt(text.length);
  if (direct) return direct;

  // Откат к запятым вне строк, от конца к началу — не больше 50 попыток.
  const cuts = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && ch === ',') cuts.push(i);
  }
  for (let k = cuts.length - 1, tries = 0; k >= 0 && tries < 50; k--, tries++) {
    const restored = attempt(cuts[k]);
    if (restored) return restored;
  }
  return null;
}

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
  const parsed =
    typeof tc.function?.arguments === 'string'
      ? parseArgs(tc.function.arguments)
      : { args: tc.function?.arguments || {}, truncated: false };
  return {
    id: tc.id || 'call_' + Math.random().toString(36).slice(2, 8),
    name: tc.function?.name || '',
    args: parsed.args,
    truncatedArgs: parsed.truncated,
  };
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
      const parsed = parseArgs(c.args);
      return {
        id: c.id || 'call_' + Math.random().toString(36).slice(2, 8),
        name: c.name,
        args: parsed.args,
        truncatedArgs: parsed.truncated,
      };
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

/** Проверка соединения: запрашивает список моделей с их возможностями. */
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
  const rows = json.data || json.models || [];
  return rows
    .map((m) => (typeof m === 'string' ? { id: m } : m))
    .filter((m) => m && (m.id || m.name))
    .map((m) => ({
      id: m.id || m.name,
      context: Number(m.context_length || m.context || 0) || 0,
      // Уровни рассуждений — только те, что реально объявил шлюз.
      efforts: readEfforts(m),
      supportsTools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes('tools') : null,
    }));
}

/**
 * Достаёт объявленные уровни рассуждений из записи `/models`.
 *
 * Форматов несколько: OpenRouter отдаёт `reasoning.supported_efforts`, часть
 * шлюзов — `reasoning.efforts`, кто-то только `supported_parameters`. Ничего
 * не выдумываем: нет данных — пустой список, и выбора усилий не будет.
 */
function readEfforts(m) {
  const r = m.reasoning;
  if (!r || typeof r !== 'object') return [];
  const raw = r.supported_efforts || r.efforts || r.supported_effort_levels || null;
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === 'string') return raw.split(/[,;\s]+/).filter(Boolean);
  return [];
}
