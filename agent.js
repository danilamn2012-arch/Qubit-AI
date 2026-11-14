/**
 * Агент Qubit AI: системный промпт, инструменты, цикл вызовов,
 * расчёт токенов и сжатие контекста.
 */

import { streamChat, buildNativeBody } from './api.js';
import { SYSTEM_PROMPT, MAX_TOOL_ROUNDS, MAX_SEARCHES_PER_TURN, SEARCH_TIMEOUT, EFFORT_PARAMS, COMPACT_KEEP_LAST, nowContext } from './config.js';
import * as store from './storage.js';
import { estimateTokens, messageTokens, historyTokens, costOf, effectiveContext } from './pricing.js';

/* ----------------------------- Инструменты ----------------------------- */

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Показать список файлов проекта с размерами. Вызывай, если не знаешь, что уже существует.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Прочитать файл проекта. Для больших файлов используй offset и limit (строки), чтобы не тратить контекст.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь файла, например index.html' },
          offset: { type: 'integer', description: 'Первая строка (с 1)' },
          limit: { type: 'integer', description: 'Сколько строк вернуть (по умолчанию 200)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Создать новый файл или полностью заменить содержимое. Используй только для новых файлов или полной перезаписи; для правок вызывай edit_file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь файла относительно корня проекта' },
          content: { type: 'string', description: 'Полное содержимое файла' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Точечно изменить существующий файл: найти фрагмент и заменить его. Не переписывай весь файл. Фрагмент old_string должен встречаться ровно один раз, иначе расширь его контекстом.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          edits: {
            type: 'array',
            description: 'Список правок, применяются по порядку',
            items: {
              type: 'object',
              properties: {
                old_string: { type: 'string', description: 'Точный существующий фрагмент' },
                new_string: { type: 'string', description: 'Чем заменить (пустая строка = удалить)' },
                replace_all: { type: 'boolean', description: 'Заменить все вхождения' },
              },
              required: ['old_string', 'new_string'],
            },
          },
        },
        required: ['path', 'edits'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Удалить файл проекта по пути.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
];

const SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Найти информацию в интернете. Возвращает заголовки, сниппеты и ссылки.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Поисковый запрос' },
        limit: { type: 'integer', description: 'Сколько результатов (1–8)' },
      },
      required: ['query'],
    },
  },
};

const TEXT_EXT = /\.(html?|css|js|mjs|cjs|jsx|ts|tsx|json|md|txt|svg|csv|xml|yml|yaml|toml|ini|py|sh|sql)$/i;

