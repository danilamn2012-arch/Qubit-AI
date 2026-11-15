/**
 * Qubit AI — константы и значения по умолчанию.
 * Все магические числа интерфейса и лимиты живут здесь.
 */

export const APP = {
  name: 'Qubit AI',
  version: '1.3.4',
  storageKey: 'qubit.settings.v1',
};

/**
 * Подписи уровней усилий, которые присылает провайдер.
 *
 * Своих значений мы больше не выдумываем: набор приходит из `/models`
 * (или задаётся вручную для модели). Если провайдер ничего не сообщил,
 * выбора усилий в интерфейсе нет вовсе.
 */
export const EFFORT_LABELS = {
  none: 'Без рассуждений',
  minimal: 'Минимальные',
  low: 'Низкие',
  medium: 'Средние',
  high: 'Высокие',
  xhigh: 'Очень высокие',
  max: 'Максимальные',
};

/** Красивая подпись уровня усилий; неизвестное значение — как есть. */
export function effortLabel(id) {
  return EFFORT_LABELS[id] || String(id || '');
}

/**
 * Уровни усилий, которые поддерживает конкретная модель.
 *
 * Список живёт в настройках модели: он приходит из `/models` (если шлюз его
 * отдаёт) или вписывается вручную. Пустой список — выбора усилий нет вовсе,
 * и `reasoning_effort` в запрос не попадает.
 */
