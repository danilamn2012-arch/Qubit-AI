/**
 * Markdown-рендер для ответов модели.
 *
 * Правила безопасности: исходный HTML никогда не вставляется как есть.
 * Весь текст экранируется, теги генерирует только этот модуль.
 * Ссылки проходят allowlist схем (http, https, mailto, #).
 */

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

function safeUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const low = raw.toLowerCase().replace(/[\u0000-\u001f\s]/g, '');
  if (/^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/.test(low)) return raw;
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(raw)) return raw;
  return '';
}

/* ------------------------- Подсветка синтаксиса ------------------------- */

const KW = {
  js: 'const let var function return if else for while do switch case break continue class extends new this super import export from default async await try catch finally throw typeof instanceof in of delete void yield static get set null true false undefined',
  ts: 'const let var function return if else for while do switch case break continue class extends new this super import export from default async await try catch finally throw typeof instanceof in of delete void yield static get set null true false undefined interface type enum implements private public readonly as any never unknown string number boolean',
  json: 'true false null',
  py: 'def return if elif else for while in not and or is None True False import from as class try except finally with lambda yield assert global nonlocal pass break continue raise async await del',
  css: '',
  html: '',
  sh: 'if then else fi for while do done case esac function return export local echo cd mkdir rm sudo npm node git',
  sql: 'select from where insert into values update set delete create table drop alter join left right inner outer on group by order limit offset as and or not null primary key foreign index',
};

function keywordsFor(lang) {
  if (/^(js|javascript|jsx|mjs)$/.test(lang)) return KW.js;
  if (/^(ts|typescript|tsx)$/.test(lang)) return KW.ts;
  if (/^(json|jsonc)$/.test(lang)) return KW.json;
  if (/^(py|python)$/.test(lang)) return KW.py;
  if (/^(sh|bash|shell|zsh|console|powershell|ps1)$/.test(lang)) return KW.sh;
  if (/^(sql)$/.test(lang)) return KW.sql;
  return '';
}

/**
 * @param {string} code
 * @param {string} lang
 * @returns {string} HTML
 */
export function highlight(code, lang = '') {
  const l = String(lang || '').toLowerCase();
  if (/^(html|xml|svg|vue|htm)$/.test(l)) return highlightHtml(code);
  if (/^(css|scss|less)$/.test(l)) return highlightCss(code);
  const kwList = keywordsFor(l);
  if (!kwList) return escapeHtml(code);
  const kw = new Set(kwList.split(/\s+/).filter(Boolean));
  return highlightGeneric(code, kw);
}