function normalizePath(p) {
  let path = String(p || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  if (path.startsWith('res://')) path = path.slice(6);
  if (!path || path.includes('..')) throw new Error('Недопустимый путь файла');
  return path;
}

function extOf(path) {
  const m = String(path).match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : '';
}

/* ------------------------------- Поиск --------------------------------- */

export async function webSearch(settings, query, limit = 5, signal) {
  const cfg = settings.search || {};
  if (!cfg.mode || cfg.mode === 'off') throw new Error('Веб-поиск выключен в настройках');
  const q = encodeURIComponent(query);
  const n = Math.max(1, Math.min(8, Number(limit) || 5));

  let url;
  if (cfg.mode === 'wikipedia') {
    url = (cfg.endpoint || 'https://ru.wikipedia.org/w/api.php?action=query&list=search&srsearch={query}&srlimit={limit}&format=json&origin=*')
      .replace('{query}', q)
      .replace('{limit}', String(n));
  } else {
    url = String(cfg.endpoint || '').replace('{query}', q).replace('{limit}', String(n));
  }
  if (!url) throw new Error('Не задан адрес поискового API');

  const headers = {};
  if (cfg.headerName && cfg.headerValue) headers[cfg.headerName] = cfg.headerValue;

  // Без таймаута зависший поисковик держал бы запрос вечно: в интерфейсе это
  // выглядит как «ищу результаты…», которое никогда не заканчивается.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let res;
  try {
    res = await fetch(url, { headers, signal: ctrl.signal });
  } catch (err) {
    if (signal && signal.aborted) throw err;
    if (err.name === 'AbortError') {
      throw new Error(`Поиск не ответил за ${Math.round(SEARCH_TIMEOUT / 1000)} с. Проверьте адрес источника в настройках.`);
    }
    throw new Error('Поиск недоступен: проверьте интернет и настройки источника.');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  if (!res.ok) throw new Error(`Поиск недоступен (${res.status})`);

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error('Источник поиска вернул не JSON. Проверьте адрес API в настройках.');
  }

  const pathParts = String(cfg.resultPath || '').split('.').filter(Boolean);
  let items = json;
  for (const part of pathParts) items = items && items[part];
  if (!Array.isArray(items)) {
    // Популярные альтернативы
    items = json.results || json.items || json.organic || json.data || [];
  }

  return items.slice(0, n).map((r) => {
    const title = r[cfg.titleKey || 'title'] || r.title || r.name || '';
    const snippet = String(r[cfg.snippetKey || 'snippet'] || r.snippet || r.description || r.content || '')
      .replace(/<[^>]+>/g, '')
      .trim()
      .slice(0, 400);
    const href =
      r.url ||
      r.link ||
      (cfg.urlTemplate
        ? cfg.urlTemplate.replace('{title}', encodeURIComponent(String(title).replace(/ /g, '_'))).replace('{url}', r.url || '')
        : '');
    return { title, snippet, url: href };
  });
}

/* ----------------------------- Сжатие --------------------------------- */

/**
 * Сжимает историю: оставляет начало (система + первый запрос) и последние сообщения,
 * середину заменяет сводкой, сгенерированной моделью или локально.
 */
export async function compactHistory(opts) {
  const { messages, summary, model, settings, signal, onStatus } = opts;
  const keepLast = Math.max(2, Number(settings.compactKeepLast) || COMPACT_KEEP_LAST);
  const head = messages.slice(0, 2);
  const tail = messages.slice(-keepLast);
  const middle = messages.slice(2, messages.length - keepLast);

  if (!middle.length) return { messages, summary };

  onStatus && onStatus('Собираю сводку разговора…');

  const transcript = middle
    .filter((m) => m.content || m.toolName)
    .map((m) => {
      const who = m.role === 'user' ? 'Пользователь' : m.role === 'assistant' ? 'Ассистент' : 'Инструмент';
      const files = m.files?.length ? ` [файлы: ${m.files.map((f) => f.path).join(', ')}]` : '';
      const tools = m.toolName ? ` [инструмент ${m.toolName}]` : '';
      return `${who}${tools}: ${String(m.content || '').slice(0, 1500)}${files}`;
    })
    .join('\n\n');

  let newSummary = '';
  const prompt = `Сожми фрагмент диалога в короткую техническую сводку на русском.
Сохрани: цель пользователя, принятые решения, созданные и изменённые файлы, важные детали и договорённости.
Не добавляй выводов и вежливости. Максимум 250 слов.

${summary ? `Предыдущая сводка:\n${summary}\n\n` : ''}Фрагмент диалога:
${transcript}`;

  try {
    const { parseExtraHeaders } = await import('./api.js');
    const res = await streamChat({
      baseUrl: settings.provider.baseUrl,
      apiKey: settings.provider.apiKey,
      extraHeaders: parseExtraHeaders(settings.provider.extraHeaders),
      model: model.id,
      messages: [
        { role: 'system', content: 'Ты аккуратно сжимаешь технические диалоги, ничего не выдумывая.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      maxTokens: 900,
      stream: settings.provider.stream !== false,
      signal,
    });
    newSummary = (res.text || '').trim();
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.warn('[qubit] Сжатие: не удалось получить сводку от модели', err);
    newSummary = '';
  }

  if (!newSummary) {
    newSummary = localSummary(middle, summary);
  } else if (summary && !newSummary.includes(summary.slice(0, 60))) {
    newSummary = `${summary}\n\n${newSummary}`;
  }

  const compacted = [
    ...head,
    {
      role: 'assistant',
      content: `Сводка предыдущей части разговора:\n\n${newSummary}`,
      compacted: true,
    },
    ...tail,
  ];

  return { messages: compacted, summary: newSummary };
}

function localSummary(messages, prev) {
  const users = [];
  const files = new Set();
  messages.forEach((m) => {
    if (m.role === 'user' && m.content) {
      const t = String(m.content).replace(/\s+/g, ' ').trim().slice(0, 160);
      if (t && !users.includes(t)) users.push(t);
    }
    (m.files || []).forEach((f) => files.add(f.path));
  });

  const parts = [];
  if (prev) parts.push(String(prev).trim());
  const list = users.slice(-8);
  if (list.length) parts.push('Запросы пользователя:\n' + list.map((u) => `— ${u}`).join('\n'));
  if (files.size) parts.push('Файлы проекта: ' + [...files].join(', '));
  return parts.join('\n\n').slice(0, 2400);
}

/* ------------------------------ Агент ---------------------------------- */

/**
 * Один ход ассистента с возможными вызовами инструментов.
 *
 * @param {object} ctx
 * @param {object} ctx.chat
 * @param {object} ctx.settings
 * @param {object} ctx.model
 * @param {string} ctx.effort
 * @param {AbortSignal} ctx.signal
 * @param {object} ctx.events  колбэки UI
 */
export async function runTurn(ctx) {
  const { chat, settings, model, effort, signal, events = {} } = ctx;
  const { onText, onReasoning, onTool, onUsage, onStatus, onCompact } = events;

  // Поиск выключается для отдельного чата: chat.searchOff перекрывает настройки.
  const chatSearchAllowed = !(chat && chat.searchOff);

  // Встроенный поиск провайдера: отдельного инструмента не нужно, API ищет сам.
  // Он не зависит от источника web_search — можно выключить Википедию и
  // оставить поиск OpenRouter.
  const nativeMode = settings.search?.native || 'auto';
  const nativeBody = !chatSearchAllowed || nativeMode === 'off' ? null : buildNativeBody(settings);

  // Инструмент поиска нужен, только если встроенного поиска нет: иначе модель
  // искала бы дважды — сама и через инструмент.
  const toolSearchOn =
    chatSearchAllowed && !nativeBody && !!(settings.search && settings.search.mode && settings.search.mode !== 'off');

  const tools = [...TOOLS];
  if (toolSearchOn) tools.push(SEARCH_TOOL);

  // Лимит поисков настраивается: 0 означает «без ограничения» в разумных рамках.
  const maxSearches = Math.max(0, Number(settings.search?.maxPerTurn ?? MAX_SEARCHES_PER_TURN));

  const params = EFFORT_PARAMS[effort] || EFFORT_PARAMS.medium;
  const ctxLimit = effectiveContext(model, settings, effort);
  const supportsTools = model.tools !== false;

  let files = await store.listFiles(chat.id);
  let usageTotal = { in: 0, out: 0 };
  let rounds = 0;
  let finalText = '';
  let compacted = false;
  // Поиск ограничен и кешируется: иначе модель может зациклиться, повторяя
  // один и тот же запрос, и «ищу результаты…» не заканчивается никогда.
  let searches = 0;
  const searchCache = new Map();
  // Подписи уже выполненных вызовов: если модель повторяет один и тот же вызов,
  // это цикл, а не работа. Тогда убираем инструменты и просим ответить текстом.
  const callCounts = new Map();
  let toolsDisabled = false;

  // История: системный промпт + сводка + сообщения
  const buildMessages = () => {
    // Дату и время собираем при каждом запросе: в долгом чате они устаревают.
    const msgs = [
      { role: 'system', content: SYSTEM_PROMPT + fileManifest(files) },
      { role: 'system', content: nowContext() },
    ];
    if (chat.summary) {
      msgs.push({ role: 'system', content: 'Сводка предыдущей части разговора:\n' + chat.summary });
    }
    const history = chat.messages.filter((m) => !m.hidden).map(toApiMessage).filter(Boolean);
    return msgs.concat(history);
  };

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds++;
    let messages = buildMessages();

    // Когда лимит поисков исчерпан, убираем инструмент из списка: модель
    // перестаёт его вызывать и просто отвечает по уже найденному.
    const searchExhausted = maxSearches > 0 && searches >= maxSearches;
    const toolDefs =
      !supportsTools || toolsDisabled
        ? undefined
        : searchExhausted
          ? tools.filter((t) => t.function.name !== 'web_search')
          : tools;

    // Проверка контекста
    const used = historyTokens(messages.map((m) => ({ content: m.content }))) + estimateTokens(JSON.stringify(toolDefs || []));
    const threshold = ctxLimit * (Number(settings.compactThreshold) || 0.8);
    if (used > threshold && chat.messages.length > (settings.compactKeepLast || COMPACT_KEEP_LAST) + 2) {
      onStatus && onStatus('Контекст заполнен — сжимаю историю');
      const res = await compactHistory({
        messages: chat.messages,
        summary: chat.summary,
        model,
        settings,
        signal,
        onStatus,
      });
      chat.messages = res.messages;
      chat.summary = res.summary;
      compacted = true;
      onCompact && onCompact({ summary: res.summary, before: used, limit: ctxLimit });
      messages = buildMessages();
    }

    let assistantText = '';
    let assistantReasoning = '';
    let toolCalls = [];

    const res = await streamChat({
      baseUrl: settings.provider.baseUrl,
      apiKey: settings.provider.apiKey,
      extraHeaders: (await import('./api.js')).parseExtraHeaders(settings.provider.extraHeaders),
      model: model.id,
      messages,
      tools: toolDefs,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      reasoningEffort: params.reasoning_effort,
      stream: settings.provider.stream !== false,
      bodyExtra: nativeBody,
      signal,
      onText: (delta, full) => {
        assistantText = full;
        onText && onText(full);
      },
      onReasoning: (delta, full) => {
        assistantReasoning = full;
        onReasoning && onReasoning(full);
      },
    });
    assistantText = res.text || assistantText;
    assistantReasoning = res.reasoning || assistantReasoning;
    toolCalls = res.toolCalls || [];

    const u = res.usage;
    const roundIn = u ? u.in : used;
    const roundOut = u ? u.out : estimateTokens(assistantText) + estimateTokens(assistantReasoning);
    usageTotal.in += roundIn;
    usageTotal.out += roundOut;
    onUsage && onUsage({ in: roundIn, out: roundOut, estimated: !u });

    if (!assistantText.trim() && !toolCalls.length) break;

    const msg = {
      id: 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      role: 'assistant',
      content: assistantText,
      reasoning: assistantReasoning || '',
      toolCalls: toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      files: [],
      usage: { in: usageTotal.in, out: usageTotal.out, cost: costOf(model, usageTotal.in, usageTotal.out) },
      at: Date.now(),
    };
    chat.messages.push(msg);

    if (!toolCalls.length) {
      finalText = assistantText;
      break;
    }

    // Инструменты уже отключены, а модель всё равно просит вызов — дальше
    // повторять бесполезно, завершаем ход с понятным сообщением.
    if (toolsDisabled) break;

    // Выполняем инструменты
    let repeated = 0;
    for (const call of toolCalls) {
      // Считаем одинаковые вызовы (имя + аргументы). Три раза подряд один и
      // тот же вызов — это цикл: дальше инструменты не даём.
      const sig = `${call.name}:${JSON.stringify(call.args || {})}`;
      const times = (callCounts.get(sig) || 0) + 1;
      callCounts.set(sig, times);
      if (times >= 3) repeated++;

      onTool && onTool({ phase: 'start', call });
      let result;
      try {
        if (times >= 3) {
          result = {
            error: 'Этот вызов уже выполнялся, результат не изменится. Ответь пользователю по уже полученным данным.',
          };
        } else if (call.name === 'web_search') {
          const query = String(call.args?.query || '').trim();
          if (!query) throw new Error('Пустой поисковый запрос');

          // Повторный запрос не тратит лимит и не ходит в сеть: модель иногда
          // зацикливается на одной и той же формулировке.
          const key = query.toLowerCase();
          if (searchCache.has(key)) {
            result = { query, results: searchCache.get(key), cached: true };
          } else if (maxSearches > 0 && searches >= maxSearches) {
            result = {
              query,
              results: [],
              error: `Лимит поисков в одном ответе (${maxSearches}) исчерпан. Ответь, опираясь на уже найденное.`,
            };
          } else {
            searches++;
            const found = await webSearch(settings, query, call.args?.limit, signal);
            searchCache.set(key, found);
            result = { query, results: found };
          }
        } else {
          result = await executeTool(call, { chat, settings, files, model });
        }
        if (result.files) files = await store.listFiles(chat.id);
        onTool && onTool({ phase: 'ok', call, result });
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        result = { error: err.message || String(err) };
        onTool && onTool({ phase: 'error', call, result });
      }

      const toolMsg = {
        id: 't-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        role: 'tool',
        content: JSON.stringify(result).slice(0, 12000),
        toolCallId: call.id,
        toolName: call.name,
        toolArgs: call.args,
        toolResult: result,
        at: Date.now(),
      };
      chat.messages.push(toolMsg);

      // Привязываем к сообщению ассистента файлы для карточек
      if (result.file) msg.files.push(result.file);
      if (result.deleted) msg.deleted = result.deleted;
    }

    // Все вызовы раунда повторились — значит, модель зациклилась. Отключаем
    // инструменты, чтобы следующий шаг был обычным текстовым ответом.
    if (repeated === toolCalls.length) toolsDisabled = true;
  }

  // Если модель так и не ответила текстом (упёрлась в лимит шагов или
  // зациклилась), добавляем понятное сообщение: пустой ответ выглядит как
  // зависший интерфейс.
  if (!finalText.trim() && !(signal && signal.aborted)) {
    finalText =
      'Не удалось закончить ответ: модель слишком долго вызывала инструменты. Уточните запрос или повторите его — часть работы уже сохранена.';
    chat.messages.push({
      id: 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      role: 'assistant',
      content: finalText,
      at: Date.now(),
      modelId: model.id,
      usage: { in: usageTotal.in, out: usageTotal.out, cost: costOf(model, usageTotal.in, usageTotal.out) },
    });
  }

  return { text: finalText, usage: usageTotal, compacted };
}

function fileManifest(files) {
  if (!files.length) return '\n\nПроект пока пуст. Файлов нет.';
  const list = files
    .slice(0, 80)
    .map((f) => `- ${f.path} (${f.content.length} симв.)`)
    .join('\n');
  return `\n\nТекущие файлы проекта:\n${list}`;
}

function toApiMessage(m) {
  if (m.role === 'user') {
    if (m.images && m.images.length) {
      const parts = [{ type: 'text', text: m.content || '' }];
      m.images.forEach((img) => parts.push({ type: 'image_url', image_url: { url: img.data } }));
      return { role: 'user', content: parts };
    }
    return { role: 'user', content: m.content || '' };
  }
  if (m.role === 'assistant') {
    const out = { role: 'assistant', content: m.content || '' };
    if (m.toolCalls && m.toolCalls.length) {
      out.tool_calls = m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
      }));
      if (!out.content) out.content = null;
    }
    return out;
  }
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: String(m.content || '').slice(0, 12000) };
  }
  return null;
}

