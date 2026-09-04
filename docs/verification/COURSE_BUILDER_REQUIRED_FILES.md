# Course Builder required integration files

The final pull request gate verifies that the branch contains:

- `packages/course-builder-host/src/index.ts`
- `packages/course-builder-host/src/host.ts`
- `packages/course-builder-host/src/types.ts`
- `packages/course-builder-host/src/beamer.ts`
- `apps/pi-web/app/course-builder/page.tsx`
- Course Builder API routes and Pi Web runtime/tool wiring
- `docs/COURSE_BUILDER.md`
- `docs/HARNESS_ACCEPTANCE_CHECKLIST.zh-CN.md`
- `third_party/noi1r-beamer-skill/LICENSE`
- `.github/workflows/course-builder.yml`

Recovery-only `chatgpt-course-builder-*` workflows are forbidden from the final reviewed tree.
