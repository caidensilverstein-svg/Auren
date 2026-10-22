| id | task | result | tool calls | response chars | ms |
|---|---|---|---:|---:|---:|
| T01 | Shop: search, cheapest mug to cart, checkout | pass | 7 | 3355 | 758 |
| T02 | Shop: in-stock filter, sort by price, add 3rd item | FAIL | 8 | 3035 | 679 |
| T03 | Bank: log in, read balance, log out | FAIL | 12 | 2634 | 2062 |
| T04 | Grid: sum late-order quantities over 5 pages, submit | FAIL | 13 | 6255 | 920 |
| T05 | Wizard: 3 steps with async validation | FAIL | 21 | 5423 | 3749 |
| T06 | Shadow DOM: fill and save inside a web component | js-only | 3 | 266 | 410 |
| T07 | Iframe (same origin): apply a coupon | js-only | 3 | 263 | 406 |
| T08 | Iframe (cross origin): click Pay now | FAIL | 2 | 205 | 426 |
| T09 | Overlays: dismiss cookie banner, confirm a native dialog | FAIL | 2 | 542 | 20208 |
| T10 | Feed: scroll an infinite list to Post 47 and open it | FAIL | 10 | 12409 | 15585 |
| T11 | SPA: client route with delayed content, download | pass | 4 | 1616 | 15495 |
| T12 | Popup tab: read a code in a new tab, come back, verify | FAIL | 4 | 735 | 621 |
| T13 | Hover menu: open a submenu and choose Pricing | js-only | 3 | 662 | 15465 |
| T14 | Custom listbox: pick Norway | FAIL | 3 | 893 | 523 |
| T15 | Range slider: set volume to 7 | FAIL | 2 | 356 | 395 |
| T16 | File upload: attach a file | FAIL | 2 | 356 | 374 |
| T17 | Re-rendering list: tick three items from one snapshot (one batch) | FAIL | 3 | 852 | 466 |
