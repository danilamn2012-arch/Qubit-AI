/**
 * Универсальные элементы: тосты, подтверждения, модалки, меню, копирование.
 */

import { icon } from './icons.js';

/* ------------------------------- Тосты -------------------------------- */

function toastRoot() {
  let el = document.querySelector('.toast-root');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast-root';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  return el;
}

export function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ` toast--${kind}` : '');
  const ic = kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'info';
  el.innerHTML = `${icon(ic, 15)}<span></span>`;
  el.querySelector('span').textContent = message;
  toastRoot().appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 220ms ease, transform 220ms ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 240);
  }, 2600);
}

/* ------------------------------- Копирование ---------------------------- */

export async function copyText(text) {
  const value = String(text ?? '');
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* падаем в fallback */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    toast('Не удалось скопировать', 'error');
    return false;
  }
}

export function download(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ------------------------------- Модалки -------------------------------- */

const openModals = [];

export function openModal({ title, subtitle = '', body, footer = '', wide = false, file = false, onClose, className = '' }) {
  const root = document.createElement('div');
  root.className = 'modal-root';
  root.innerHTML = `
    <div class="modal ${wide ? 'modal--wide' : ''} ${file ? 'modal--file' : ''} ${className}" role="dialog" aria-modal="true" aria-label="${escapeAttr(
      title || 'Окно',
    )}">
      <div class="modal__head">
        <div class="modal-title-wrap">
          <h2></h2>
          ${subtitle ? '<span class="sub"></span>' : ''}
        </div>
        <button type="button" class="icon-btn" data-close aria-label="Закрыть">${icon('close', 18)}</button>
      </div>
      <div class="modal__body" data-body></div>
      ${footer ? '<div class="modal__foot" data-foot></div>' : ''}
    </div>`;
  root.querySelector('h2').textContent = title || '';
  if (subtitle) root.querySelector('.sub').textContent = subtitle;

  const bodyEl = root.querySelector('[data-body]');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body instanceof Node) bodyEl.appendChild(body);

  if (footer) {
    const footEl = root.querySelector('[data-foot]');
    if (typeof footer === 'string') footEl.innerHTML = footer;
    else if (footer instanceof Node) footEl.appendChild(footer);
  }

  document.body.appendChild(root);
  document.body.style.overflow = 'hidden';

  const prevFocus = document.activeElement;
  const close = () => {
    const i = openModals.indexOf(api);
    if (i >= 0) openModals.splice(i, 1);
    root.remove();
    if (!openModals.length) document.body.style.overflow = '';
    if (prevFocus && prevFocus.focus) prevFocus.focus();
    onClose && onClose();
  };
  const api = { root, body: bodyEl, foot: root.querySelector('[data-foot]'), close };
  openModals.push(api);

  root.addEventListener('click', (e) => {
    if (e.target === root) close();
    if (e.target.closest('[data-close]')) close();
  });

  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusable = root.querySelectorAll(
      'button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  setTimeout(() => {
    const focusTarget = root.querySelector('[data-autofocus]') || root.querySelector('input, textarea, button[data-close]');
    focusTarget && focusTarget.focus();
  }, 30);

  return api;
}

export function closeTopModal() {
  const top = openModals[openModals.length - 1];
  if (top) {
    top.close();
    return true;
  }
  return false;
}

export function hasModal() {
  return openModals.length > 0;
}

/** Подтверждение действия. Возвращает Promise<boolean>. */
export function confirmDialog({ title, message, confirmLabel = 'Удалить', danger = true }) {
  return new Promise((resolve) => {
    let result = false;
    const modal = openModal({
      title,
      body: `<p style="margin:0;color:var(--text-2);font-size:14px;line-height:1.6"></p>`,
      footer: `<button type="button" class="btn" data-close>Отмена</button><span class="spacer"></span><button type="button" class="btn ${
        danger ? 'btn--danger' : 'btn--primary'
      }" data-confirm></button>`,
      onClose: () => resolve(result),
    });
    modal.body.querySelector('p').textContent = message;
    const btn = modal.root.querySelector('[data-confirm]');
    btn.textContent = confirmLabel;
    btn.addEventListener('click', () => {
      result = true;
      modal.close();
    });
  });
}

/* ------------------------- Контекстное меню ----------------------------- */

let activeMenu = null;

export function closeMenu() {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKey, true);
  }
}

function onDocClick(e) {
  if (activeMenu && !activeMenu.contains(e.target)) closeMenu();
}

function onKey(e) {
  if (e.key === 'Escape') closeMenu();
}

/**
 * @param {HTMLElement} anchor
 * @param {Array<{label:string, icon?:string, danger?:boolean, sep?:boolean, onClick?:Function}>} items
 * @param {{align?: 'left'|'right'}} opts
 */
export function openMenu(anchor, items, opts = {}) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'popover';
  menu.style.minWidth = '190px';
  menu.innerHTML = items
    .map((it) => {
      if (it.sep) return '<div class="menu-sep"></div>';
      return `<button type="button" class="menu-item${it.danger ? ' menu-item--danger' : ''}">${
        it.icon ? icon(it.icon, 16) : ''
      }<span></span></button>`;
    })
    .join('');
  const buttons = menu.querySelectorAll('.menu-item');
  let bi = 0;
  items.forEach((it) => {
    if (it.sep) return;
    const btn = buttons[bi++];
    btn.querySelector('span').textContent = it.label;
    btn.addEventListener('click', () => {
      closeMenu();
      it.onClick && it.onClick();
    });
  });

  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = opts.align === 'right' ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.position = 'fixed';

  activeMenu = menu;
  setTimeout(() => {
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  return menu;
}

export function escapeAttr(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export { icon };
