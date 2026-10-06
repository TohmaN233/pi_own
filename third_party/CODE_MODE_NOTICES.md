# Code Mode upstream resources

The selected Skill files and their supporting references are copied byte for byte. Only these selected sources are distributed; runner-up methodologies are not installed.

| Directory | Upstream | Pinned commit | License |
| --- | --- | --- | --- |
| `max4c-skills` | https://github.com/max4c/skills | `0e5a4869cfb9a7c1d5b97bf0e3da543fdd37be71` | MIT, see `max4c-skills/LICENSE` |
| `max4c-grill-with-docs` | https://github.com/max4c/skills | `825b94d5c28b81d5cf1c66ce2f474dc2d3c87048` | MIT, see `max4c-grill-with-docs/LICENSE` |
| `agent-skills` | https://github.com/addyosmani/agent-skills | `dc27a9c2e13721158157632de61b4106c6c2a2a1` | MIT, see `agent-skills/LICENSE` |
| `playwright-cli` | https://github.com/microsoft/playwright-cli | `74354ecc7a43da16d91a9bc54fa8db8283a3fcf5` | Apache-2.0, see `playwright-cli/LICENSE` |

`code-mode-sources.json` records the source archive SHA-256 and each distributed file's SHA-256 and byte length. Upstream relative directories and shared `references/` are retained. README files describe upstream projects and may mention resources outside the selected set; they do not enable those resources in Code Mode.

`code-mode-packages.json` records exact published npm versions, repositories, licenses, tarball integrity, extension entrypoints, and CLI entrypoints for mode-private installation. npm source code is installed from these upstream packages and is not vendored here. The host pins the compatible `vscode-languageserver-protocol` 3.17.5 dependency because 3.18.3 no longer exports the `node.js` subpath used by `pi-lsp-extension` 1.3.0.

GitHub Spec Kit is installed from the official `specify-cli==1.0.5` distribution (MIT). Its wheel SHA-256 is `1107f5ad8ccc0acb743f4ea7ab02cfadc61f948e64daec87ccb0a2d45b9761f9`. The official CLI creates project prompts; the host does not rewrite them. Pi's system prompt remains the existing pinned upstream SDK prompt.
