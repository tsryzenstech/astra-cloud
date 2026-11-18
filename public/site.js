// Shared helpers for the pages for everybody (Market, app pages, AstraID).
// The developer pages use app.js.
export { api, toast, esc, ago, size, me } from "/app.js";

export const icons = {
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
  pin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/></svg>`,
  people: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c2 .7 3.2 2.3 3.5 5.2"/></svg>`,
  key: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3"/></svg>`,
  phone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>`,
};

// The top bar of the public pages.
export function bar(active) {
  document.body.insertAdjacentHTML("afterbegin", `
    <header class="bar"><div class="wrap">
      <a class="logo" href="/"><img src="/assets/astra_white.svg" alt="">Market</a>
      <nav>
        <a href="/" class="${active === "market" ? "on" : ""}">Apps</a>
        <a href="/id/" class="${active === "id" ? "on" : ""}">AstraID</a>
        <a href="/docs/">Developers</a>
      </nav>
    </div></header>`);
}

export function foot() {
  document.body.insertAdjacentHTML("beforeend", `
    <footer class="foot"><div class="wrap">astra cloud · Market and AstraID for astraOS ·
      <a href="/docs/">SDK documentation</a> · <a href="/dev/">Developer panel</a></div></footer>`);
}
