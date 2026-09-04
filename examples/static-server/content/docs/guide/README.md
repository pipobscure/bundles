# The guide

This file is `guide/README.md`, and the request that found it was for `/guide/`
— the same rule `index.html` gets.

## Nesting

1. Ordered lists work
2. So do nested ones:
   - like this
   - and this
3. And code inside them:

   ```js
   import { render } from './markdown.ts';
   ```

## Links between documents

A link to [caching.md](caching.md) resolves the way it does on disk, because the
server renders `.md` in place rather than moving it somewhere else.

[Back to the top](/)
