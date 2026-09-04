# The documentation viewer

Point this server at a directory or an archive of markdown files and you have a
documentation site. No build step, no configuration, no generator — the files
are rendered as they are served.

```sh
./static-server.run docs.zip
```

`README.md` stands in for `index.html`, so this page is what `/` returns.

## What gets rendered

| Written | Rendered as |
|---|---|
| `# Heading` | a heading, with a GitHub-style anchor |
| `` `code` `` and fences | `<code>` and `<pre>`, escaped |
| `[link](guide/)` | a link — *relative ones work between files* |
| `- [ ] task` | a task list |
| tables, quotes, rules | what you would expect |

Read [the guide](guide/) for the details, or the
[caching notes](guide/caching.md) for what the server does with the result.

<details>
<summary>HTML works too — this section is a <code>&lt;details&gt;</code> block</summary>

Markdown still renders inside it, and *nothing here is sanitised*: the archive
being served is one you chose and can read, so a viewer that stripped tags would
only get in the way. Code is escaped, because a `<script>` in a fence is meant
to be read.

</details>

## Try it

- [ ] serve this directory
- [x] read this page
- [x] follow a relative link
- [ ] look at [the source of this page](README.md?raw)
