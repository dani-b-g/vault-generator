# Examples and demo applications

## Engine behaviour

`VG --mode examples --project <id> --goal "<what to show>" --kind snippet|app`

1. Reads the project's documented public symbols from the vault (names, signatures, source locations).
2. Selects the symbols that match the goal (falls back to the first documented ones and says so).
3. Writes the example **outside the vault** (default `examples/<project>-<goal>`), with:
   - a header listing every API used and where it is documented;
   - for `app`: `package.json` (Node.js, dependency on the local project via `file:`) or `requirements.txt` (Python, `-e <path>`), `README.md` with run instructions;
   - `vg-example.json` with goal, project version, symbols used, validation results.
4. Runs syntax checks (`node --check`, `python -m py_compile`). With `--validate` (Node.js apps) it also runs `npm install` and `npm start`.
5. Records the example in `.vault-generator/examples.json` (reference only; the vault never stores the project).

Supported ecosystems for scaffolding: Node.js (JS/TS) and Python. Other ecosystems return `E_UNSUPPORTED` with
the vault note to use.

## Agent rules

- Ask for project, goal and kind when missing (the engine returns `example-*` questions), plus any essential
  requirement the engine cannot know (runtime constraints, target framework, data to use).
- Use `VG --mode context "<goal>" --project <id>` to gather the documented APIs before extending the scaffold.
- Only call APIs that appear in the vault or in the project's source code. If something needed is not
  documented, say so instead of inventing it.
- Replace `TODO` placeholder arguments with values justified by the documentation.
- After editing, re-run the checks (`node --check`, the project's build/test) and update `vg-example.json`.
- Never describe an example as validated unless the checks actually ran and passed; report failures verbatim.
