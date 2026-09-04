// A markdown renderer, in one file and with no dependencies.
//
// It covers what documentation is actually written in: headings with anchors,
// paragraphs, emphasis, code spans and fences, links and images, lists
// (nested, ordered, and task lists), blockquotes, tables, and rules. What it
// does not cover is listed at the bottom of this comment, because a renderer
// that quietly drops syntax is worse than one that says what it knows.
//
// **HTML passes through, and so does every link scheme.** GitHub sanitises both,
// and has to: it renders documents that strangers uploaded, on GitHub's own
// origin. This renders an archive the person running the server chose, and can
// read — `unzip -l` on it, or the audit step this package is built around. A
// renderer that stripped `<details>` and refused `mailto:` would be answering a
// question nobody here is asking, and would make the viewer useless for exactly
// the documents that need it.
//
// Only code is escaped, spans and fences alike, because a `<script>` written
// inside a code block is meant to be *read* rather than run. Everything else is
// emitted as written. Markdown is applied to the text between tags but never
// inside them, so an `href` full of underscores stays an href.
//
// Not supported, deliberately: reference-style links, footnotes, definition
// lists, and setext (underlined) headings. Fenced code carries its language as a
// class but nothing highlights it; an indented block has no language to carry.
//
// One departure from CommonMark, for lists: a bullet indented four spaces at the
// top level is read as a list rather than as code, because that is what somebody
// who indented a list meant, and a list that silently became a code block is a
// worse surprise than a code block that needed a fence.

export interface Rendered {
    html: string;
    /** The first level-one heading, for the page title. */
    title: string | null;
}

export function render(source: string): Rendered {
    const lines = source.replaceAll(MARK, '').replace(/\r\n?/g, '\n').split('\n');
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
const BULLET = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const HTML_BLOCK = /^ {0,3}<(?!(?:https?|mailto):)(?:[a-zA-Z!/?])/;
const INDENTED = /^(?: {4}|\t)/;
// The marker that stands in for a code span while the rest of the inline
// rules run. NUL is the one character the source cannot contain — render()
// strips it — so nothing a document says can be mistaken for one.
const MARK = String.fromCharCode(0);

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

        // Four spaces or a tab is a code block, and it keeps that meaning all
        // the way down: the whole point of writing one is that the contents are
        // not interpreted. Blank lines inside it belong to the block; the ones
        // that trail it do not.
        if (INDENTED.test(line)) {
            const body: string[] = [];
            while (i < lines.length && (INDENTED.test(lines[i]!) || lines[i]!.trim() === '')) {
                body.push(lines[i]!.replace(INDENTED, ''));
                i++;
            }
            while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
            out.push(`<pre><code>${escape(body.join('\n'))}\n</code></pre>`);
            continue;
        }

        // A block that opens with a tag is HTML, and stays HTML until a blank
        // line. Wrapping it in <p> or running emphasis over it would only
        // corrupt what the author wrote.
        if (HTML_BLOCK.test(line)) {
            const body: string[] = [];
            while (i < lines.length && lines[i]!.trim() !== '') {
                body.push(lines[i]!);
                i++;
            }
            out.push(body.join('\n'));
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
        BULLET.test(line) || HTML_BLOCK.test(line) ||
        (line.includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1]!));
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
    // How far in the current item's content sits: the marker plus the space
    // after it. `1. ` and `- ` are different widths, and `10. ` different again,
    // so a fixed guess dedents continuation lines by the wrong amount and leaves
    // a stray space in front of every fenced block inside a list.
    let width = indent + first[2]!.length + first[3]!.length;

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
            // A list ends where its kind changes: `1.` after `-` starts a new
            // list rather than continuing this one.
            if (/\d/.test(bullet[2]!) !== ordered) break;
            if (bullet[1]!.length < indent) break;
            // A blank line between items makes the whole list loose, which is
            // what decides whether items are wrapped in <p>.
            if (blanks > 0 && items.length > 0) loose = true;
            items.push([bullet[4]!]);
            width = bullet[1]!.length + bullet[2]!.length + bullet[3]!.length;
        } else if (continued) {
            if (blanks > 0) loose = true;
            // Strip this item's content indent, and no more: what is left of the
            // indentation is the author's, and a nested list or an indented block
            // needs it.
            items[items.length - 1]!.push(line.replace(new RegExp(`^ {0,${width}}`), ''));
        } else {
            break;
        }

        blanks = 0;
        i++;
    }

    const rendered = items.map((item) => {
        const [task, body] = taskOf(item);
        const html = blocks(body, state);
        // A tight item shows its text bare. Only the first paragraph's wrapper
        // comes off: what follows it is a nested list or a code block, which
        // still needs to be a block of its own.
        const content = loose ? html : html.replace(/^<p>([\s\S]*?)<\/p>(\n|$)/, '$1$2');
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
    // Code spans first, and escaped: a `<script>` written inside backticks is
    // something to read. Everything outside them keeps its angle brackets.
    const held = text.replace(/(`+)([\s\S]*?)\1/g, (_, _ticks, code: string) => {
        spans.push(`<code>${escape(code.trim())}</code>`);
        return `${MARK}${spans.length - 1}${MARK}`;
    });

    // `<https://…>` and `<mailto:…>` look like tags to the splitter below, so
    // they become anchors first — and are held aside like code spans, because an
    // anchor left in the stream would have its text linked a second time.
    const linked = held.replace(/<((?:https?|mailto):[^\s<>]+)>/g, (_, href: string) => {
        spans.push(`<a href="${url(href)}">${href}</a>`);
        return `${MARK}${spans.length - 1}${MARK}`;
    });

    // Split on tags and comments and transform only what lies between them.
    // Emphasis inside an attribute would turn href="/a_b_c" into an <em>, and a
    // bare URL inside one would nest a link in an href.
    const html = linked
        .split(/(<\/?[a-zA-Z][^>]*>|<!--[\s\S]*?-->)/g)
        .map((piece, index) => (index % 2 === 1 ? piece : marks(piece)))
        .join('');

    return html.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_, index: string) => spans[Number(index)]!);
}

/** The inline markdown itself, over a run of text with no tags in it. */
function marks(text: string): string {
    return text
        .replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"([^"]*)")?\)/g,
            (_, alt: string, src: string, title?: string) =>
                `<img src="${url(src)}" alt="${alt}"${title === undefined ? '' : ` title="${title}"`}>`)
        .replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"([^"]*)")?\)/g,
            (_, label: string, href: string, title?: string) =>
                `<a href="${url(href)}"${title === undefined ? '' : ` title="${title}"`}>${label}</a>`)
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
}

/** The plain text of an inline string, for a `<title>`. */
function plain(text: string): string {
    return text.replace(/[*_`~]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
}

/**
 * A URL for an attribute. Quotes are encoded so the attribute survives; nothing
 * else is touched. `javascript:`, `data:`, `mailto:` and whatever scheme comes
 * next all pass, because the document came from an archive the operator picked
 * and can read — filtering here would only break the documents that need it.
 */
function url(raw: string): string {
    return raw.trim().replaceAll('"', '&quot;');
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