export function effortsOf(model) {
  const raw = model && model.efforts;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(/[,;\s]+/);
  return [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
}

/**
 * Параметры запроса по умолчанию.
 *
 * Раньше температура и `max_tokens` зависели от «усилий»: переключение уровня
 * незаметно меняло длину ответа, и файл обрывался. Теперь это независимые
 * значения, а неподдерживаемые поля API отбрасывает сам (см. api.js).
 */
export const DEFAULT_TEMPERATURE = 0.4;
export const DEFAULT_MAX_TOKENS = 32000;

/** Сколько шагов агента разрешено за один ответ пользователя. */
export const DEFAULT_MAX_STEPS = 40;

/** Сколько поисковых запросов модель может сделать за один ход (по умолчанию). */
export const MAX_SEARCHES_PER_TURN = 4;

/** Сколько ждём ответа поискового API, мс. */
export const SEARCH_TIMEOUT = 12000;

/** Дебаунс сохранения чата, мс. */
export const SAVE_DEBOUNCE = 350;

/** Резерв контекста под ответ модели. */
export const CONTEXT_RESERVE = 1800;

/** Сколько последних сообщений не сжимать. */
export const COMPACT_KEEP_LAST = 6;

/** Возможные модальности модели. */
export const MODALITIES = {
  text: 'Текст',
  image: 'Изображения',
  audio: 'Аудио',
  file: 'Файлы',
};

/**
 * Пресеты провайдеров для быстрого подключения.
 * `models` — рекомендованные ID, их можно добавить одной кнопкой.
 * `extraHeaders` подставляется в настройки (нужно OpenRouter).
 */
export const PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    hint: 'Прямой доступ, дешёвые модели, поддержка инструментов.',
    extraHeaders: '',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek V3', context: 128000, tools: true, input: ['text'], output: ['text'], priceIn: 25, priceOut: 95 },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', context: 131000, tools: false, input: ['text'], output: ['text'], priceIn: 55, priceOut: 220 },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    hint: 'Сотни моделей одним ключом: Claude, GPT, Gemini, Qwen и другие.',
    extraHeaders: 'HTTP-Referer: https://github.com\nX-Title: Qubit AI',
    models: [
      { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', context: 200000, tools: true, input: ['text', 'image'], output: ['text'], priceIn: 240, priceOut: 1200 },
      { id: 'openai/gpt-4.1', name: 'GPT-4.1', context: 1040000, tools: true, input: ['text', 'image'], output: ['text'], priceIn: 160, priceOut: 640 },
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', context: 1040000, tools: true, input: ['text', 'image'], output: ['text'], priceIn: 100, priceOut: 800 },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    hint: 'Официальный API OpenAI.',
    extraHeaders: '',
    models: [
      { id: 'gpt-4.1', name: 'GPT-4.1', context: 1040000, tools: true, input: ['text', 'image'], output: ['text'], priceIn: 160, priceOut: 640 },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini', context: 1040000, tools: true, input: ['text', 'image'], output: ['text'], priceIn: 32, priceOut: 128 },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    hint: 'Очень быстрая выдача, открытые модели.',
    extraHeaders: '',
    models: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', context: 131072, tools: true, input: ['text'], output: ['text'], priceIn: 5, priceOut: 8 },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
    hint: 'Европейский провайдер, модели Mistral и Codestral.',
    extraHeaders: '',
    models: [
      { id: 'mistral-large-latest', name: 'Mistral Large', context: 131072, tools: true, input: ['text'], output: ['text'], priceIn: 160, priceOut: 480 },
    ],
  },
  {
    id: 'together',
    name: 'Together',
    baseUrl: 'https://api.together.xyz/v1',
    keyUrl: 'https://api.together.ai/settings/api-keys',
    hint: 'Открытые модели: Qwen, Llama, DeepSeek.',
    extraHeaders: '',
    models: [
      { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507-tput', name: 'Qwen3 235B', context: 262144, tools: true, input: ['text'], output: ['text'], priceIn: 16, priceOut: 48 },
    ],
  },
  {
    id: 'custom',
    name: 'Свой сервер',
    baseUrl: '',
    keyUrl: '',
    hint: 'Любой OpenAI-совместимый шлюз: локальный прокси, корпоративный сервер, Ollama, LM Studio.',
    extraHeaders: '',
    models: [],
  },
];

/** Грубая оценка контекстного окна по ID модели — только для автодобавления. */
export function guessContext(id) {
  const s = String(id || '').toLowerCase();
  if (/claude|sonnet|opus/.test(s)) return 200000;
  if (/gemini/.test(s)) return 1000000;
  if (/gpt-4\.1|gpt-4o/.test(s)) return 1000000;
  if (/gpt-4/.test(s)) return 128000;
  if (/o1|o3|o4/.test(s)) return 200000;
  if (/deepseek-reasoner|r1/.test(s)) return 131000;
  if (/deepseek/.test(s)) return 128000;
  if (/qwen/.test(s)) return 131072;
  if (/llama|mistral|mixtral/.test(s)) return 128000;
  if (/gemma|phi/.test(s)) return 32000;
  return 32000;
}

/** Красивое имя из ID модели: provider/model-name → Model name. */
export function prettyModelName(id) {
  const raw = String(id || '').split('/').pop().replace(/[:-]/g, ' ').trim();
  if (!raw) return String(id || 'Модель');
  return raw
    .split(/\s+/)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

export const DEFAULT_MODELS = [];

export const DEFAULT_SETTINGS = {
  provider: {
    preset: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    extraHeaders: '',
    stream: true,
  },
  /** Поиск в интернете: 'off' | 'wikipedia' | 'custom'. */
  search: {
    mode: 'wikipedia',
    endpoint: 'https://ru.wikipedia.org/w/api.php?action=query&list=search&srsearch={query}&srlimit={limit}&format=json&origin=*',
    headerName: '',
    headerValue: '',
    resultPath: 'query.search',
    titleKey: 'title',
    snippetKey: 'snippet',
    urlTemplate: 'https://ru.wikipedia.org/wiki/{title}',
    /** Сколько поисковых запросов разрешено за один ответ. */
    maxPerTurn: 4,
    /**
     * Встроенный поиск провайдера: 'auto' | 'off' | 'openrouter' | 'openai' |
     * 'xai' | 'custom'. Провайдер ищет сам, отдельный инструмент не нужен.
     */
    native: 'auto',
    /** Дополнительные поля тела запроса для 'custom' (JSON-объект). */
    nativeBody: '',
  },
  models: DEFAULT_MODELS,
  activeModelId: '',
  /** Сколько шагов агента разрешено за один ответ. */
  maxSteps: DEFAULT_MAX_STEPS,
  /** Потолок длины одного ответа модели. */
  maxTokens: DEFAULT_MAX_TOKENS,
  temperature: DEFAULT_TEMPERATURE,
  theme: 'auto',
  fontScale: 1,
  compactThreshold: 0.8,
  compactKeepLast: COMPACT_KEEP_LAST,
  /** Глобальное ограничение контекста сверху, токены. 0 — не ограничивать. */
  contextCap: 0,
  autoTitle: true,
  sendOnEnter: true,
  showTokenDetails: true,
  sidebarCollapsed: false,
};

/** Системный промпт агента. Меняется осознанно: от него зависит поведение файлов. */
export const SYSTEM_PROMPT = `Ты — Qubit AI, агент внутри веб-клиента для работы с файлами проекта.
Ты общаешься на языке пользователя, по умолчанию по-русски.

## Файлы
- Проект — это виртуальная файловая система, отдельная для каждого чата.
- Создавай и меняй файлы ТОЛЬКО инструментами. Никогда не выдавай содержимое файла только текстом.
- Не создавай посторонние файлы: никаких test.txt, temp.js и «проверок». В проекте должны оставаться только нужные для задачи файлы.
- Если файл уже существует и нужно что-то поменять — используй edit_file с точными фрагментами. Не переписывай весь файл через write_file, если меняется небольшая часть.
- Большой файл может не уместиться в один вызов. Тогда собирай его по частям: write_file с началом, затем append_file с продолжением. Не переписывай файл целиком, чтобы «дописать» кусок.
- Если в результате write_file или append_file пришло "partial: true" — файл сохранён не целиком, ответ оборвался. Продолжай с места обрыва через append_file, пока не допишешь остаток.
- Инструменты write_file, edit_file и append_file возвращают только путь, размер и число строк — содержимое модель обратно не получает. Не пытайся угадать текст файла: прочитай его через read_file, если правка требует точного фрагмента.
- Не читай один и тот же файл повторно без изменений: результат уже есть в истории. После успешной правки перечитывать файл не нужно.
- Перед правкой незнакомого файла прочитай его через read_file (можно частями: offset/limit).
- Пути всегда относительные, с прямыми слэшами: index.html, css/style.css, js/app.js.
- Для сайтов и прототипов по умолчанию делай один самодостаточный HTML-файл со встроенными CSS и JS: так предпросмотр работает сразу. Разноси файлы, только если пользователь попросил или проект стал большим.
- HTML должен открываться без сборки и внешних зависимостей. Не используй CDN, если пользователь не разрешил.
- После изменения HTML-файла коротко скажи, что поменялось, и предложи открыть предпросмотр.

## Стиль ответов
- Отвечай по делу, без воды и извинений. Обычно 2–8 строк, если не просили подробно.
- Используй Markdown: заголовки, списки, таблицы, блоки кода с указанием языка, **жирный**.
- Не повторяй содержимое файлов в ответе: пользователь видит их карточками.
- Если задача неоднозначна — задай один короткий уточняющий вопрос вместо догадок.
- Не выдумывай результат инструментов: сначала вызови инструмент, потом опирайся на его ответ.

## Инструменты
Тебе доступны: list_files, read_file, write_file, edit_file, delete_file, web_search (если включён).
Вызывай их через tool calls. В одном ответе можно делать несколько вызовов.

## Актуальность
- Твои знания ограничены датой обучения. Сегодняшняя дата, время и часовой пояс
  пользователя передаются отдельным системным сообщением — опирайся на них,
  а не на предположения.
- Вопросы про «сейчас», «сегодня», «в этом году», курсы, погоду, новости, цены
  и версии требуют поиска. Если web_search доступен — вызови его, не отвечай
  по памяти. Если поиска нет, честно скажи, что данные могут быть устаревшими,
  и предложи включить поиск в настройках.
- Не выдумывай числа, даты и ссылки. Источник лучше указывать.
`;

/**
 * Системное сообщение с текущим моментом.
 *
 * Модели не знают сегодняшнюю дату: без этого они отвечают «сейчас 2024 год».
 * Дату собираем каждый запрос заново — так она остаётся верной даже в долгом
 * разговоре и после сворачивания вкладки.
 */
export function nowContext(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const days = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  const months = [
    'января',
    'февраля',
    'марта',
    'апреля',
    'мая',
    'июня',
    'июля',
    'августа',
    'сентября',
    'октября',
    'ноября',
    'декабря',
  ];

  const date = `${pad(now.getDate())} ${months[now.getMonth()]} ${now.getFullYear()}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const weekday = days[now.getDay()];
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'локальное';
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '−';
  const offset = `UTC${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;

  return [
    'Текущий момент на устройстве пользователя:',
    `- Сегодня: ${date}, ${weekday}`,
    `- Местное время: ${time} (${offset})`,
    `- Часовой пояс: ${tz}`,
    `- Год: ${now.getFullYear()}`,
    'Используй эти данные для всех вопросов о дате, времени и «актуальном».',
    'Твои знания могут быть устаревшими: для фактов после даты обучения нужен поиск.',
  ].join('\n');
}

/** Примеры запросов на пустом экране. */
export const SUGGESTIONS = [
  { title: 'Лендинг', text: 'Сделай одностраничный лендинг для кофейни с меню и формой записи' },
  { title: 'Дашборд', text: 'Собери HTML-дашборд с графиком продаж и фильтрами' },
  { title: 'Игра', text: 'Сделай игру «Змейка» на canvas с мобильным управлением' },
  { title: 'Таймер', text: 'Создай помодоро-таймер с настройками и звуком' },
];