function highlightGeneric(code, kw) {
  const re =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|(`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\b(0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$]*)\b/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(code))) {
    out += escapeHtml(code.slice(last, m.index));
    const [full, com, str, num, word] = m;
    if (com) out += `<span class="tok-com">${escapeHtml(com)}</span>`;
    else if (str) out += `<span class="tok-str">${escapeHtml(str)}</span>`;
    else if (num) out += `<span class="tok-num">${escapeHtml(num)}</span>`;
    else if (word) {
      const next = code[m.index + full.length] === '(';
      if (kw.has(word)) out += `<span class="tok-key">${escapeHtml(word)}</span>`;
      else if (next && /^[A-Za-z_$]/.test(word)) out += `<span class="tok-fn">${escapeHtml(word)}</span>`;
      else out += escapeHtml(word);
    }
    last = m.index + full.length;
  }
  out += escapeHtml(code.slice(last));
  return out;
}

function highlightCss(code) {
  const re = /(\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(@[\w-]+)|([.#][\w-]+)|([\w-]+)(?=\s*:)|(\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms|fr|deg)?\b)/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(code))) {
    out += escapeHtml(code.slice(last, m.index));
    const [full, com, str, at, sel, prop, num] = m;
    if (com) out += `<span class="tok-com">${escapeHtml(com)}</span>`;
    else if (str) out += `<span class="tok-str">${escapeHtml(str)}</span>`;
    else if (at) out += `<span class="tok-key">${escapeHtml(at)}</span>`;
    else if (sel) out += `<span class="tok-tag">${escapeHtml(sel)}</span>`;
    else if (prop) out += `<span class="tok-attr">${escapeHtml(prop)}</span>`;
    else if (num) out += `<span class="tok-num">${escapeHtml(num)}</span>`;
    last = m.index + full.length;
  }
  out += escapeHtml(code.slice(last));
  return out;
}

function highlightHtml(code) {
  const re = /(<!--[\s\S]*?-->)|(<\/?)([A-Za-z][\w:-]*)([^>]*?)(\/?>)/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(code))) {
    out += escapeHtml(code.slice(last, m.index));
    const [full, com, open, tag, attrs, close] = m;
    if (com) {
      out += `<span class="tok-com">${escapeHtml(com)}</span>`;
    } else {
      out += `<span class="tok-punc">${escapeHtml(open)}</span>`;
      out += `<span class="tok-tag">${escapeHtml(tag)}</span>`;
      out += highlightAttrs(attrs);
      out += `<span class="tok-punc">${escapeHtml(close)}</span>`;
    }
    last = m.index + full.length;
  }
  out += escapeHtml(code.slice(last));
  return out;
}

function highlightAttrs(attrs) {
  const re = /([\w:@.-]+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+)?/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(attrs))) {
    out += escapeHtml(attrs.slice(last, m.index));
    const [full, name, eq, val] = m;
    out += `<span class="tok-attr">${escapeHtml(name)}</span>${escapeHtml(eq)}`;
    if (val) out += `<span class="tok-str">${escapeHtml(val)}</span>`;
    last = m.index + full.length;
  }
  out += escapeHtml(attrs.slice(last));
  return out;
}

/* ---------------------------- Инлайн-разметка -------------------------- */

function inline(text) {
  const store = [];
  const keep = (html) => {
    store.push(html);
    return `\u0000${store.length - 1}\u0000`;
  };

  let s = escapeHtml(text);

  // Код в бэктиках — защищаем от дальнейшей обработки.
  s = s.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${code}</code>`));

  // Изображения ![alt](url "title")
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (m, alt, url, title) => {
    const u = safeUrl(url);
    if (!u) return m;
    return keep(
      `<img src="${escapeHtml(u)}" alt="${escapeHtml(alt)}" loading="lazy"${title ? ` title="${escapeHtml(title)}"` : ''}>`,
    );
  });

  // Ссылки [text](url)
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (m, label, url, title) => {
    const u = safeUrl(url);
    if (!u) return escapeHtml(label);
    const external = /^https?:/i.test(u);
    return keep(
      `<a href="${escapeHtml(u)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}${
        title ? ` title="${escapeHtml(title)}"` : ''
      }>${label}</a>`,
    );
  });

  // Автоссылки
  s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, (m, pre, url) => {
    const clean = url.replace(/[.,;:!?]+$/, '');
    const tail = url.slice(clean.length);
    return `${pre}${keep(
      `<a href="${escapeHtml(clean)}" target="_blank" rel="noopener noreferrer">${escapeHtml(clean)}</a>`,
    )}${tail}`;
  });

  // Жирный, курсив, зачёркнутый
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w_])__([^_\n]+)__(?!\w)/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // Переносы строк внутри абзаца
  s = s.replace(/ {2,}\n/g, '<br>');

  // Возвращаем защищённые фрагменты
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => store[Number(i)] || '');
  return s;
}

/* ------------------------------- Блоки --------------------------------- */

