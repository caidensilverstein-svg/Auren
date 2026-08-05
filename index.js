import express from 'express';
import CDP from 'chrome-remote-interface';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';

(function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(os.homedir(), '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch (_) {}
})();

const PORT = 3012;
const KEY = process.env.AUREN_MCP_KEY;
const MAC_CDP = { host: '10.8.0.3', port: 9223 };

// --- Session state ---
let eidCounter = 0;
const tabState = new Map();

function getTabState(tabId) {
  if (!tabState.has(tabId)) {
    tabState.set(tabId, { step: 0, url: '', lastFPs: new Map() });
  }
  return tabState.get(tabId);
}

// --- CDP helpers ---
async function getTarget(tabId) {
  const targets = await CDP.List(MAC_CDP);
  const pages = targets.filter(t => t.type === 'page');
  if (tabId) return pages.find(t => t.id === tabId) || pages[0];
  return pages[0];
}

async function withCDP(tabId, fn) {
  let target;
  try {
    target = await getTarget(tabId);
  } catch (e) {
    throw new Error(`Auren is offline: ${e.message}`);
  }
  if (!target) throw new Error('No open page found in Auren');
  const client = await CDP({ ...MAC_CDP, target: target.id });
  try {
    await client.Page.enable();
    await client.Runtime.enable();
    return await fn(client, target);
  } finally {
    await client.close();
  }
}

// --- XML utilities ---
function escapeXml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildElementXml(item) {
  const { kind, text, attrs } = item;
  let a = ` eid="${escapeXml(attrs.eid)}"`;
  if (attrs.href) a += ` href="${escapeXml(attrs.href)}"`;
  if (attrs.type) a += ` type="${escapeXml(attrs.type)}"`;
  if (attrs.val !== undefined && attrs.val !== '') a += ` val="${escapeXml(attrs.val)}"`;
  if (attrs.checked !== undefined) a += ` checked="${attrs.checked}"`;
  if (attrs.disabled) a += ' disabled="true"';
  if (attrs.expanded !== undefined) a += ` expanded="${attrs.expanded}"`;
  return `    <${kind}${a}>${escapeXml(text)}</${kind}>`;
}

const MAX_XML = 7500;

function buildXml(data, state, isDiff) {
  if (!data.info) {
    return `<error>Snapshot failed: ${escapeXml(data.error || 'unknown')}</error>`;
  }
  const { url, title, scroll, viewport } = data.info;
  state.step++;
  const stateTag = isDiff
    ? '<diff type="mutation" />'
    : `<baseline reason="${state.url === url ? 'reload' : 'navigation'}" />`;
  state.url = url;

  const newFPs = new Map();
  // Build body first so we can report truncation in the state tag
  let budget = MAX_XML - 200;
  let wasTruncated = false;
  let totalItemCount = 0;

  const bodyLines = [];
  for (const region of data.regions) {
    if (!region.items || !region.items.length) continue;
    totalItemCount += region.items.length;
    const rOpen = `  <region name="${escapeXml(region.name)}">`;
    const rClose = '  </region>';
    const overhead = rOpen.length + rClose.length + 2;
    if (budget - overhead < 80) break;
    budget -= overhead;

    const regionBody = [];
    let added = 0;
    for (const item of region.items) {
      const line = buildElementXml(item);
      if (budget - line.length < 80) break;
      regionBody.push(line);
      budget -= line.length + 1;
      added++;
      const fp = `${item.kind}|${item.text}|${item.attrs.href || ''}`;
      newFPs.set(fp, { eid: item.attrs.eid, kind: item.kind, text: item.text, val: item.attrs.val });
    }
    const trimmed = region.items.length - added;
    if (trimmed > 0) {
      wasTruncated = true;
      regionBody.push(`    <!-- ${trimmed} more; use region="${escapeXml(region.name)}" to see all -->`);
    }
    bodyLines.push(rOpen, ...regionBody, rClose);
  }

  state.lastFPs = newFPs;

  // FIX 3: include truncation signal in state tag so callers can detect it programmatically
  const truncatedAttr = wasTruncated ? ` truncated="true" total_items="${totalItemCount}"` : '';
  const headerLines = [
    `<state step="${state.step}" title="${escapeXml(title)}" url="${escapeXml(url)}"${truncatedAttr}>`,
    `  <meta view="${viewport[0]}x${viewport[1]}" scroll="${scroll[0]},${scroll[1]}" />`,
    `  ${stateTag}`,
  ];

  return [...headerLines, ...bodyLines, '</state>'].join('\n');
}