/* --------------------------- Выполнение ------------------------------- */

async function executeTool(call, { chat, settings, files, model, signal }) {
  const args = call.args || {};
  switch (call.name) {
    case 'list_files': {
      const list = await store.listFiles(chat.id);
      return {
        files: list.map((f) => ({
          path: f.path,
          bytes: new Blob([f.content]).size,
          lines: f.content.split('\n').length,
          ext: extOf(f.path),
        })),
      };
    }

    case 'read_file': {
      const path = normalizePath(args.path);
      const rec = await store.getFile(chat.id, path);
      if (!rec) throw new Error(`Файл не найден: ${path}`);
      const all = rec.content.split('\n');
      const offset = Math.max(1, Number(args.offset) || 1);
      const limit = Math.max(1, Number(args.limit) || 200);
      const slice = all.slice(offset - 1, offset - 1 + limit);
      return {
        path,
        total_lines: all.length,
        offset,
        content: slice.join('\n'),
        truncated: offset - 1 + slice.length < all.length,
      };
    }

    case 'write_file': {
      const path = normalizePath(args.path);
      if (typeof args.content !== 'string') throw new Error('Параметр content обязателен');
      const existed = await store.getFile(chat.id, path);
      await store.putFile(chat.id, path, args.content);
      return {
        ok: true,
        action: existed ? 'overwritten' : 'created',
        file: { path, content: args.content, ext: extOf(path), status: existed ? 'changed' : 'created' },
      };
    }

    case 'edit_file': {
      const path = normalizePath(args.path);
      const rec = await store.getFile(chat.id, path);
      if (!rec) throw new Error(`Файл не найден: ${path}. Сначала создайте его через write_file.`);
      let content = rec.content;
      const edits = Array.isArray(args.edits) ? args.edits : [];
      const applied = [];
      for (const e of edits) {
        const oldStr = String(e.old_string ?? '');
        const newStr = String(e.new_string ?? '');
        if (!oldStr) throw new Error('old_string не может быть пустым');
        const count = content.split(oldStr).length - 1;
        if (count === 0) {
          throw new Error(`Фрагмент не найден в ${path}. Прочитайте файл заново через read_file и повторите с точным текстом.`);
        }
        if (count > 1 && !e.replace_all) {
          throw new Error(`Фрагмент встречается ${count} раз в ${path}. Расширьте old_string контекстом или укажите replace_all.`);
        }
        content = e.replace_all ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
        applied.push({ old_string: oldStr.slice(0, 80), occurrences: e.replace_all ? count : 1 });
      }
      if (!edits.length) throw new Error('Нужен хотя бы один элемент в edits');
      await store.putFile(chat.id, path, content);
      return {
        ok: true,
        action: 'edited',
        path,
        applied,
        file: { path, content, ext: extOf(path), status: 'edited' },
      };
    }

    case 'delete_file': {
      const path = normalizePath(args.path);
      const rec = await store.getFile(chat.id, path);
      if (!rec) throw new Error(`Файл не найден: ${path}`);
      await store.deleteFile(chat.id, path);
      return { ok: true, deleted: path };
    }

    case 'web_search': {
      const results = await webSearch(settings, args.query, args.limit, signal);
      return { query: args.query, results };
    }

    default:
      throw new Error(`Неизвестный инструмент: ${call.name}`);
  }
}

export { extOf, normalizePath, TEXT_EXT };
