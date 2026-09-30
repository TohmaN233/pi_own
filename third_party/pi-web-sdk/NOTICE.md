# Pi Web SDK security package

Source: `@earendil-works/pi-coding-agent@0.85.1`, from the registry archive and
SHA-512 integrity recorded in `source.json`. Upstream:
https://github.com/earendil-works/pi/tree/v0.85.1/packages/coding-agent.

Rebuild with `python scripts/vendor-pi-web-sdk.py`, update its lock with
`--refresh-lock`, then run `npm install --prefix apps/pi-web --package-lock-only
--ignore-scripts`. Verify offline with `--check`. A direct `npm install <tgz>`
can discard the shrinkwrap flag; use the checked generator for archive updates.
`manifest.json` records the resulting archive integrity, every retained file's
original and patched SHA-256/mode, and the exact removed bundle list. Only
`package.json` and `npm-shrinkwrap.json` are modified. They update undici and
brace-expansion and select upstream's existing unbundled CLI/RPC entrypoints.
The old bundles are removed because they embed vulnerable dependency code.
All other retained runtime files, types and assets match upstream byte-for-byte.
The upstream MIT copyright/license notice is added as `LICENSE` inside the
archive because the original npm archive omitted that file.

The repackaged archive is a local artifact and has no npm registry signature.
The original archive's integrity authenticates the input. Registry signature
verification continues to cover the separately installed registry dependencies.
Pi Web's lock retains `hasShrinkwrap` and its original SDK dependency graph,
apart from the declared two dependency updates. The offline verifier checks
those resolutions as well as the archive. A new upstream SDK version needs a
new reviewed source identity, patch and runtime validation.

Upstream license, from https://github.com/earendil-works/pi/blob/v0.85.1/LICENSE:

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