// --- Snapshot JS builder ---
function snapshotJs(mode, region, maxItems) {
  const mStr = JSON.stringify(mode || 'interactive');
  const rExpr = region ? `document.querySelector(${JSON.stringify(region)})` : 'null';
  const mN = Number(maxItems) || 30;
  const startN = eidCounter;

  return `(function(){
try{
let n=${startN};
function kind(el){
  const t=el.tagName.toLowerCase(),r=(el.getAttribute('role')||'').toLowerCase(),ty=(el.type||'').toLowerCase();
  if(t==='button'||r==='button'||ty==='button'||ty==='submit'||ty==='reset')return'btn';
  if((t==='a'&&el.href)||r==='link')return'lnk';
  if(t==='input'||t==='textarea'||r==='textbox'||r==='searchbox')return'inp';
  if(t==='select'||r==='combobox'||r==='listbox')return'sel';
  if(ty==='checkbox'||r==='checkbox')return'chk';
  if(ty==='radio'||r==='radio')return'chk';
  if(/^h[1-6]$/.test(t)||r==='heading')return'h';
  if(r==='alert'||r==='status')return'alert';
  if(r==='menuitem'||r==='tab'||r==='option')return'btn';
  return'elt';
}
function txt(el){
  return(el.getAttribute('aria-label')||el.textContent||el.value||el.getAttribute('placeholder')||el.getAttribute('title')||'').trim().replace(/\\s+/g,' ').slice(0,80);
}
function ex(el){
  const k=kind(el),t=txt(el),eid=k+'-'+(++n);
  el.setAttribute('data-eid',eid);
  const tg=el.tagName.toLowerCase(),a={eid};
  if(el.href)a.href=el.href.slice(0,120);
  const ty=el.type;
  if(ty&&!['text','hidden'].includes(ty))a.type=ty;
  if(el.value&&!['button','submit','reset','a'].includes(tg))a.val=String(el.value).slice(0,50);
  if(ty==='checkbox'||ty==='radio')a.checked=el.checked;
  if(el.disabled)a.disabled=true;
  const exp=el.getAttribute('aria-expanded');
  if(exp!==null)a.expanded=exp==='true';
  return{kind:k,text:t,attrs:a};
}
document.querySelectorAll('[data-eid]').forEach(e=>e.removeAttribute('data-eid'));
const mode=${mStr};
const scopeEl=${rExpr};
const maxN=${mN};
const sels={
  interactive:'a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="tab"]',
  full:'a[href],button,input:not([type="hidden"]),select,textarea,h1,h2,h3,h4,h5,h6,p,li,[role="button"],[role="link"],[role="alert"]',
  outline:'h1,h2,h3,h4,h5,h6,[role="heading"]'
};
const sel=sels[mode]||sels.interactive;
const root=scopeEl||document.body;
const info={url:location.href,title:document.title,scroll:[Math.round(window.scrollX),Math.round(window.scrollY)],viewport:[window.innerWidth,window.innerHeight]};
let regions;
if(!scopeEl){
  const lms=[
    {name:'nav',q:'nav,[role="navigation"]'},
    {name:'header',q:'header,[role="banner"]'},
    {name:'main',q:'main,[role="main"],[role="search"]'},
    {name:'aside',q:'aside,[role="complementary"]'},
    {name:'footer',q:'footer,[role="contentinfo"]'}
  ];
  const assigned=new WeakSet();
  regions=[];
  for(const lm of lms){
    const c=document.querySelector(lm.q);
    if(!c)continue;
    const items=[...c.querySelectorAll(sel)].filter(e=>{if(assigned.has(e))return false;assigned.add(e);return true;}).slice(0,maxN).map(ex);
    if(items.length)regions.push({name:lm.name,items});
  }
  const rem=[...document.body.querySelectorAll(sel)].filter(e=>!assigned.has(e)).slice(0,maxN).map(ex);
  if(rem.length)regions.push({name:'page',items:rem});
}else{
  const items=[...root.querySelectorAll(sel)].slice(0,maxN).map(ex);
  regions=[{name:'content',items}];
}
return JSON.stringify({info,regions,nextN:n});
}catch(e){return JSON.stringify({error:e.message});}
})()`;
}

