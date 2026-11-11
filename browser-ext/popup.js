import { matchPatternsForOrigin, originHost } from "./pack.js";

const root = document.getElementById("root");

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function getOffer() {
  const got = await chrome.storage.session.get("offer");
  return got.offer ?? null;
}

function idle() {
  root.innerHTML = `
    <p class="idle">Nothing to import right now.<br />
    Pick the sites to share in the Mafold app, under <b>Browser</b> in Connections.</p>`;
}

function render(offer) {
  const rows = offer.sites
    .map((s) => {
      const host = originHost(s.origin);
      const fav = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
      return `<li>
        <img class="fav" src="${esc(fav)}" alt="" />
        <span><span class="name">${esc(s.label)}</span><br /><span class="host">${esc(host)}</span></span>
      </li>`;
    })
    .join("");
  root.innerHTML = `
    <p class="lead">Mafold would like the sign-ins for ${offer.sites.length === 1 ? "this site" : "these sites"},
    to use them in its own browser on this computer. They stay on your machine.</p>
    <ul>${rows}</ul>
    <button class="primary" id="grant">Share ${offer.sites.length === 1 ? "this site" : `these ${offer.sites.length} sites`}</button>
    <p class="note">Chrome will ask you to allow Mafold to read these sites. You can undo it any time from this extension.</p>`;
  document.getElementById("grant").addEventListener("click", () => grant(offer));
}

async function grant(offer) {
  const btn = document.getElementById("grant");
  btn.disabled = true;
  btn.textContent = "Waiting for Chrome…";

  const origins = [];
  for (const s of offer.sites) origins.push(...matchPatternsForOrigin(s.origin));
  const unique = [...new Set(origins)];

  let ok = false;
  try {
    ok = await chrome.permissions.request({ origins: unique });
  } catch {
    ok = false;
  }
  if (!ok) {
    btn.disabled = false;
    btn.textContent = `Share ${offer.sites.length === 1 ? "this site" : `these ${offer.sites.length} sites`}`;
    return;
  }

  btn.textContent = "Sharing…";
  const res = await chrome.runtime.sendMessage({
    type: "collect",
    origins: offer.sites.map((s) => s.origin),
  });
  if (res && res.ok) {
    root.innerHTML = `<p class="done">Done — ${res.granted.length} ${res.granted.length === 1 ? "site" : "sites"} shared with Mafold.</p>`;
  } else {
    root.innerHTML = `<p class="idle">Couldn't share: ${esc(res && res.error ? res.error : "the Mafold app isn't reachable.")}</p>`;
  }
}

getOffer().then((offer) => (offer && offer.sites.length ? render(offer) : idle()));
