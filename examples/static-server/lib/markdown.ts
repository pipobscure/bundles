// A markdown renderer, in one file and with no dependencies.
//
// It covers what documentation is actually written in: headings with anchors,
// paragraphs, emphasis, code spans and fences, links and images, lists
// (nested, ordered, and task lists), blockquotes, tables, and rules. What it
// does not cover is listed at the bottom of this comment, because a renderer
// that quietly drops syntax is worse than one that says what it knows.
//
// **Embedded HTML is escaped, not passed through.** GitHub renders a documented
// subset of inline HTML; this renders none. The content here comes out of an
// archive somebody handed the server, and "the document can inject markup into
// the page" is a decision worth making deliberately rather than inheriting. The
// escaping happens before anything else, so every later pass works on text that
// can no longer become a tag.
//
// Not supported, deliberately: raw HTML, reference-style links, footnotes,
// definition lists, and setext (underlined) headings. Fenced code carries its
// language as a class but nothing highlights it.

export interface Rendered {
    html: string;
    /** The first level-one heading, for the page title. */
    title: string | null;
}

export function render(source: string): Rendered {
    const lines = source.replaceAll('\u0000', '').replace(/\r\n?/g, '\n').split('\n');
    const slugs = new Map<string, number>();
    const state: State = { slugs, title: null };
    return { html: blocks(lines, state), title: state.title };
}

interface State {
    slugs: Map<string, number>;
    title: string | null;
}