async function takeSnapshot(client, resolvedTabId, opts = {}) {
  const { mode = 'interactive', region = null, maxItems = 30, isDiff = false } = opts;
  const state = getTabState(resolvedTabId);
  const js = snapshotJs(mode, region, maxItems);
  const result = await client.Runtime.evaluate({ expression: js, returnByValue: true, awaitPromise: false });
  const raw = result?.result?.value;
  if (!raw) throw new Error('Snapshot returned no value');
  const data = JSON.parse(raw);
  if (typeof data.nextN === 'number') eidCounter = data.nextN;
  return buildXml(data, state, isDiff);
}

// --- MCP server ---
function buildServer() {
  const server = new McpServer({ name: 'auren-browser', version: '2.1.2' });

  server.registerTool('browser_get_tabs', {
    description: 'List all open tabs in Auren',
    inputSchema: {}
  }, async () => {
    try {
      const targets = await CDP.List(MAC_CDP);
      const pages = targets.filter(t => t.type === 'page').map(t => ({ id: t.id, url: t.url, title: t.title }));
      return { content: [{ type: 'text', text: JSON.stringify(pages, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `<error>Auren is offline: ${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_snapshot', {
    description: 'Get a compact XML snapshot of the page with stable element IDs (eids). mode="interactive" for actionable elements (default), "outline" for heading structure, "full" for readable content. Use region= (CSS selector) to scope to a subtree. Eids from this snapshot can be passed directly to browser_click and browser_fill.',
    inputSchema: {
      tab_id: z.string().optional(),
      mode: z.enum(['interactive', 'full', 'outline']).optional(),
      region: z.string().optional(),
      max_items: z.number().optional(),
    }
  }, async ({ tab_id, mode = 'interactive', region, max_items }) => {
    try {
      return await withCDP(tab_id, async (client, target) => {
        const xml = await takeSnapshot(client, target.id, { mode, region, maxItems: max_items, isDiff: false });
        return { content: [{ type: 'text', text: xml }] };
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_snapshot">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_navigate', {
    description: 'Navigate to a URL in Auren. Returns a compact baseline snapshot of the loaded page — no need to call browser_snapshot afterwards.',
    inputSchema: { url: z.string(), tab_id: z.string().optional() }
  }, async ({ url, tab_id }) => {
    try {
      return await withCDP(tab_id, async (client, target) => {
        await client.Page.navigate({ url });
        await client.Page.loadEventFired().catch(() => {});
        await new Promise(r => setTimeout(r, 400));
        const xml = await takeSnapshot(client, target.id, { mode: 'interactive', isDiff: false });
        return { content: [{ type: 'text', text: xml }] };
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_navigate">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_click', {
    description: 'Click a UI element by eid (e.g. "btn-3") from a recent snapshot, or CSS selector. Prefer eid when available. Returns a baseline snapshot if the click caused navigation, or a mutation diff snapshot for in-page changes.',
    inputSchema: { eid: z.string().optional(), selector: z.string().optional(), tab_id: z.string().optional() }
  }, async ({ eid, selector, tab_id }) => {
    try {
      return await withCDP(tab_id, async (client, target) => {
        const EID_RE = /^(btn|lnk|inp|sel|chk|h|elt|alert)-\d+$/;
        const raw = eid || selector;
        if (!raw) return { content: [{ type: 'text', text: '<error>Provide eid or selector</error>' }] };
        const resolved = EID_RE.test(raw) ? `[data-eid="${raw}"]` : raw;

        const elResult = await client.Runtime.evaluate({
          expression: `(function(){
            const el=document.querySelector(${JSON.stringify(resolved)});
            if(!el)return null;
            const r=el.getBoundingClientRect();
            return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),text:(el.textContent||el.value||'').trim().slice(0,60),tag:el.tagName.toLowerCase(),href:el.href||''});
          })()`,
          returnByValue: true
        });

        if (!elResult?.result?.value) {
          return { content: [{ type: 'text', text: `<error>Element not found: ${escapeXml(raw)}</error>` }] };
        }
        const el = JSON.parse(elResult.result.value);

        // FIX 1: capture URL before action — check after to detect any navigation,
        // including form submissions and JS-triggered navigations, not just <a> clicks
        const state = getTabState(target.id);
        const prevUrl = state.url;

        if (el.href && el.tag === 'a') {
          await client.Page.navigate({ url: el.href });
          await client.Page.loadEventFired().catch(() => {});
          await new Promise(r => setTimeout(r, 400));
        } else {
          // Use JS .click() — fires native events including form submit, unlike raw mouse events
          await client.Runtime.evaluate({ expression: `(function(){const el=document.querySelector(\${JSON.stringify(resolved)});if(el)el.click();})()` });
          await new Promise(r => setTimeout(r, 350));
          // Check if JS click triggered a navigation
          const urlCheck = await client.Runtime.evaluate({ expression: 'location.href', returnByValue: true });
          const currentUrl = urlCheck?.result?.value || '';
          if (currentUrl !== prevUrl) {
            // Navigation detected — wait for it to settle
            await client.Page.loadEventFired().catch(() => {});
            await new Promise(r => setTimeout(r, 300));
          } else {
            // No navigation yet — also try mouse events for elements that need pointer interaction
            await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: el.x, y: el.y, button: 'left', clickCount: 1 });
            await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: el.x, y: el.y, button: 'left', clickCount: 1 });
            await new Promise(r => setTimeout(r, 200));
          }
        }

        // Determine if navigation happened by comparing state URL to pre-click URL
        const urlCheckFinal = await client.Runtime.evaluate({ expression: 'location.href', returnByValue: true });
        const didNavigate = (urlCheckFinal?.result?.value || '') !== prevUrl;

        const xml = await takeSnapshot(client, target.id, { mode: 'interactive', isDiff: !didNavigate });
        return { content: [{ type: 'text', text: xml }] };
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_click">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_fill', {
    description: 'Fill an input field by eid (e.g. "inp-5") from a recent snapshot, or CSS selector. Prefer eid when available. Returns a compact snapshot after filling — no need to call browser_snapshot afterwards.',
    inputSchema: { eid: z.string().optional(), selector: z.string().optional(), value: z.string(), tab_id: z.string().optional() }
  }, async ({ eid, selector, value, tab_id }) => {
    try {
      return await withCDP(tab_id, async (client, target) => {
        const EID_RE = /^(btn|lnk|inp|sel|chk|h|elt|alert)-\d+$/;
        const raw = eid || selector;
        if (!raw) return { content: [{ type: 'text', text: '<error>Provide eid or selector</error>' }] };
        const resolved = EID_RE.test(raw) ? `[data-eid="${raw}"]` : raw;

        const r = await client.Runtime.evaluate({
          expression: `(function(){
            const el=document.querySelector(${JSON.stringify(resolved)});
            if(!el)return'Not found';
            el.focus();
            const desc=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value');
            if(desc&&desc.set)desc.set.call(el,${JSON.stringify(value)});
            else el.value=${JSON.stringify(value)};
            el.dispatchEvent(new Event('input',{bubbles:true}));
            el.dispatchEvent(new Event('change',{bubbles:true}));
            return'ok';
          })()`,
          returnByValue: true
        });

        if (r?.result?.value === 'Not found') {
          return { content: [{ type: 'text', text: `<error>Element not found: ${escapeXml(raw)}</error>` }] };
        }
        await new Promise(res => setTimeout(res, 150));
        const xml = await takeSnapshot(client, target.id, { mode: 'interactive', isDiff: true });
        return { content: [{ type: 'text', text: xml }] };
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_fill">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_find', {
    description: 'Find elements matching a text query, CSS selector, or ARIA label. Returns up to 5 matches with eids. Use when you need to locate an element without a full page snapshot.',
    inputSchema: { query: z.string(), tab_id: z.string().optional() }
  }, async ({ query, tab_id }) => {
    try {
      return await withCDP(tab_id, async (client) => {
        const startN = eidCounter;
        const r = await client.Runtime.evaluate({
          expression: `(function(){
            let n=${startN};
            const q=${JSON.stringify(query)};
            const isSel=/^[.#[*]/.test(q)||q.includes('>')||/\\s[.#[]/.test(q);
            function kind(el){const t=el.tagName.toLowerCase(),r=(el.getAttribute('role')||'').toLowerCase(),ty=(el.type||'').toLowerCase();if(t==='button'||r==='button'||ty==='button')return'btn';if((t==='a'&&el.href)||r==='link')return'lnk';if(t==='input'||t==='textarea'||r==='textbox')return'inp';if(t==='select'||r==='combobox')return'sel';if(/^h[1-6]$/.test(t)||r==='heading')return'h';return'elt';}
            let results=[];
            if(isSel){try{results=[...document.querySelectorAll(q)].slice(0,5);}catch(_){}}
            if(!results.length){
              const all=[...document.querySelectorAll('a,button,input,select,textarea,[role],h1,h2,h3,h4,h5,h6')];
              results=all.filter(el=>(el.textContent||el.value||el.getAttribute('aria-label')||el.getAttribute('placeholder')||'').trim().toLowerCase().includes(q.toLowerCase())).slice(0,5);
            }
            const items=results.map(el=>{const k=kind(el);const eid=k+'-'+(++n);el.setAttribute('data-eid',eid);return{kind:k,eid,text:(el.textContent||el.value||el.getAttribute('aria-label')||'').trim().slice(0,80),href:el.href||'',type:el.type||''};});
            return JSON.stringify({items,nextN:n});
          })()`,
          returnByValue: true
        });

        const raw = r?.result?.value;
        if (!raw) return { content: [{ type: 'text', text: '<results count="0" />' }] };
        const data = JSON.parse(raw);
        if (typeof data.nextN === 'number') eidCounter = data.nextN;

        if (!data.items.length) {
          return { content: [{ type: 'text', text: `<results count="0">No elements matching: ${escapeXml(query)}</results>` }] };
        }
        const lines = [`<results count="${data.items.length}">`];
        for (const item of data.items) {
          let a = ` eid="${escapeXml(item.eid)}"`;
          if (item.href) a += ` href="${escapeXml(item.href.slice(0, 100))}"`;
          if (item.type && !['text', 'hidden', ''].includes(item.type)) a += ` type="${escapeXml(item.type)}"`;
          lines.push(`  <${item.kind}${a}>${escapeXml(item.text)}</${item.kind}>`);
        }
        lines.push('</results>');
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_find">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_read_section', {
    description: 'Read the readable text of a page section. Use region= with a CSS selector, landmark name (main, nav, footer, header, aside), or eid. Much smaller response than reading the full page.',
    inputSchema: {
      region: z.string().optional(),
      tab_id: z.string().optional(),
      max_chars: z.number().optional(),
    }
  }, async ({ region, tab_id, max_chars = 4000 }) => {
    try {
      return await withCDP(tab_id, async (client) => {
        const cap = Math.min(Number(max_chars) || 4000, 12000);
        const lmMap = {
          main: 'main,[role="main"]',
          nav: 'nav,[role="navigation"]',
          footer: 'footer,[role="contentinfo"]',
          header: 'header,[role="banner"]',
          aside: 'aside,[role="complementary"]'
        };
        let selExpr;
        if (!region) {
          selExpr = 'document.body';
        } else if (/^(btn|lnk|inp|sel|chk|h|elt|alert)-\d+$/.test(region)) {
          selExpr = `document.querySelector('[data-eid="${region}"]')`;
        } else if (lmMap[region]) {
          selExpr = `document.querySelector(${JSON.stringify(lmMap[region])})`;
        } else {
          selExpr = `document.querySelector(${JSON.stringify(region)})`;
        }

        const r = await client.Runtime.evaluate({
          expression: `(function(){const el=${selExpr};if(!el)return'[not found]';const t=(el.innerText||el.textContent||'').replace(/\n{3,}/g,'\n\n').trim();return t.length>${cap}?t.slice(0,${cap})+'\n[truncated]':t;})()`,
          returnByValue: true
        });
        return { content: [{ type: 'text', text: r?.result?.value ?? '[no content]' }] };
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_read_section">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_diff', {
    description: 'Return what changed on the page since the last browser_snapshot call. Shows added, removed, and value-changed elements by fingerprint comparison. Best used after in-page mutations (dropdowns, modals, form updates) — not after navigation.',
    inputSchema: { tab_id: z.string().optional() }
  }, async ({ tab_id }) => {
    try {
      return await withCDP(tab_id, async (client, target) => {
        const state = getTabState(target.id);
        const prevFPs = new Map(state.lastFPs);

        await takeSnapshot(client, target.id, { mode: 'interactive', isDiff: true });
        const currFPs = state.lastFPs;

        const added = [], removed = [], changed = [];
        for (const [fp, curr] of currFPs) {
          const prev = prevFPs.get(fp);
          if (!prev) added.push(curr);
          else if (prev.val !== curr.val) changed.push({ ...curr, prevVal: prev.val });
        }
        for (const [fp, prev] of prevFPs) {
          if (!currFPs.has(fp)) removed.push(prev);
        }

        if (!added.length && !removed.length && !changed.length) {
          return { content: [{ type: 'text', text: '<diff type="no-change" />' }] };
        }
        const lines = [`<diff added="${added.length}" removed="${removed.length}" changed="${changed.length}">`];
        for (const i of added) lines.push(`  <add eid="${escapeXml(i.eid)}" kind="${i.kind}">${escapeXml(i.text)}</add>`);
        for (const i of removed) lines.push(`  <remove eid="${escapeXml(i.eid)}" kind="${i.kind}">${escapeXml(i.text)}</remove>`);
        for (const i of changed) lines.push(`  <change eid="${escapeXml(i.eid)}" kind="${i.kind}" prevVal="${escapeXml(String(i.prevVal ?? ''))}">${escapeXml(i.text)}</change>`);
        lines.push('</diff>');
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_diff">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_screenshot', {
    description: 'Take a screenshot of the current page',
    inputSchema: { tab_id: z.string().optional() }
  }, async ({ tab_id }) => {
    try {
      return await withCDP(tab_id, async (client) => {
        const { data } = await client.Page.captureScreenshot({ format: 'png' });
        return { content: [{ type: 'image', data, mimeType: 'image/png' }] };
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_screenshot">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_execute_js', {
    description: 'Execute JavaScript in the page and return the result',
    inputSchema: { code: z.string(), tab_id: z.string().optional() }
  }, async ({ code, tab_id }) => {
    try {
      return await withCDP(tab_id, async (client) => {
        const r = await client.Runtime.evaluate({ expression: code, returnByValue: true, awaitPromise: true });
        return { content: [{ type: 'text', text: JSON.stringify(r.result.value ?? r.result.description) }] };
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_execute_js">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_scroll', {
    description: 'Scroll the page up, down, to top, or to bottom. Returns a snapshot of the new viewport after scrolling.',
    inputSchema: {
      direction: z.enum(['up', 'down', 'top', 'bottom']).optional(),
      pixels: z.number().optional(),
      tab_id: z.string().optional()
    }
  // FIX 2: return snapshot after scroll so below-fold content is immediately visible
  }, async ({ direction = 'down', pixels = 500, tab_id }) => {
    try {
      return await withCDP(tab_id, async (client, target) => {
        const expr = direction === 'top' ? 'window.scrollTo(0,0)'
          : direction === 'bottom' ? 'window.scrollTo(0,document.body.scrollHeight)'
          : direction === 'up' ? `window.scrollBy(0,-${pixels})`
          : `window.scrollBy(0,${pixels})`;
        await client.Runtime.evaluate({ expression: expr });
        await new Promise(r => setTimeout(r, 200));
        const xml = await takeSnapshot(client, target.id, { mode: 'interactive', isDiff: false });
        return { content: [{ type: 'text', text: xml }] };
      });
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_scroll">${escapeXml(e.message)}</error>` }] };
    }
  });

  server.registerTool('browser_select_tab', {
    description: 'Switch to a tab by ID (from browser_get_tabs)',
    inputSchema: { tab_id: z.string() }
  }, async ({ tab_id }) => {
    try {
      const client = await CDP({ ...MAC_CDP, target: tab_id });
      await client.Target.activateTarget({ targetId: tab_id });
      await client.close();
      return { content: [{ type: 'text', text: `Switched to tab ${tab_id}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `<error tool="browser_select_tab">${escapeXml(e.message)}</error>` }] };
    }
  });

  return server;
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'auren-mcp', version: '2.1.2' }));

async function handleMcp(req, res) {
  if (KEY && req.params.key !== KEY) return res.status(404).json({ error: 'not found' });
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { try { transport.close(); server.close(); } catch (_) {} });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: String(e.message || e) }, id: null });
  }
}

app.post('/mcp/:key', handleMcp);
app.get('/mcp/:key', (_, res) => res.status(405).json({ error: 'use POST' }));

app.listen(PORT, '127.0.0.1', () => console.log(`Auren MCP v2.1 on :${PORT}  path=/mcp/<key>  cdp=${MAC_CDP.host}:${MAC_CDP.port}`));
