#!/usr/bin/env node
// Refresh the npm-incidents chart on the "what kept going wrong" slide.
//
// The slide claims a specific cadence ("one every N days") from npm's own
// published incident record, so the number has to be re-derived rather than
// remembered. This fetches that record, redraws the chart, and rewrites both
// the SVG and the caption in index.html between the CHART markers.
//
//   node tools/refresh-chart.mjs          # fetch fresh, rewrite the slide
//   node tools/refresh-chart.mjs --offline # redraw from data/npm-incidents.json
//
// Note the API returns only the 50 most recent incidents, so the window moves
// forward over time; it is a sample of the recent past, not a full history.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HERE = new URL('./', import.meta.url);
const DECK = fileURLToPath(new URL('../index.html', HERE));
const CACHE = fileURLToPath(new URL('../data/npm-incidents.json', HERE));
const SOURCE = 'https://status.npmjs.org/api/v2/incidents.json';

const AMBER = '#F0A93B';   // minor            — the deck accent
const RED = '#E5615B';     // major / critical — the deck's "bad" token
const GRID = '#26334C';
const TXT = '#5C6B87';
const LEGEND = '#8595B0';

async function load(offline) {
    if (!offline) {
        const res = await fetch(SOURCE);
        if (!res.ok) throw new Error(`${SOURCE} responded ${res.status}`);
        const body = await res.json();
        await writeFile(CACHE, JSON.stringify(body, null, 2));
        return body;
    }
    return JSON.parse(await readFile(CACHE, 'utf-8'));
}

// One row per calendar month across the whole span, zeroes included, so the
// chart shows continuity rather than only the months that had incidents.
function monthly(incidents) {
    const bucket = new Map();
    for (const inc of incidents) {
        const key = inc.created_at.slice(0, 7);
        const row = bucket.get(key) ?? [0, 0];
        row[inc.impact === 'major' || inc.impact === 'critical' ? 1 : 0]++;
        bucket.set(key, row);
    }
    const keys = [...bucket.keys()].sort();
    const [fy, fm] = keys[0].split('-').map(Number);
    const [ly, lm] = keys.at(-1).split('-').map(Number);
    const out = [];
    for (let y = fy, m = fm; y < ly || (y === ly && m <= lm);) {
        const key = `${y}-${String(m).padStart(2, '0')}`;
        out.push([key, ...(bucket.get(key) ?? [0, 0])]);
        if (++m > 12) { m = 1; y++; }
    }
    return out;
}

// "2026-07" -> "Jul 2026" — the caption is read off a slide, not a log.
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const pretty = (k) => `${MON[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;

function chart(rows) {
    const W = 520, H = 196, L = 30, R = 6, T = 16, B = 30;
    const pw = W - L - R, ph = H - T - B;
    const slot = pw / rows.length, bw = Math.min(11, slot - 4);
    const max = Math.max(5, ...rows.map(([, a, b]) => a + b));
    const unit = ph / max, base = T + ph;
    const o = [
        `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly npm status-page incidents, ${pretty(rows[0][0])} to ${pretty(rows.at(-1)[0])}, split into minor and major-or-critical">`,
        `<title>npm incidents by month, ${pretty(rows[0][0])} to ${pretty(rows.at(-1)[0])}</title>`,
    ];
    for (let g = 0; g <= max; g += Math.max(1, Math.round(max / 2.5))) {
        const y = base - g * unit;
        o.push(`<line x1="${L}" y1="${y.toFixed(1)}" x2="${W - R}" y2="${y.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`);
        o.push(`<text x="${L - 7}" y="${(y + 3.5).toFixed(1)}" fill="${TXT}" font-family="JetBrains Mono, monospace" font-size="9" text-anchor="end">${g}</text>`);
    }
    rows.forEach(([m, minor, major], i) => {
        if (!minor && !major) return;
        const x = L + i * slot + (slot - bw) / 2;
        const hm = minor * unit, hj = major * unit, gap = minor && major ? 2 : 0;
        if (minor) o.push(`<rect x="${x.toFixed(1)}" y="${(base - hm).toFixed(1)}" width="${bw.toFixed(1)}" height="${hm.toFixed(1)}" rx="${major ? 0 : 3}" fill="${AMBER}"><title>${m}: ${minor} minor</title></rect>`);
        if (major) o.push(`<rect x="${x.toFixed(1)}" y="${(base - hm - hj - gap).toFixed(1)}" width="${bw.toFixed(1)}" height="${hj.toFixed(1)}" rx="3" fill="${RED}"><title>${m}: ${major} major/critical</title></rect>`);
    });
    o.push(`<line x1="${L}" y1="${base.toFixed(1)}" x2="${W - R}" y2="${base.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`);
    rows.forEach(([m], i) => {
        if (!m.endsWith('-01') && i !== 0) return;
        o.push(`<text x="${(L + i * slot + slot / 2).toFixed(1)}" y="${base + 15}" fill="${TXT}" font-family="JetBrains Mono, monospace" font-size="9.5" text-anchor="middle">${m.slice(0, 4)}</text>`);
    });
    o.push(`<rect x="${L}" y="${H - 11}" width="9" height="9" rx="2" fill="${AMBER}"/>`);
    o.push(`<text x="${L + 13}" y="${H - 3.5}" fill="${LEGEND}" font-family="JetBrains Mono, monospace" font-size="9.5">minor</text>`);
    o.push(`<rect x="${L + 62}" y="${H - 11}" width="9" height="9" rx="2" fill="${RED}"/>`);
    o.push(`<text x="${L + 75}" y="${H - 3.5}" fill="${LEGEND}" font-family="JetBrains Mono, monospace" font-size="9.5">major / critical</text>`);
    o.push('</svg>');
    return o.join('\n');
}

const offline = process.argv.includes('--offline');
const { incidents } = await load(offline);
const rows = monthly(incidents);

const days = Math.round(
    (Date.parse(incidents[0].created_at) - Date.parse(incidents.at(-1).created_at)) / 86400000
);
const cadence = (days / incidents.length).toFixed(1);
const serious = incidents.filter((i) => i.impact === 'major' || i.impact === 'critical').length;
const span = `${pretty(rows[0][0])} &ndash; ${pretty(rows.at(-1)[0])}`;

let deck = await readFile(DECK, 'utf-8');
const start = deck.indexOf('<!-- CHART:START');
const end = deck.indexOf('<!-- CHART:END -->');
if (start < 0 || end < 0) throw new Error('CHART markers not found in index.html');

const svg = chart(rows).split('\n').map((l) => '      ' + l).join('\n');
deck = deck.slice(0, start)
    + '<!-- CHART:START — generated by tools/refresh-chart.mjs; do not hand-edit -->\n'
    + svg + '\n      '
    + deck.slice(end);

// Keep the caption's claims in step with the data it sits under.
deck = deck.replace(
    /(<figcaption class="cap">The )\d+( most recent incidents npm publishes, )[^:]+(:\s*\n\s*<span style="color:var\(--ink-dim\)">one every )[\d.]+( days<\/span>, )\d+( of them major or critical\.)/,
    `$1${incidents.length}$2${span}$3${cadence}$4${serious}$5`
);

await writeFile(DECK, deck);
console.log(`chart: ${rows.length} months, ${span}`);
console.log(`claims: ${incidents.length} incidents, one every ${cadence} days, ${serious} major/critical`);
console.log(offline ? '(offline — redrawn from cached data)' : `(fetched from ${SOURCE})`);
