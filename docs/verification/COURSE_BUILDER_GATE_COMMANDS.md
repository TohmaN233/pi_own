# Course Builder gate commands

```bash
npm ci --ignore-scripts
npm run check
node --experimental-strip-types --test scripts/course-builder*.test.mjs
node --experimental-strip-types --test scripts/mode-pack*.test.mjs
npm test
npm run build

npm ci --prefix apps/pi-web --ignore-scripts
apps/pi-web/node_modules/.bin/tsc --noEmit -p apps/pi-web/tsconfig.json
npm run lint --prefix apps/pi-web
npm test --prefix apps/pi-web
npm run build --prefix apps/pi-web

git diff --check
```

The merge decision uses the pull request's final head SHA and completed GitHub Actions results, not this command list by itself.
