// Shared helpers for the astra cloud pages.
export async function api(method, url, body, raw) {
  const opts = { method, headers: {}, credentials: "same-origin" };
  if (raw) {
    opts.body = raw;
    opts.headers["Content-Type"] = "application/octet-stream";
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, opts);
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

export function toast(text) {
  let t = document.querySelector(".toast");
  if (!t) {
    t = document.createElement("div");
    t.className = "toast";
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.style.display = "block";
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.style.display = "none"), 3200);
}

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const ago = (t) => {
  if (!t) return "never";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};
export const size = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB");

export async function me() {
  try {
    return await api("GET", "/api/auth/me");
  } catch {
    return null;
  }
}

export function header(active) {
  document.body.insertAdjacentHTML("afterbegin", `
    <header class="top"><div class="wrap">
      <a href="/"><img src="/assets/astra_white.svg" alt="astra" style="filter: var(--logo-filter, none)"></a>
      <nav>
        <a href="/#store" class="${active === "store" ? "on" : ""}">Market</a>
        <a href="/docs/" class="${active === "docs" ? "on" : ""}">Developers</a>
        <a href="/dev/" class="${active === "dev" ? "on" : ""}">Developer panel</a>
        <a href="/id/" class="${active === "id" ? "on" : ""}">AstraID</a>
      </nav>
    </div></header>`);
  if (matchMedia("(prefers-color-scheme: light)").matches) document.documentElement.style.setProperty("--logo-filter", "invert(1)");
}
