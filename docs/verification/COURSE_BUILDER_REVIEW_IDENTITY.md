# Course Builder review identity

- Base branch: `main`
- Head branch: `feat/course-builder-beamer`
- Feature identity is the final branch head reported by the pull request and its successful Course Builder / repository CI runs.
- Merge must use GitHub's expected-head-SHA guard.
- The final merge report must record the exact reviewed head, check runs, and merge commit.

This file intentionally does not hard-code a SHA before the final cleanup commit and CI complete. The immutable SHA is recorded in the merge commit message and the final main-branch verification document.
