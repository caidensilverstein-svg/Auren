// Auren-Bench tasks. Each task drives the real MCP tools the way an agent loop would (find/act/click/fill/read/
// exec/scroll/tabs); `check(state)` reads the server-side record, so a pass means the page truly reached the goal.
// `js` (optional) is the fallback an agent resorts to when the tools cannot do it: browser_execute_js. A task that
// only passes through `js` is reported as "js-only": the tool layer has a gap there.
import { LATE_QTY_TOTAL } from './sites.js';

// ---- helpers over tool responses ------------------------------------------------------------------------------------
const ELEMENT = /<(btn|lnk|inp|sel|chk|elt|h|alert) eid="([^"]+)"([^>]*)>([^<]*)<\/\1>/g;
export function elements(xml) {
  const out = [];
  for (const m of xml.matchAll(ELEMENT)) {
    const attrs = Object.fromEntries([...m[3].matchAll(/(\w+)="([^"]*)"/g)].map(a => [a[1], a[2]]));
    out.push({ kind: m[1], eid: m[2], text: m[4].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'), ...attrs });
  }
  return out;
}
const has = (xml, re) => re.test(xml);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Poll `fn` (a tool call returning text) until `ok(text)`; each poll is one tool call, like an agent re-observing.
async function until(fn, ok, tries = 6, gap = 250) {
  let last = '';
  for (let i = 0; i < tries; i++) { last = await fn(); if (ok(last)) return last; await sleep(gap); }
  return last;
}

export const TASKS = [
  {
    id: 'T01', name: 'Shop: search, cheapest mug to cart, checkout', site: 'shop',
    async run(A) {
      await A.go(A.url('shop', '/?task=T01'));
      await A.act('Search products', 'fill', 'mug');
      const listing = await A.read('#list');           // visible names + prices, e.g. "Red Mug $9 Add to cart"
      const rows = [...listing.matchAll(/([A-Za-z ]+?)\s+\$(\d+)/g)].map(m => ({ name: m[1].trim(), price: Number(m[2]) }));
      const best = rows.sort((a, b) => a.price - b.price)[0];
      const order = [...listing.matchAll(/([A-Za-z ]+?)\s+\$(\d+)/g)].map(m => m[1].trim());
      const snap = await A.snap();
      const buttons = elements(snap).filter(e => e.text === 'Add to cart');
      // an agent picks the button by its context when the snapshot gives one, otherwise by position in the list
      const pick = buttons.find(b => b.ctx && b.ctx.includes(best.name)) ?? buttons[order.indexOf(best.name)];
      await A.click(pick.eid);
      await A.act('View cart', 'click');
      await A.act('Checkout', 'click');
    },
    check: s => s.T01?.[0]?.total === 9 && s.T01[0].cart.join() === 'Red Mug',
  },
  {
    id: 'T02', name: 'Shop: in-stock filter, sort by price, add 3rd item', site: 'shop',
    async run(A) {
      await A.go(A.url('shop', '/?task=T02'));
      await A.act('In stock only', 'click');
      await A.act('Sort', 'fill', 'p');
      const listing = await A.read('#list');
      const names = [...listing.matchAll(/([A-Za-z ]+?)\s+\$(\d+)/g)].map(m => m[1].trim());   // visible order after sort
      const snap = await A.snap();
      const buttons = elements(snap).filter(e => e.text === 'Add to cart');
      const target = names[2];
      const pick = buttons.find(b => b.ctx && b.ctx.includes(target)) ?? buttons[2];
      await A.click(pick.eid);
      await A.act('View cart', 'click');
      await A.act('Checkout', 'click');
    },
    check: s => s.T02?.[0]?.cart.join() === 'Blue Mug' && s.T02[0].total === 12,
  },
  {
    id: 'T03', name: 'Bank: log in, read balance, log out', site: 'bank',
    async run(A) {
      await A.go(A.url('bank'));
      await A.act('Username', 'fill', 'ada');
      await A.act('Password', 'fill', 's3cret');
      await A.act('Sign in', 'click');
      await until(() => A.snap(), x => has(x, /Log out/));
      await A.act('Balance', 'read');
      await A.act('Log out', 'click');
    },
    check: s => s.T03?.[0] === '$4,321.09',
  },
  {
    id: 'T04', name: 'Grid: sum late-order quantities over 5 pages, submit', site: 'grid',
    async run(A) {
      let total = 0;
      for (let p = 1; p <= 5; p++) {
        await A.go(A.url('grid', `/?page=${p}`));
        const t = await A.read('#t');
        for (const m of t.matchAll(/^(\d+)\s+Item \d+\s+(\d+)\s+(late|ok)\s*$/gm)) if (m[3] === 'late') total += Number(m[2]);
      }
      await A.go(A.url('grid', '/?page=5'));
      await A.act('Late orders total quantity', 'fill', String(total));
      await A.act('Submit answer', 'click');
    },
    check: s => String(s.T04?.[0]) === String(LATE_QTY_TOTAL),
  },
  {
    id: 'T05', name: 'Wizard: 3 steps with async validation', site: 'wizard',
    async run(A) {
      await A.go(A.url('wizard'));
      await A.act('Email', 'fill', 'ada@example.com');
      await A.click((elements(await A.snap()).find(e => e.text === 'Next')).eid);
      await until(() => A.snap(), x => has(x, /Plan|sel-/));
      await A.act('Plan', 'fill', 'Pro');
      const s2 = await A.snap();
      await A.click(elements(s2).filter(e => e.text === 'Next').pop().eid);
      await until(() => A.snap(), x => has(x, /accept the terms|chk-/i));
      await A.act('accept the terms', 'click');
      await A.act('Finish', 'click');
    },
    check: s => s.T05?.[0]?.email === 'ada@example.com' && s.T05[0].plan === 'Pro',
  },
  {
    id: 'T06', name: 'Shadow DOM: fill and save inside a web component', site: 'shadow',
    async run(A) {
      await A.go(A.url('shadow'));
      await A.act('Nickname', 'fill', 'ada');
      await A.act('Save nickname', 'click');
    },
    js: async A => A.js(`(()=>{const r=document.querySelector('x-form').shadowRoot;const i=r.getElementById('nick');i.value='ada';r.getElementById('save').click();return 1})()`),
    check: s => s.T06?.[0] === 'ada',
  },
  {
    id: 'T07', name: 'Iframe (same origin): apply a coupon', site: 'frames',
    async run(A) {
      await A.go(A.url('frames'));
      await A.act('Coupon', 'fill', 'SAVE10');
      await A.act('Apply coupon', 'click');
    },
    js: async A => A.js(`(()=>{const d=document.getElementById('f1').contentDocument;d.getElementById('coupon').value='SAVE10';d.querySelector('button').click();return 1})()`),
    check: s => s.T07?.[0] === 'SAVE10',
  },
  {
    id: 'T08', name: 'Iframe (cross origin): click Pay now', site: 'frames',
    async run(A) {
      await A.go(A.url('frames'));
      await A.act('Pay now', 'click');
    },
    // no in-page JS can reach a cross-origin frame: there is no js fallback
    check: s => s.T08?.length >= 1,
  },
  {
    id: 'T09', name: 'Overlays: dismiss cookie banner, confirm a native dialog', site: 'overlays',
    async run(A) {
      await A.go(A.url('overlays'));
      await A.act('Accept all', 'click');
      await A.act('Delete account', 'click');
      if (A.has('browser_dialog')) await A.call('browser_dialog', { action: 'accept' });
    },
    check: s => s.T09?.[0] === true,
  },
  {
    id: 'T10', name: 'Feed: scroll an infinite list to Post 47 and open it', site: 'feed',
    async run(A) {
      await A.go(A.url('feed'));
      let found = '';
      for (let i = 0; i < 12 && !has(found, /Post 47</); i++) {
        await A.call('browser_scroll', { direction: 'bottom' });
        found = await A.call('browser_find', { query: 'Post 47' });
      }
      const el = elements(found).find(e => e.text === 'Post 47');
      await A.click(el.eid);
    },
    check: s => s.T10?.[0] === '47',
  },
  {
    id: 'T11', name: 'SPA: client route with delayed content, download', site: 'spa',
    async run(A) {
      await A.go(A.url('spa'));
      await A.act('Reports', 'click');
      await until(() => A.snap(), x => has(x, /Download/));
      await A.act('Download', 'click');
    },
    check: s => s.T11?.[0] === 'Revenue: 1,234',
  },
  {
    id: 'T12', name: 'Popup tab: read a code in a new tab, come back, verify', site: 'tabs',
    async run(A) {
      await A.go(A.url('tabs'));
      const before = JSON.parse(await A.call('browser_get_tabs'));
      await A.act('Get code', 'click');
      await sleep(400);
      const after = JSON.parse(await A.call('browser_get_tabs'));
      const fresh = after.find(t => !before.some(b => b.id === t.id));
      await A.call('browser_select_tab', { tab_id: fresh.id });
      const code = (await A.call('browser_read_section', { region: '#code', tab_id: fresh.id })).trim();
      await A.call('browser_select_tab', { tab_id: before[0].id });
      await A.act('Enter code', 'fill', code);
      await A.act('Verify', 'click');
    },
    check: s => s.T12?.[0] === '7491',
  },
  {
    id: 'T13', name: 'Hover menu: open a submenu and choose Pricing', site: 'controls',
    async run(A) {
      await A.go(A.url('controls'));
      if (A.has('browser_hover')) await A.call('browser_hover', { selector: '#menu span' });
      else await A.act('Products', 'click');           // without hover, an agent can only try clicking the trigger
      await A.act('Pricing', 'click');
    },
    js: async A => A.js(`(()=>{document.querySelector('#sub a').click();return 1})()`),
    check: s => s.T13?.[0] === 'pricing',
  },
  {
    id: 'T14', name: 'Custom listbox: pick Norway', site: 'controls',
    async run(A) {
      await A.go(A.url('controls'));
      await A.act('Country', 'click');
      await A.act('Norway', 'click');
    },
    check: s => s.T14?.[0] === 'Norway',
  },
  {
    id: 'T15', name: 'Range slider: set volume to 7', site: 'controls',
    async run(A) {
      await A.go(A.url('controls'));
      await A.act('Volume', 'fill', '7');
    },
    check: s => s.T15?.[0] === '7',
  },
  {
    id: 'T16', name: 'File upload: attach a file', site: 'controls',
    async run(A) {
      await A.go(A.url('controls'));
      if (A.has('browser_upload')) await A.call('browser_upload', { selector: '#file', files: [A.uploadFile] });
      else await A.act('Upload', 'click');             // opens a native picker that no tool can drive
    },
    check: s => s.T16?.[0] === 'autobench-upload.txt',
  },
  {
    id: 'T17', name: 'Re-rendering list: tick three items from one snapshot (one batch)', site: 'stale',
    async run(A) {
      await A.go(A.url('stale'));
      const btns = elements(await A.snap()).filter(e => /^Done /.test(e.text));
      // an agent that read the snapshot once and batches the three clicks; the list re-renders after each click
      await A.call('browser_exec', { steps: btns.map(b => ({ op: 'click', eid: b.eid })), final_snapshot: false });
    },
    check: s => s.T17?.length >= 1,
  },
];
