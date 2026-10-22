// Page-side library shared by snapshot / find / act / click / fill / read. It is written as a real function so it
// can be linted and run in any browser, and is injected with `(${pageLib})()` into each evaluate (no page globals).
//
// What it adds over document.querySelectorAll(...):
//   * accessible names (aria-labelledby, aria-label, <label> wrapping or for=, placeholder, title, alt, value,
//     selected option) instead of "whatever text the element has"
//   * the composed tree: open shadow roots and same-origin iframes are walked in document order
//   * ARIA / custom widgets (combobox, option, switch, slider, contenteditable, tabindex, onclick)
//   * row context ("Red Mug $9") for controls whose names are not unique, so "Add to cart" x6 can be told apart
//   * one scored resolver for text queries, so find and act agree
//   * viewport coordinates for elements inside same-origin iframes
export function pageLib() {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK']);
  const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/gu;
  const norm = s => String(s == null ? '' : s).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  const parentOf = el => {
    if (el.parentElement) return el.parentElement;
    const r = el.getRootNode && el.getRootNode();
    if (r && r.host) return r.host;
    const w = el.ownerDocument && el.ownerDocument.defaultView;
    try { return (w && w.frameElement) || null; } catch (e) { return null; }
  };

  // Every element in composed document order (shadow content and same-origin iframe content in place).
  function all(root) {
    const out = [];
    const rec = (node, d) => {
      if (d > 120) return;
      for (let c = node.firstElementChild; c; c = c.nextElementSibling) {
        if (SKIP.has(c.tagName)) continue;
        out.push(c);
        if (c.shadowRoot) rec(c.shadowRoot, d + 1);
        if (c.tagName === 'IFRAME' || c.tagName === 'FRAME') {
          try { const dd = c.contentDocument; if (dd && dd.documentElement) rec(dd, d + 1); } catch (e) { /* cross-origin */ }
        }
        rec(c, d + 1);
      }
    };
    rec(root || document, 0);
    return out;
  }

  // Elements a person could not see (display:none, zero size, near-zero opacity or font, off-document, aria-hidden,
  // hidden, inert) are excluded: they are the usual hiding place for prompt-injection text aimed at agents.
  function vis(el) {
    try {
      for (let e = el; e; e = parentOf(e)) {
        if (e.getAttribute && (e.getAttribute('aria-hidden') === 'true' || e.hasAttribute('hidden') || e.hasAttribute('inert'))) return false;
      }
      const w = el.ownerDocument.defaultView;
      const cs = w.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || parseFloat(cs.opacity) < 0.05) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      if (parseFloat(cs.fontSize) < 2 && !/^(input|select|textarea|button)$/i.test(el.tagName)) return false;
      const dw = el.ownerDocument.documentElement.scrollWidth;
      if (r.right + w.scrollX <= 0 || r.left + w.scrollX >= dw) return false;
      return true;
    } catch (e) { return true; }
  }

  const textOf = n => norm(n.innerText != null && n.innerText !== '' ? n.innerText : n.textContent);
  function labelText(label) {
    // text of a <label> without the controls nested in it (a wrapping label contains its own <select> options)
    const c = label.cloneNode(true);
    c.querySelectorAll('select,textarea,input,button,option,script,style').forEach(x => x.remove());
    return norm(c.textContent);
  }
  function byId(el, id) {
    const r = el.getRootNode && el.getRootNode();
    return (r && r.getElementById && r.getElementById(id)) || el.ownerDocument.getElementById(id);
  }

  // Accessible name, close to the accname spec but cheap.
  function name(el) {
    const tg = el.tagName.toLowerCase();
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = norm(lb.split(/\s+/).map(i => { const n = byId(el, i); return n ? textOf(n) : ''; }).join(' ')); if (t) return cut(t, 80); }
    const al = norm(el.getAttribute('aria-label'));
    if (al) return cut(al, 80);
    if (/^(input|select|textarea|meter|progress|output)$/.test(tg) || el.getAttribute('role') && /^(textbox|searchbox|combobox|listbox|slider|spinbutton|switch|checkbox|radio)$/.test(el.getAttribute('role'))) {
      let t = '';
      if (el.labels && el.labels.length) t = norm([...el.labels].map(labelText).join(' '));
      if (!t) { const l = el.closest && el.closest('label'); if (l) t = labelText(l); }
      if (t) return cut(t, 80);
    }
    const ty = (el.type || '').toLowerCase();
    if (tg === 'input' && /^(button|submit|reset)$/.test(ty)) return cut(norm(el.value) || (ty === 'submit' ? 'Submit' : ty === 'reset' ? 'Reset' : ''), 80);
    if (tg === 'input' && ty === 'image') return cut(norm(el.alt) || norm(el.title), 80);
    const own = norm(el.getAttribute('placeholder')) || norm(el.getAttribute('title'));
    if (/^(input|select|textarea)$/.test(tg)) return cut(own || norm(el.getAttribute('name')) || '', 80);
    const t = textOf(el);
    if (t) return cut(t, 80);
    const img = el.querySelector && el.querySelector('img[alt],svg title');
    if (img) return cut(norm(img.alt || img.textContent), 80);
    return cut(own || norm(el.getAttribute('alt')) || '', 80);
  }

  const INTERACTIVE = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[role="option"],[role="slider"],[role="spinbutton"],[role="textbox"],[role="searchbox"],[role="treeitem"],[contenteditable=""],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])';
  const FULL = INTERACTIVE + ',h1,h2,h3,h4,h5,h6,p,li,[role="heading"],[role="alert"]';
  const OUTLINE = 'h1,h2,h3,h4,h5,h6,[role="heading"]';

  function kind(el) {
    const t = el.tagName.toLowerCase(), r = (el.getAttribute('role') || '').toLowerCase(), ty = (el.type || '').toLowerCase();
    if (t === 'input' && (ty === 'checkbox' || ty === 'radio') || r === 'checkbox' || r === 'radio' || r === 'switch') return 'chk';
    if (t === 'button' || t === 'summary' || r === 'button' || ty === 'button' || ty === 'submit' || ty === 'reset' || r === 'menuitem' || r === 'menuitemcheckbox' || r === 'menuitemradio' || r === 'tab' || r === 'option' || r === 'treeitem') return 'btn';
    if (t === 'a' && el.href || r === 'link') return 'lnk';
    if (t === 'select' || r === 'combobox' || r === 'listbox') return 'sel';
    if (t === 'input' || t === 'textarea' || /^(textbox|searchbox|slider|spinbutton)$/.test(r) || el.isContentEditable && t !== 'body') return 'inp';
    if (/^h[1-6]$/.test(t) || r === 'heading') return 'h';
    if (r === 'alert' || r === 'status') return 'alert';
    return 'elt';
  }

  // The nearest ancestor that carries more text than the control itself ("Red Mug $9" for an Add to cart button).
  function context(el, nm) {
    let e = el;
    for (let i = 0; i < 6; i++) {
      e = parentOf(e);
      if (!e || e === e.ownerDocument.body || e === e.ownerDocument.documentElement) return '';
      const t = textOf(e);
      if (t.length > nm.length + 2) {
        const rest = nm ? t.split(nm).join(' ') : t;
        const r = norm(rest);
        if (r.length >= 2) return cut(r, 60);
      }
    }
    return '';
  }

  function info(el) {
    const k = kind(el), nm = name(el), tg = el.tagName.toLowerCase(), ty = (el.type || '').toLowerCase();
    const a = {};
    if (el.href && tg === 'a') a.href = String(el.href).slice(0, 120);
    if (ty && !['text', 'hidden', 'submit'].includes(ty) || ty === 'submit' && k !== 'btn') a.type = ty;
    if (tg === 'select') {
      const sel = [...el.selectedOptions].map(o => norm(o.textContent)).join(', ');
      if (sel) a.val = cut(sel, 50);
      a.opts = cut([...el.options].slice(0, 8).map(o => norm(o.textContent) || o.value).join('|'), 80);
    } else if (el.value && !/^(button|submit|reset)$/.test(ty) && tg !== 'button' && tg !== 'a' && tg !== 'li') {
      a.val = ty === 'password' ? '[redacted]' : String(el.value).slice(0, 50);
    }
    if (ty === 'checkbox' || ty === 'radio') a.checked = el.checked;
    else if (/^(checkbox|radio|switch)$/.test(el.getAttribute('role') || '')) a.checked = el.getAttribute('aria-checked') === 'true';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') a.disabled = true;
    const exp = el.getAttribute('aria-expanded');
    if (exp !== null) a.expanded = exp === 'true';
    return { kind: k, text: nm, attrs: a };
  }

  // Viewport coordinates of the element centre, correct inside nested same-origin iframes.
  function center(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    let x = r.left + r.width / 2, y = r.top + r.height / 2;
    let w = el.ownerDocument.defaultView;
    try {
      while (w && w.frameElement) {
        const f = w.frameElement, fr = f.getBoundingClientRect();
        x += fr.left + f.clientLeft; y += fr.top + f.clientTop; w = w.parent;
      }
    } catch (e) { /* cross-origin parent */ }
    return { x: Math.round(x), y: Math.round(y) };
  }

  const byEid = id => { for (const e of all()) if (e.getAttribute('data-eid') === id) return e; return null; };
  const clearEids = () => { for (const e of all()) if (e.hasAttribute('data-eid')) e.removeAttribute('data-eid'); };
  const CSSY = q => /^[.#[*]/.test(q) || q.includes('>') || /\s[.#[]/.test(q) || /^[a-z][a-z0-9-]*[.#[:]/i.test(q);

  function deepQuery(sel, limit) {
    const out = [];
    for (const e of all()) { try { if (e.matches(sel)) { out.push(e); if (out.length >= limit) break; } } catch (x) { return out; } }
    return out;
  }

  // Scored text resolver. interactiveOnly=false also matches plain text elements (for reads).
  function resolve(q, limit, interactiveOnly) {
    if (CSSY(q)) { try { const r = deepQuery(q, limit).filter(vis); if (r.length) return r.map(el => ({ el, score: 100 })); } catch (e) { /* not css */ } }
    const needle = norm(q).toLowerCase();
    const els = all();
    const pool = interactiveOnly === false ? els : els.filter(e => { try { return e.matches(INTERACTIVE); } catch (x) { return false; } });
    const hits = [];
    for (const el of pool) {
      if (!vis(el)) continue;
      const nm = name(el).toLowerCase();
      let s = 0;
      if (nm === needle) s = 100;
      else if (nm.startsWith(needle)) s = 80;
      else if (new RegExp('\\b' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(nm)) s = 60;
      else if (nm.includes(needle)) s = 40;
      else {
        const alt = [el.getAttribute('placeholder'), el.getAttribute('title'), el.getAttribute('name'), el.id, el.value && typeof el.value === 'string' && el.value.length < 40 ? el.value : ''].map(v => norm(v).toLowerCase());
        if (alt.some(v => v && v.includes(needle))) s = 30;
        else if (interactiveOnly === false && textOf(el).toLowerCase().includes(needle)) s = 20;
      }
      if (s) hits.push({ el, score: s });
    }
    if (interactiveOnly === false) {
      // prefer the deepest element that still contains the text, so a read returns the value and not the page
      const deepest = hits.filter(h => !hits.some(o => o !== h && h.el.contains(o.el) && o.score >= h.score));
      deepest.sort((a, b) => b.score - a.score);
      return deepest.slice(0, limit);
    }
    hits.sort((a, b) => b.score - a.score);   // stable: ties keep document order
    return hits.slice(0, limit);
  }

  return { norm, cut, vis, name, kind, info, context, center, all, byEid, clearEids, deepQuery, resolve, textOf,
    INTERACTIVE, FULL, OUTLINE, CSSY };
}

export const PAGE_LIB = `const __L=(${pageLib.toString()})();`;
