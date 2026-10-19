import * as CRYPTO from 'node:crypto';
import {
    createPost, deletePost, getRecord, putRecord, deleteRecord, backlinkDistinctCount, backlinks, fetchDidDocument,
    type NetworkOptions, type Session,
} from './atproto.ts';
import { claimedHandle, type Value } from './repo.ts';
import type { StrongRef } from './attestation.ts';
import type { ListingRecord } from './listing.ts';

// Likes: a star for an app, from anyone with an Atmosphere account.
//
//   at://<did>/com.pipobscure.bundle.like/<sha256 of the listing's address>
//   { "subject": "at://<publisher>/com.pipobscure.bundle.listing/bled",
//     "post": { "uri": "at://<did>/app.bsky.feed.post/…", "cid": "…" }, … }
//
// A like is of an app's listing, not of one release, so it stays with the app
// as it is released again. Its key is the hash of what it likes, so an account
// likes an app once, and unliking finds it again. And it always comes with a
// post, from the same account, saying so: what the app is, the person's own
// words if they give some, and the app's `nzip:` link, so that whoever reads
// it can install it in one click.
//
// Likes vouch for nothing, and nothing installs or refuses by them. They are
// counted the way listings are found, through a backlink index — by the
// accounts that like an app, so one account writing many records counts once —
// and `likers()` fetches each from its author's PDS and verifies it.

/** The collection a like is a record in. */
export const LIKE = 'com.pipobscure.bundle.like';

/** A like, as it is written. */
export interface LikeRecord {
    $type: typeof LIKE;
    /** The `at://` address of the app's listing. */
    subject: string;
    /** The post that says so. */
    post?: StrongRef | undefined;
    createdAt: string;
}

/** The longest post the Atmosphere's microblog takes, in characters. */
export const POST_GRAPHEMES = 300;
/** …and in bytes of UTF-8. */
export const POST_BYTES = 3000;

/** Where an account's like of the listing at `subject` is kept: the hash of the address. */
export function likeKey(subject: string): string {
    return CRYPTO.createHash('sha256').update(subject).digest('hex');
}

/** A listing, as liking one needs it. */
export interface Likeable {
    /** Its `at://` address. */
    uri: string;
    record: ListingRecord;
    /** What it installs as. */
    name: string;
    /**
     * The link the post gives: its install link, `nzip:<handle or did>/<name>`
     * — or, for bundle itself, which nobody can install by an nzip: link
     * before they have it, its page.
     */
    link: string;
}

/**
 * The link a like's post gives for the app listed at `uri`: its `nzip:`
 * install link, by `who` — the handle the person named it by, else the DID —
 * except for `self`, bundle's own listing, whose link is its page: an `nzip:`
 * link opens bundle, and whoever reads about bundle may not have it yet.
 */
export function likeLink(uri: string, who: string, name: string, self: { listing: string; home: string }): string {
    return uri === self.listing ? self.home : `nzip:${who}/${name}`;
}

/**
 * The post a like proposes: the person's own words if they give some,
 * otherwise a line saying what they like — the app's title and its
 * description, as its listing gives them — and then the app's install link,
 * as a link. The description is shortened to fit; the person's words are not,
 * and too many of them is an error.
 */
export function likePost(listing: Likeable, note?: string | undefined): Post {
    const tail = `\n\n${listing.link}`;
    let head: string;
    if (note !== undefined) {
        const long = postTooLong(`${note}${tail}`);
        if (long) throw new Error(`the note is too long for the post: with the link, ${long}`);
        head = note;
    } else {
        const title = listing.record.title || listing.name;
        head = `🌳 I like ${title}`;
        const description = listing.record.description?.trim();
        if (description) head = shorten(`${head}: ${description}`, POST_GRAPHEMES - graphemes(tail));
    }
    return postOf(`${head}${tail}`, listing.link);
}

/** A post, as the Atmosphere's microblog takes one: its text, and where the links in it are. */
export interface Post {
    text: string;
    facets: Record<string, unknown>[];
}

/**
 * The post `text` makes, with `link` marked as a link wherever it stands in
 * it, as a word of its own — the whole text is the person's, and they may
 * have moved the link, or said it twice, or taken it out, which leaves no
 * facets. Offsets are of UTF-8 bytes, as facets count them.
 */
export function postOf(text: string, link: string): Post {
    const facets: Record<string, unknown>[] = [];
    const word = /[\p{L}\p{N}_\-/]/u;
    for (let at = text.indexOf(link); at !== -1; at = text.indexOf(link, at + link.length)) {
        const end = at + link.length;
        if ((at > 0 && word.test(text[at - 1]!)) || (end < text.length && word.test(text[end]!))) continue;
        const byteStart = Buffer.byteLength(text.slice(0, at));
        facets.push({
            $type: 'app.bsky.richtext.facet',
            index: { byteStart, byteEnd: byteStart + Buffer.byteLength(link) },
            features: [{ $type: 'app.bsky.richtext.facet#link', uri: link }],
        });
    }
    return { text, facets };
}

/** Why `text` is too long for a post, or undefined when it fits. */
export function postTooLong(text: string): string | undefined {
    const count = graphemes(text);
    if (count > POST_GRAPHEMES) return `it is ${count} characters long, and a post holds ${POST_GRAPHEMES}`;
    const bytes = Buffer.byteLength(text);
    if (bytes > POST_BYTES) return `it is ${bytes} bytes long, and a post holds ${POST_BYTES}`;
    return undefined;
}

