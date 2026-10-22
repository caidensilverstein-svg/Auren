// Fixture "mini-web" for Auren-Bench. One HTTP server, routed by Host header (*.localhost resolves to loopback in
// Chrome and each name is a separate origin). Success is recorded server-side (POST /__done) so a task passes only
// if the page really reached the goal state, independent of what any tool reported.
import http from 'node:http';

const shell = (title, body) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title>
<style>:root{color-scheme:dark}body{font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:28px 36px;background:#111118;color:#e9e6dc}
h1{font-size:22px;margin:0 0 14px;color:#c9a84c;font-weight:600}a{color:#d9bd6a}button,input,select{font:inherit;margin:4px;padding:6px 12px;border-radius:7px;border:1px solid #34343f;background:#1a1a24;color:#e9e6dc}
button{background:#c9a84c;color:#111118;border-color:#c9a84c;font-weight:600;cursor:pointer}button:hover{background:#d9bd6a}
label{display:inline-block;margin:4px 8px 4px 0;color:#bdb9ab}.row{margin:8px 0;padding:8px 12px;background:#1a1a24;border-radius:8px}
.hide{display:none}table{border-collapse:collapse}td,th{border:1px solid #34343f;padding:5px 12px}th{background:#1a1a24;color:#c9a84c}iframe{border:1px solid #34343f;border-radius:8px;background:#111118}</style><body>${body}</body></html>`;
// JS expression that reports completion of a task with some data
const report = (task, expr = 'null') =>
  `fetch('/__done',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({task:'${task}',data:${expr}})})`;

const PRODUCTS = [['Blue Mug', 12, true], ['Red Mug', 9, true], ['Green Mug', 15, false], ['Steel Mug', 21, true], ['Tea Pot', 30, true], ['Coaster Set', 7, true]];
const ORDERS = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, name: 'Item ' + String(i + 1).padStart(2, '0'), qty: (i * 37) % 100, status: i % 4 === 0 ? 'late' : 'ok' }));
export const LATE_QTY_TOTAL = ORDERS.filter(o => o.status === 'late').reduce((a, o) => a + o.qty, 0);

export function makeSites(port) {
  const origin = h => `http://${h}.localhost:${port}`;
  const S = {};

  S.shop = (path) => {
    if (path === '/cart') return shell('Cart', `<h1>Cart</h1><ul id="cart"></ul><p>Total: <b id="total">0</b></p><button id="co">Checkout</button>
      <script>const c=JSON.parse(localStorage.cart||'[]');cart.innerHTML=c.map(i=>'<li>'+i.n+' - '+i.p+'</li>').join('');
      total.textContent=c.reduce((a,i)=>a+i.p,0);co.onclick=()=>fetch('/__done',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({task:localStorage.task||'T01',data:{cart:c.map(i=>i.n),total:c.reduce((a,i)=>a+i.p,0)}})})</script>`);
    const list = PRODUCTS.map(([n, p, s]) => `<div class="row item" data-stock="${s}" data-price="${p}"><span class="name">${n}</span> <span class="price">$${p}</span>
      <button onclick="add('${n}',${p})">Add to cart</button></div>`).join('');
    return shell('Shop', `<h1>Shop</h1><label>Search <input id="q" placeholder="Search products" oninput="flt()"></label>
      <label><input type="checkbox" id="stock" onchange="flt()"> In stock only</label>
      <label>Sort <select id="sort" onchange="srt()"><option value="n">Name</option><option value="p">Price</option></select></label>
      <div id="list">${list}</div><a href="/cart">View cart</a>
      <script>localStorage.cart='[]';localStorage.task=new URLSearchParams(location.search).get('task')||'T01';function add(n,p){const c=JSON.parse(localStorage.cart||'[]');c.push({n,p});localStorage.cart=JSON.stringify(c)}
      function flt(){const v=q.value.toLowerCase(),s=stock.checked;document.querySelectorAll('.item').forEach(e=>{e.classList.toggle('hide',!e.querySelector('.name').textContent.toLowerCase().includes(v)||(s&&e.dataset.stock!='true'))})}
      function srt(){const k=sort.value,L=[...document.querySelectorAll('.item')];L.sort((a,b)=>k=='p'?a.dataset.price-b.dataset.price:a.querySelector('.name').textContent.localeCompare(b.querySelector('.name')));L.forEach(e=>list.appendChild(e))}</script>`);
  };

  S.bank = (path) => path === '/account'
    ? shell('Account', `<h1>Account</h1><p>Balance: <b id="bal">$4,321.09</b></p><button id="out">Log out</button>
       <script>out.onclick=()=>{${report('T03', 'bal.textContent')};location.href='/'}</script>`)
    : shell('Bank', `<h1>Sign in</h1><form onsubmit="event.preventDefault();if(u.value=='ada'&&p.value=='s3cret'){location.href='/account'}else{err.textContent='Invalid credentials'}">
       <label>Username <input id="u" name="username" autocomplete="username"></label><label>Password <input id="p" type="password" name="password"></label>
       <button type="submit">Sign in</button></form><p id="err" role="alert"></p>`);

  S.grid = (path, q) => {
    const page = Number(new URLSearchParams(q).get('page') || 1);
    const slice = ORDERS.slice((page - 1) * 12, page * 12);
    return shell('Grid', `<h1>Orders</h1><p>Page ${page} of 5</p><table id="t"><thead><tr><th>ID</th><th>Name</th><th>Qty</th><th>Status</th></tr></thead><tbody>
      ${slice.map(r => `<tr><td>${r.id}</td><td>${r.name}</td><td>${r.qty}</td><td>${r.status}</td></tr>`).join('')}</tbody></table>
      <nav>${[1, 2, 3, 4, 5].map(n => `<a href="/?page=${n}">${n}</a>`).join(' ')}${page < 5 ? ` <a href="/?page=${page + 1}" rel="next">Next</a>` : ''}</nav>
      <form onsubmit="event.preventDefault();${report('T04', 'ans.value')}"><label>Late orders total quantity <input id="ans" name="answer"></label><button>Submit answer</button></form>`);
  };

  S.wizard = () => shell('Wizard', `<h1>Sign up</h1><div id="s1"><label>Email <input id="em" type="email"></label><button id="n1" onclick="v1()">Next</button><p id="m1"></p></div>
    <div id="s2" class="hide"><label>Plan <select id="plan"><option value="">Choose</option><option>Free</option><option>Pro</option></select></label><button id="n2" onclick="v2()">Next</button></div>
    <div id="s3" class="hide"><label><input type="checkbox" id="tos"> I accept the terms</label><button id="fin" onclick="v3()">Finish</button></div><p id="ok"></p>
    <script>function v1(){m1.textContent='Checking...';setTimeout(()=>{if(/@/.test(em.value)){s1.classList.add('hide');s2.classList.remove('hide')}else m1.textContent='Invalid email'},600)}
    function v2(){if(plan.value){s2.classList.add('hide');s3.classList.remove('hide')}}
    function v3(){if(tos.checked){ok.textContent='Welcome!';${report('T05', '{email:em.value,plan:plan.value}')}}}</script>`);

  S.shadow = () => shell('Shadow', `<h1>Widgets</h1><x-form></x-form><p id="out"></p>
    <script>customElements.define('x-form',class extends HTMLElement{constructor(){super();const r=this.attachShadow({mode:'open'});
    r.innerHTML='<label>Nickname <input id="nick" placeholder="Nickname"></label><button id="save">Save nickname</button>';
    r.getElementById('save').onclick=()=>{const v=r.getElementById('nick').value;document.getElementById('out').textContent='Saved '+v;${report('T06', 'v')}}}})</script>`);

  S.frames = (path) => path === '/inner'
    ? shell('Inner', `<label>Coupon <input id="coupon" placeholder="Coupon code"></label><button onclick="${report('T07', 'coupon.value')}">Apply coupon</button>`)
    : shell('Frames', `<h1>Embedded</h1><iframe id="f1" src="/inner" width="420" height="120"></iframe>
       <iframe id="f2" src="${origin('pay')}/" width="420" height="120"></iframe>`);
  S.pay = () => shell('Pay', `<button id="pay" onclick="${report('T08')}">Pay now</button>`);

  S.overlays = () => shell('Overlays', `<div id="banner" style="position:fixed;bottom:0;left:0;right:0;background:#eee;padding:12px">We use cookies. <button id="acc" onclick="banner.remove()">Accept all</button></div>
    <h1>Account settings</h1><button id="del" onclick="if(confirm('Delete everything?')){${report('T09', "!document.getElementById('banner')")};document.title='deleted'}">Delete account</button>`);

  S.feed = () => shell('Feed', `<h1>Feed</h1><div id="f"></div><div id="end" style="height:10px"></div>
    <script>let n=0;function more(){for(let i=0;i<10;i++){n++;const d=document.createElement('div');d.className='row';const a=document.createElement('a');a.href='#';a.dataset.n=n;a.textContent='Post '+n;
    a.onclick=ev=>{ev.preventDefault();${report('T10', 'a.dataset.n')}};d.appendChild(a);f.appendChild(d)}}
    more();new IntersectionObserver(e=>{if(e[0].isIntersecting)more()}).observe(end)</script>`);

  S.spa = () => shell('SPA', `<nav><a href="#/home">Home</a> <a href="#/reports">Reports</a></nav><main id="app"></main>
    <script>function r(){const h=location.hash||'#/home';app.innerHTML='<p>Loading...</p>';setTimeout(()=>{app.innerHTML=h=='#/reports'?'<h2>Reports</h2><p id="rev">Revenue: 1,234</p><button id="dl">Download</button>':'<h2>Home</h2>';
    if(h=='#/reports')dl.onclick=()=>${report('T11', "document.getElementById('rev').textContent")}},800)}addEventListener('hashchange',r);r()</script>`);

  S.tabs = (path) => path === '/code'
    ? shell('Code', `<p>Your code is <b id="code">7491</b></p>`)
    : shell('Tabs', `<h1>Verify</h1><a id="open" href="/code" target="_blank">Get code</a><br><label>Enter code <input id="entry"></label>
       <button onclick="${report('T12', 'entry.value')}">Verify</button>`);

  S.controls = () => shell('Controls', `<h1>Controls</h1>
    <div class="row"><div id="menu" onmouseenter="sub.classList.remove('hide')" onmouseleave="sub.classList.add('hide')"><span tabindex="0">Products</span>
      <div id="sub" class="hide"><a href="#" onclick="${report('T13', "'pricing'")};return false">Pricing</a></div></div></div>
    <div class="row"><div role="combobox" id="lb" tabindex="0" onclick="opts.classList.toggle('hide')" aria-label="Country">Choose country</div>
      <ul id="opts" class="hide" role="listbox"><li role="option" onclick="lb.textContent='Norway';opts.classList.add('hide');${report('T14', "'Norway'")}">Norway</li><li role="option">Chile</li></ul></div>
    <div class="row"><label>Volume <input type="range" id="vol" min="0" max="10" value="2" onchange="${report('T15', 'vol.value')}"></label></div>
    <div class="row"><label>Upload <input type="file" id="file" onchange="${report('T16', 'file.files[0]&&file.files[0].name')}"></label></div>`);

  S.stale = () => shell('Stale', `<h1>Todo</h1><div id="root"></div><script>let items=['milk','eggs','tea'];
    function draw(){root.innerHTML=items.map(i=>'<div class="row"><span>'+i+'</span> <button>Done '+i+'</button></div>').join('')}
    root.addEventListener('click',e=>{if(e.target.tagName=='BUTTON'){const n=e.target.textContent.slice(5);items=items.filter(i=>i!=n);draw();if(!items.length)${report('T17')}}});draw()</script>`);

  return { route: (host, path, q) => S[host.split('.')[0]]?.(path, q) ?? null, origin };
}

export async function startSites(port = 0) {
  const state = {};
  let sites;
  const srv = http.createServer((req, res) => {
    const [path, q = ''] = req.url.split('?');
    if (path === '/__done' && req.method === 'POST') {
      let b = ''; req.on('data', d => b += d);
      req.on('end', () => { try { const j = JSON.parse(b); (state[j.task] ||= []).push(j.data); } catch {} res.end('ok'); });
      return;
    }
    if (path === '/__state') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(state)); return; }
    if (path === '/__reset') { for (const k of Object.keys(state)) delete state[k]; res.end('ok'); return; }
    const html = sites.route(req.headers.host || '', path, q);
    if (html == null) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('content-type', 'text/html'); res.end(html);
  });
  await new Promise(r => srv.listen(port, '127.0.0.1', r));
  const p = srv.address().port;
  sites = makeSites(p);
  return { port: p, origin: sites.origin, state, close: () => srv.close() };
}
