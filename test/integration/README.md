# Markdown comparison regression tests

Run `npm run test:markdown` for the isolated unit suite (Node 20+). It compiles
the TypeScript tests with the existing esbuild dependency into a temporary
directory, runs Node's test runner, then removes the generated files.

For a real extension-host test, build the extension with `npm run build` and
ensure `resource/markdown/dist` is available. Launch an isolated VS Code host:

```sh
code --new-window --user-data-dir /tmp/office-test-profile \
  --extensions-dir /tmp/office-test-extensions \
  --extensionDevelopmentPath=/absolute/path/to/vscode-office \
  --extensionTestsPath=/absolute/path/to/vscode-office/test/integration/markdownSwitch.cjs \
  --disable-extensions --disable-workspace-trust --skip-welcome \
  /absolute/path/to/empty-test-workspace
```

Use the actual executable for each target version; portable installations also
need an isolated `VSCODE_PORTABLE` directory. Set `OFFICE_SWITCH_TEST_RESULT` to
an output JSON path (default: `office-switch-test-result.json` in the OS temp
directory). The harness creates its own files and closes its editors, so do
not run it in a personal VS Code session.

The host test checks direct first-open text comparison, both focus sides,
closed standalone tabs, a missing title URI, repeated switches, unsaved
buffers, saving to the modified file only, single-file switching, and concurrent
switching in a second editor group.
It invokes the Explorer command with the arguments supplied by VS Code;
the visual context menu should also be checked manually with two selected files.

The compatibility seam is the boolean `override: true` option accepted by
VS Code's `vscode.diff` converter. It is not a public typed option. Keep host
coverage on VS Code 1.86.2 and a current version when changing it. On versions
without custom editor comparisons, switching back follows the platform's text
fallback. Versions predating the Tab API retain single-file switching; the
unit suite checks that fallback but does not simulate an entire old workbench.