/**
 * Like the app listed at `listing`, from `session`'s account: the post first,
 * so the like can point at it, then the like; and the post taken down again
 * when the like cannot be written. The post is `post` — the text as the
 * person settled it — or else the one `likePost()` proposes, with `note`. An
 * app liked already is left as it is, and no post is made.
 */
export async function like(session: Session, listing: Likeable, { note, post: given, ...options }: NetworkOptions & { note?: string | undefined; post?: Post | undefined } = {}): Promise<{ uri: string; post?: StrongRef | undefined; already: boolean }> {
    const key = likeKey(listing.uri);
    const existing = await ownLike(session.did, listing.uri, options);
    if (existing) return { uri: `at://${session.did}/${LIKE}/${key}`, post: existing.post, already: true };
    const content = given ?? likePost(listing, note);
    const long = postTooLong(content.text);
    if (long) throw new Error(`the post is too long: ${long}`);
    const post = await createPost(session, content, options);
    try {
        const now = (options.now ?? (() => new Date()))().toISOString();
        const written = await putRecord(session, LIKE, key, { $type: LIKE, subject: listing.uri, post, createdAt: now } satisfies LikeRecord as Record<string, unknown>, options);
        return { uri: written.uri, post, already: false };
    } catch (err) {
        await deletePost(session, post.uri, options).catch(() => {});
        throw err;
    }
}

/** Take back a like of the listing at `subject`, and the post it made. False when there was none. */
export async function unlike(session: Session, subject: string, options: NetworkOptions = {}): Promise<boolean> {
    const existing = await ownLike(session.did, subject, options);
    if (!existing) return false;
    await deleteRecord(session, LIKE, likeKey(subject), options);
    if (existing.post?.uri.startsWith(`at://${session.did}/`)) await deletePost(session, existing.post.uri, options).catch(() => {});
    return true;
}

/**
 * The account `did`'s like of the listing at `subject`, as its repository
 * has it, verified; null when it has none. A read anyone can make, so asking
 * needs no sign-in.
 */
export async function ownLike(did: string, subject: string, options: NetworkOptions = {}): Promise<LikeRecord | null> {
    const found = await getRecord(did, LIKE, likeKey(subject), options);
    return found ? readLike(found.value, subject) : null;
}

/** A like, if `value` is one of `subject`, in the shape the lexicon gives. */
export function readLike(value: Value, subject: string): LikeRecord | null {
    const record = value as Partial<LikeRecord> | null;
    if (!record || typeof record !== 'object' || record.$type !== LIKE || record.subject !== subject) return null;
    const post = record.post && typeof record.post === 'object' && typeof record.post.uri === 'string' && typeof record.post.cid === 'string'
        ? { uri: record.post.uri, cid: record.post.cid } : undefined;
    return { $type: LIKE, subject, post, createdAt: typeof record.createdAt === 'string' ? record.createdAt : '' };
}

/**
 * How many accounts like the app listed at `subject`, by a backlink index:
 * accounts, not records, so one account writing many counts once. A count, not
 * a verification — `likers()` is that.
 */
export async function countLikes(subject: string, options: NetworkOptions & { index: string }): Promise<number> {
    return await backlinkDistinctCount(subject, LIKE, '.subject', options);
}

/** One account that likes an app, as `likers()` found and verified it. */
export interface Liker {
    did: string;
    /** The handle its DID document claims, for display only. */
    handle?: string | undefined;
    createdAt: string;
    post?: StrongRef | undefined;
    /** The post's text, when it could be fetched. */
    text?: string | undefined;
}

/**
 * The accounts that like the app listed at `subject`, newest first, up to
 * `limit`: found through the backlink index, then each like fetched from its
 * author's own PDS and verified, and its post read. A like that does not check
 * out, or is not at the key a like of this app is kept at, is left out.
 */
export async function likers(subject: string, { index, limit = 25, ...options }: NetworkOptions & { index: string; limit?: number | undefined }): Promise<Liker[]> {
    const seen = new Set<string>();
    const found: Liker[] = [];
    const key = likeKey(subject);
    for await (const link of backlinks(subject, `${LIKE}:subject`, { ...options, index })) {
        if (link.collection !== LIKE || link.rkey !== key || seen.has(link.did)) continue;
        seen.add(link.did);
        try {
            const record = await getRecord(link.did, LIKE, key, options);
            const read = record ? readLike(record.value, subject) : null;
            if (!read) continue;
            const doc = await fetchDidDocument(link.did, options);
            const liker: Liker = { did: link.did, handle: claimedHandle(doc) ?? undefined, createdAt: read.createdAt, post: read.post };
            if (read.post) liker.text = await postText(read.post, options);
            found.push(liker);
        } catch {
            // One account that cannot be asked is not the others' problem.
        }
        if (found.length >= limit) break;
    }
    return found.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

async function postText(post: StrongRef, options: NetworkOptions): Promise<string | undefined> {
    const match = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(post.uri);
    if (!match) return undefined;
    try {
        const found = await getRecord(match[1]!, match[2]!, match[3]!, options);
        const text = (found?.value as { text?: unknown } | null)?.text;
        return typeof text === 'string' ? text : undefined;
    } catch {
        return undefined;
    }
}

function graphemes(text: string): number {
    return [...new Intl.Segmenter().segment(text)].length;
}

// `text` cut to `max` characters, with an ellipsis where it was cut.
function shorten(text: string, max: number): string {
    const parts = [...new Intl.Segmenter().segment(text)].map(({ segment }) => segment);
    return parts.length <= max ? text : `${parts.slice(0, max - 1).join('').trimEnd()}…`;
}