function isTableDivider(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function splitRow(line) {
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

function renderTable(lines) {
  const head = splitRow(lines[0]);
  const aligns = splitRow(lines[1]).map((c) => {
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    if (l && r) return 'center';
    if (r) return 'right';
    if (l) return 'left';
    return '';
  });
  const rows = lines.slice(2).map(splitRow);
  const cell = (tag, txt, i) => {
    const a = aligns[i] ? ` style="text-align:${aligns[i]}"` : '';
    return `<${tag}${a}>${inline(txt)}</${tag}>`;
  };
  let html = '<div class="table-wrap"><table><thead><tr>';
  html += head.map((c, i) => cell('th', c, i)).join('');
  html += '</tr></thead><tbody>';
  for (const row of rows) {
    html += '<tr>';
    for (let i = 0; i < head.length; i++) html += cell('td', row[i] || '', i);
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  return html;
}

function codeBlock(lang, code, closed) {
  const l = (lang || '').trim().split(/\s+/)[0];
  return `<div class="code-block" data-lang="${escapeHtml(l)}"><div class="code-block__head"><span class="lang">${escapeHtml(
    l || 'код',
  )}</span><span class="spacer"></span><button type="button" class="code-copy" data-copy-code><span>Копировать</span></button></div><pre><code>${highlight(
    code,
    l,
  )}</code></pre>${closed ? '' : ''}</div>`;
}

const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;

function parseList(lines, start, baseIndent, ordered) {
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // Пустая строка: продолжение списка, только если следующая строка — элемент
      const next = lines[i + 1];
      if (next && LIST_RE.test(next) && (next.match(/^(\s*)/)[1].length >= baseIndent || true)) {
        i++;
        continue;
      }
      break;
    }
    const m = line.match(LIST_RE);
    if (!m) {
      // Продолжение текущего элемента (вложенный текст)
      if (items.length && line.startsWith(' '.repeat(baseIndent + 2))) {
        items[items.length - 1].extra.push(line.slice(baseIndent + 2));
        i++;
        continue;
      }
      break;
    }
    const indent = m[1].length;
    if (indent < baseIndent) break;
    const isOrdered = /\d/.test(m[2]);
    if (indent === baseIndent && isOrdered !== ordered) break;
    if (indent > baseIndent) {
      // Вложенный список
      const sub = parseList(lines, i, indent, isOrdered);
      if (items.length) items[items.length - 1].children.push(sub.html);
      i = sub.next;
      continue;
    }
    items.push({ text: m[3], extra: [], children: [] });
    i++;
  }

  const tag = ordered ? 'ol' : 'ul';
  const isTasks = !ordered && items.length > 0 && items.every((it) => /^\[[ xX]\]\s/.test(it.text));
  let html = `<${tag}${isTasks ? ' class="task-list"' : ''}>`;
  for (const it of items) {
    let body = it.text;
    let task = null;
    if (isTasks) {
      const tm = body.match(/^\[([ xX])\]\s+([\s\S]*)$/);
      task = tm ? tm[1].toLowerCase() === 'x' : false;
      body = tm ? tm[2] : body;
    }
    let inner = inline(body);
    if (it.extra.length) inner += (inner ? '<br>' : '') + inline(it.extra.join(' '));
    if (isTasks) {
      inner = `<span>${inner}</span>${it.children.join('')}`;
      html += `<li data-task=""><span class="task-box${task ? ' is-done' : ''}">${task ? '✓' : ''}</span>${inner}</li>`;
    } else {
      html += `<li>${inner}${it.children.join('')}</li>`;
    }
  }
  html += `</${tag}>`;
  return { html, next: i };
}

/**
 * Рендер Markdown в HTML.
 * @param {string} src
 * @returns {string}
 */
export function renderMarkdown(src) {
  if (!src) return '';
  const text = String(src).replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  const lines = text.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // Код
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)?/);
    if (fence) {
      const marker = fence[1][0];
      const lang = fence[2] || '';
      const buf = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (new RegExp('^\\s*' + marker + '{3,}\\s*$').test(lines[i])) {
          closed = true;
          i++;
          break;
        }
        buf.push(lines[i]);
        i++;
      }
      out.push(codeBlock(lang, buf.join('\n'), closed));
      continue;
    }

    // Заголовок
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      const level = Math.min(h[1].length, 4);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Разделитель
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // Цитата
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // Таблица
    if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const buf = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        buf.push(lines[i]);
        i++;
      }
      out.push(renderTable(buf));
      continue;
    }

    // Список
    if (LIST_RE.test(line)) {
      const ordered = /\d/.test(line.match(LIST_RE)[2]);
      const indent = line.match(/^(\s*)/)[1].length;
      const res = parseList(lines, i, indent, ordered);
      out.push(res.html);
      i = res.next;
      continue;
    }

    // Абзац
    const buf = [];
    while (i < lines.length) {
      const l = lines[i];
      if (
        !l.trim() ||
        /^\s*(`{3,}|~{3,})/.test(l) ||
        /^#{1,6}\s+/.test(l) ||
        /^\s*>\s?/.test(l) ||
        LIST_RE.test(l) ||
        (l.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1]))
      ) {
        break;
      }
      buf.push(l);
      i++;
    }
    if (buf.length) out.push(`<p>${inline(buf.join('\n'))}</p>`);
    else i++;
  }

  return out.join('\n');
}

/** Удаление потенциально опасных конструкций из готового HTML (вторая линия защиты). */
export function sanitizeHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const ALLOWED = new Set([
    'P','BR','STRONG','EM','DEL','CODE','PRE','BLOCKQUOTE','HR','H1','H2','H3','H4','H5','H6',
    'UL','OL','LI','A','IMG','TABLE','THEAD','TBODY','TR','TH','TD','DIV','SPAN','BUTTON','MARK','SVG','PATH','SMALL','SUP','SUB',
  ]);
  const walk = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 1) {
        if (!ALLOWED.has(child.tagName)) {
          child.replaceWith(...Array.from(child.childNodes));
          continue;
        }
        for (const attr of Array.from(child.attributes)) {
          const name = attr.name.toLowerCase();
          if (name.startsWith('on') || name === 'srcdoc') child.removeAttribute(attr.name);
          if ((name === 'href' || name === 'src') && !safeUrl(attr.value)) child.removeAttribute(attr.name);
          if (name === 'style' && /expression|url\s*\(/i.test(attr.value)) child.removeAttribute('style');
        }
        if (child.tagName === 'A') {
          child.setAttribute('rel', 'noopener noreferrer');
          if (/^https?:/i.test(child.getAttribute('href') || '')) child.setAttribute('target', '_blank');
        }
        walk(child);
      } else if (child.nodeType === 8) {
        child.remove();
      }
    }
  };
  walk(tpl.content);
  return tpl.innerHTML;
}

/** Полный цикл: markdown → безопасный HTML. */
export function md(src) {
  return sanitizeHtml(renderMarkdown(src));
}

/** Текст без разметки (для заголовков и подсказок). */
export function plain(src) {
  return String(src || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