const FENCE = /^ {0,3}(```+|~~~+)\s*([\w+-]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])\s*(?:\1\s*){2,}$/;
const BULLET = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;

/** Renders a run of lines as block-level markdown. */
function blocks(lines: string[], state: State): string {
    const out: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i]!;

        if (line.trim() === '') {
            i++;
            continue;
        }

        const fence = FENCE.exec(line);
        if (fence !== null) {
            const marker = fence[1]!;
            const language = fence[2]!;
            const body: string[] = [];
            i++;
            while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i]!)) {
                body.push(lines[i]!);
                i++;
            }
            i++; // the closing fence, or the end of the input
            const attribute = language === '' ? '' : ` class="language-${escape(language)}"`;
            out.push(`<pre><code${attribute}>${escape(body.join('\n'))}\n</code></pre>`);
            continue;
        }

        const heading = HEADING.exec(line);
        if (heading !== null) {
            const level = heading[1]!.length;
            const text = heading[2]!;
            const id = slug(text, state.slugs);
            if (level === 1 && state.title === null) state.title = plain(text);
            out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
            i++;
            continue;
        }

        if (RULE.test(line)) {
            out.push('<hr>');
            i++;
            continue;
        }

        if (QUOTE.test(line)) {
            const body: string[] = [];
            while (i < lines.length) {
                const quoted = QUOTE.exec(lines[i]!);
                if (quoted === null) {
                    // A blank line ends the quote; a plain one is a lazy
                    // continuation of the paragraph inside it.
                    if (lines[i]!.trim() === '') break;
                    body.push(lines[i]!);
                } else {
                    body.push(quoted[1]!);
                }
                i++;
            }
            out.push(`<blockquote>${blocks(body, state)}</blockquote>`);
            continue;
        }

        if (BULLET.test(line)) {
            const [html, next] = list(lines, i, state);
            out.push(html);
            i = next;
            continue;
        }

        if (line.includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1]!)) {
            const [html, next] = table(lines, i);
            out.push(html);
            i = next;
            continue;
        }

        const paragraph: string[] = [];
        while (i < lines.length && lines[i]!.trim() !== '' && !isBlockStart(lines, i)) {
            // trimStart only: two trailing spaces are a hard line break,
            // and trimming both ends would silently delete it.
            paragraph.push(lines[i]!.trimStart());
            i++;
        }
        out.push(`<p>${inline(paragraph.join('\n'))}</p>`);
    }

    return out.join('\n');
}

/** Whether the line at `i` starts a block that a paragraph must stop before. */
function isBlockStart(lines: string[], i: number): boolean {
    const line = lines[i]!;
    return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) ||
        BULLET.test(line) || (line.includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1]!));
}

/**
 * A list, and the line after it. Items are gathered by indentation and their
 * contents rendered as blocks, so a list holds whatever markdown you put in it —
 * nested lists included.
 */
function list(lines: string[], start: number, state: State): [string, number] {
    const first = BULLET.exec(lines[start]!)!;
    const indent = first[1]!.length;
    const ordered = /\d/.test(first[2]!);
    const items: string[][] = [];
    let loose = false;
    let i = start;
    let blanks = 0;

    while (i < lines.length) {
        const line = lines[i]!;
        if (line.trim() === '') {
            blanks++;
            i++;
            continue;
        }

        const bullet = BULLET.exec(line);
        const own = bullet !== null && bullet[1]!.length <= indent;
        const continued = items.length > 0 && line.search(/\S/) > indent;

        if (own) {
            // A blank line between items makes the whole list loose, which is
            // what decides whether items are wrapped in <p>.
            if (blanks > 0 && items.length > 0) loose = true;
            if (bullet[1]!.length < indent) break;
            items.push([bullet[3]!]);
        } else if (continued) {
            if (blanks > 0) loose = true;
            // Keep the relative indentation so a nested list still parses.
            items[items.length - 1]!.push(line.slice(indent + 2));
        } else {
            break;
        }

        blanks = 0;
        i++;
    }

    const rendered = items.map((item) => {
        const [task, body] = taskOf(item);
        const html = blocks(body, state);
        const content = loose ? html : html.replace(/^<p>([\s\S]*)<\/p>$/, '$1');
        return `<li${task === null ? '' : ' class="task"'}>${task ?? ''}${content}</li>`;
    }).join('\n');

    const tag = ordered ? 'ol' : 'ul';
    return [`<${tag}>\n${rendered}\n</${tag}>`, i];
}

/** Splits `- [x] done` into its checkbox and the rest. */
function taskOf(item: string[]): [string | null, string[]] {
    const match = /^\[([ xX])\]\s+(.*)$/.exec(item[0] ?? '');
    if (match === null) return [null, item];
    const checked = match[1] !== ' ' ? ' checked' : '';
    const box = `<input type="checkbox" disabled${checked}> `;
    return [box, [match[2]!, ...item.slice(1)]];
}

const TABLE_RULE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function isTableRule(line: string): boolean {
    return line.includes('-') && TABLE_RULE.test(line);
}

/** A GFM table, and the line after it. */
function table(lines: string[], start: number): [string, number] {
    // GFM splits on every pipe, escaped ones excepted — which is the only way
    // to write a pipe inside a cell, code span or not.
    const cells = (line: string): string[] =>
        line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll('\\|', '|'));

    const header = cells(lines[start]!);
    const aligns = cells(lines[start + 1]!).map((rule) => {
        const left = rule.startsWith(':');
        const right = rule.endsWith(':');
        if (left && right) return ' style="text-align:center"';
        if (right) return ' style="text-align:right"';
        return left ? ' style="text-align:left"' : '';
    });

    let i = start + 2;
    const rows: string[][] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && lines[i]!.includes('|')) {
        rows.push(cells(lines[i]!));
        i++;
    }

    const head = header.map((cell, n) => `<th${aligns[n] ?? ''}>${inline(cell)}</th>`).join('');
    const body = rows.map((row) =>
        `<tr>${header.map((_, n) => `<td${aligns[n] ?? ''}>${inline(row[n] ?? '')}</td>`).join('')}</tr>`).join('\n');

    return [`<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`, i];
}

/**
 * Inline markdown. Escaping runs first, so nothing after it can produce a tag
 * that was not written here; code spans are then lifted out before emphasis and
 * links are applied, so `` `**not bold**` `` stays literal.
 */
function inline(text: string): string {
    const spans: string[] = [];
    let html = escape(text).replace(/(`+)([\s\S]*?)\1/g, (_, _ticks, code: string) => {
        spans.push(`<code>${code.trim()}</code>`);
        return `\u0000${spans.length - 1}\u0000`;
    });

    html = html
        .replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"([^"]*)")?\)/g,
            (_, alt: string, src: string, title?: string) =>
                `<img src="${url(src)}" alt="${alt}"${title === undefined ? '' : ` title="${title}"`}>`)
        .replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"([^"]*)")?\)/g,
            (_, label: string, href: string, title?: string) =>
                `<a href="${url(href)}"${title === undefined ? '' : ` title="${title}"`}>${label}</a>`)
        .replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_, href: string) => `<a href="${url(href)}">${href}</a>`)
        .replace(/(^|[\s(])(https?:\/\/[^\s<>()]+)/g,
            (_, before: string, href: string) => `${before}<a href="${url(href)}">${href}</a>`)
        .replace(/\*\*([^\s*][\s\S]*?)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^\s_][\s\S]*?)__/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^\s*][\s\S]*?)\*/g, '$1<em>$2</em>')
        .replace(/(^|[^\w_])_([^\s_][\s\S]*?)_/g, '$1<em>$2</em>')
        .replace(/~~([\s\S]+?)~~/g, '<del>$1</del>')
        // Two trailing spaces are markdown's hard break; a single newline inside
        // a paragraph is just how the source was wrapped.
        .replace(/ {2,}\n/g, '<br>\n');

    return html.replace(/\u0000(\d+)\u0000/g, (_, index: string) => spans[Number(index)]!);
}

/** The plain text of an inline string, for a `<title>`. */
function plain(text: string): string {
    return text.replace(/[*_`~]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
}

/**
 * A URL for an attribute. Anything that is not plainly a path, a fragment, or
 * an http(s)/mailto URL is dropped: `javascript:` in a link is the one way a
 * document with no HTML in it can still run code in the page.
 */
function url(raw: string): string {
    const value = raw.trim();
    if (/^(https?:|mailto:)/i.test(value) || /^[^a-z]/i.test(value) || !value.includes(':')) {
        return value.replaceAll('"', '&quot;');
    }
    return '#';
}

/** GitHub's heading anchors: lowercase, spaces to hyphens, punctuation dropped. */
function slug(text: string, seen: Map<string, number>): string {
    const base = plain(text).toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-') || 'section';
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
}

function escape(text: string): string {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
