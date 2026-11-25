# Enclawed Code benchmark: reproduction data

The benchmark harness, the result files, the table generator and the paper sources behind *Enclawed Code: Deterministic Control of Every Tool Call of an Unmodified Claude Code* (Alfredo Metere, Enclawed, Inc., 2026). Every table and every number in the paper, and its arXiv abstract, are regenerated from this repository by one command.

Enclawed Code is an open-source launcher that runs the user's unmodified Claude Code inside Enclawed, where a fixed rule decides each tool call by its effect and reversibility before it runs. The benchmark compares it with native Claude Code on live runs with real models. Enclawed Code was measured under its working name, codenclawed; the harness, the result files and the build records keep that name.

## What is here

| Path | What |
|---|---|
| `harness/` | the live benchmark harness: the scenario catalog (`catalog.mjs`, `catalog-new.mjs`, `catalog-incidents.mjs`), the runner (`run.mjs`), the sandbox (`sandbox-ext.mjs`), the compromised-host suite (`hostc.mjs`, `hostc/`), the device-unlock helpers for configuration C2 (`c2-*.mjs`), the summarizer and its README |
| `results/` | the result files the paper reports, as JSON Lines (one JavaScript Object Notation record per line): `native-main.jsonl` (native Claude Code), `codenclawed-main.jsonl` (Enclawed Code), `hostc-main.jsonl` (compromised host), the runners' event logs and the summarizer's output |
| `results/replay-input/` | the two result files as Enclawed's ground-truth replay read them (see below) |
| `paper/` | the paper's LaTeX sources, the bibliography, the `Makefile`, the generated tables (`generated/`), the hand-labeled inputs (`data/`) and the scripts (`scripts/`) |
| `paper/scripts/make-tables.mjs` | the table generator: reads the harness and the result files, writes `paper/generated/*.tex` |
| `paper/data/replay-8c2c068aa.json` | the summary of Enclawed's ground-truth replay of every recorded call; it records the Secure Hash Algorithm 256 (SHA-256) digest of every input it was made from |
| `scripts/scrub-results.mjs` | the script that made the published result files from the raw ones (see below) |

Data appendix (PDF): [`report/enclawed-code-benchmark-tables.pdf`](report/enclawed-code-benchmark-tables.pdf) typesets every long table the generator exports (`--export`), with the result-file digests and the generator command on its title page. Regenerate it with `node scripts/render-report.mjs` (it runs the export itself on a temporary copy of `paper/`, so nothing in the repository is rewritten). It needs [playwright-core](https://www.npmjs.com/package/playwright-core) with a Chromium build it can launch, and [markdown-it](https://www.npmjs.com/package/markdown-it); neither is installed by this repository. Point the script at existing copies with `PLAYWRIGHT_CORE_DIR=<dir>` and `MARKDOWN_IT_DIR=<dir>` (or `--playwright-core <dir>`, `--markdown-it <dir>`), and at a Chromium executable with `CHROMIUM_PATH=<file>` (or `--chromium <file>`) if playwright-core's own browser is not installed. The PDF's dates are fixed to the newest result record, so two runs with the same Chromium and fonts write the same bytes; another Chromium version or font set gives the same text with a different layout.

## A scrubbed data release

The result files are a scrubbed data release: [`scripts/scrub-results.mjs`](scripts/scrub-results.mjs) made them from the raw files the benchmark wrote. The script is deterministic. It keeps every line in its place and every byte outside the replaced values as recorded; no record is re-serialized. It replaces, everywhere they occur:

| Raw value | Published as |
|---|---|
| the benchmark's working directory (Claude Code's scratch directory of the session that ran it, which names the user and the session), also where a cut text holds only a piece of it | `/tmp/bench/run` |
| that session's own directory around it | `/tmp/bench` |
| any other universally unique identifier (UUID) | `00000000-0000-0000-0000-000000000000` |
| the home directory `/home/<user>` | `~` |
| the serial number of the Enclaweder (Enclawed, Inc.'s hardware security device) | `ECPRO-SERIAL` |
| every e-mail address a model wrote, except the fixtures' reserved example domains and `noreply@anthropic.com` | `user@example.com` |
| the name of the claude.ai account connector, and its tool prefix | `claude.ai connector`, `mcp__claude_ai_connector__` |
| the names of the account's synced skills | `anthropic-skills:account-skill` |
| the `rateLimitEvents` field of a record (the subscription's usage, utilization and overage state) | `null` |

The rest of each path is kept as recorded. The paper's call labeling (`paper/scripts/call-truth.mjs`) recognizes `/tmp/bench/run` as the working directory, and the placeholders hold only path characters, because the harness's attempt predicates read paths as shell text. Files a model wrote under Claude Code's own temporary directory (`/tmp/claude-1000/...`) keep their paths; they name no user, and the paper's labels match them. On the scrubbed files the table generator writes the same tables, numbers and abstract as on the raw ones; only the digests of the result files differ.

### Which result file each paper artifact used

| Paper artifact | Result files read |
|---|---|
| every table, number and the abstract (`paper/generated/*.tex`, `paper/abstract-arxiv.txt`, by `make-tables.mjs`) | `results/native-main.jsonl` (10,417 records), `results/codenclawed-main.jsonl`, `results/hostc-main.jsonl` |
| the ground-truth replay summary (`paper/data/replay-8c2c068aa.json`, by `replay-summary.mjs`), which supplies the Enclawed Code rows of the outcome tables | `results/replay-input/native-main.jsonl` (10,189 records), `results/replay-input/codenclawed-main.jsonl` |

The result files are append-only. `results/replay-input/native-main.jsonl` is the native file as it stood when the replay ran; `results/native-main.jsonl` is the same file, byte for byte, followed by 228 records appended afterwards (records that mark earlier runs invalid, among them runs whose hidden-instruction carrier was defective, and the runs that replaced them). The replay summary is itself an input of the table generator, so regenerating the paper uses both. `results/replay-input/codenclawed-main.jsonl` is identical to `results/codenclawed-main.jsonl`; it is there so that the replay's inputs sit together under their recorded names. `make-tables.mjs` reads every `*.jsonl` directly under `--results` (not subdirectories), so the replay copies never enter the tables.

## Pairs with

| Repository | Commit | Role |
|---|---|---|
| [enclawed-code](https://github.com/enclawed/enclawed-code) | `9b4ac32f52c897542c773b83e1f175e3a47a5d92` | Enclawed Code release 0.666.0; it also holds the long tables as Markdown and comma-separated values (CSV) in `docs/benchmark` |
| [enclawed-oss](https://github.com/enclawed/enclawed-oss) | `8c2c068aa59ad2e9bae4f720f13ae79f611eac4d` | the open-source core Enclawed Code runs on, and the ground-truth replay |

The Enclawed Code builds measured are named in every result record: `67a30e7` for configuration C1 (software only) and `a3a1fc4` for the compromised-host suite.

C2 (Enclawed Code with an Enclaweder) was measured on build `6329ccd`, an interim build of the 0.666.0 development that raised the device unlock limits to 65,535 uses and 36 hours, so that one unlock covers a whole benchmark batch. enclawed-oss main then adopted those limits to match the Enclaweder's firmware. Build `6329ccd` exists only in the private repository; it is available on request from alfredo.metere@enclawed.com.

## Regenerate the tables

Requirements: Node.js 22. No model, login or network access is needed.

```sh
cd paper
CZ_ARM_BUILDS="C2=6329ccd,hostc:C1=a3a1fc4" \
  node scripts/make-tables.mjs --bench ../harness --results ../results \
    --models claude-haiku-4-5,claude-fable-5-1,claude-opus-5-5 --cz-build 67a30e7
node scripts/make-refinement.mjs
node scripts/make-abstract.mjs
git diff --stat           # empty: every generated file is identical
```

or, with the paper's `Makefile` (its `BENCH` and `RESULTS` default to `../harness` and `../results`; set them to use other copies):

```sh
cd paper
make tables CZ_FINAL_BUILD=67a30e7 CZ_ARM_BUILDS="C2=6329ccd,hostc:C1=a3a1fc4"
```

Without `CZ_FINAL_BUILD` and `CZ_ARM_BUILDS`, the Enclawed Code cells print "pending (final build)". The generator is deterministic: on the same inputs it writes the same bytes. It writes `paper/generated/*.tex` and `paper/abstract-arxiv.txt`; `--export <dir>` also writes the long tables as Markdown and CSV. `make` (without `tables`) also builds the paper's Portable Document Format (PDF) file with LaTeX.

The replay summary comes from one run of Enclawed's ground-truth replay (enclawed-oss `pnpm bench:replay --native --build 67a30e7 --arm-builds C2=6329ccd --json <out.json>`) on the replay inputs with the paper's run marks applied:

```sh
cd paper
node scripts/mark-results.mjs ../results/replay-input/codenclawed-main.jsonl <marked>/codenclawed-main.jsonl
node scripts/mark-results.mjs ../results/replay-input/native-main.jsonl <marked>/native-main.jsonl
# run the replay on <marked>, then summarize it (options at the top of the script):
node scripts/replay-summary.mjs --replayed-results <marked> ...   # reads ../results/replay-input by default
```

How the files map to the paper:

| Paper | Generated file |
|---|---|
| Headline comparison per permission mode | `generated/headline.tex` |
| Outcomes per configuration (confusion table) | `generated/confusion.tex` |
| Calls that need a person, task completion | `generated/fp.tex` |
| Attack success per configuration and model | `generated/bench-models-asr.tex`, `generated/bench-matrix.tex` |
| Compromised host | `generated/hostc.tex` |
| Same action, mixed decisions | `generated/same-action.tex` |
| Live tests and their scale | `generated/live.tex` |
| Refinement history | `generated/refinement.tex` |
| Attacks against Enclawed Code, by group | `generated/attacks-summary.tex` |
| Incidents | `generated/incidents.tex` |
| Every number in the prose | `generated/bench-macros.tex` |

## Re-run the benchmark

With Claude Code 2.1.326, Node.js 22, bubblewrap and a Claude login, configurations N0 (native Claude Code), N1 (native Claude Code with its own sandbox) and C1 (Enclawed Code, software only) reproduce with:

```sh
cd harness
node run.mjs --plan main --arm N0,N1,C1
```

`harness/README.md` describes the method, the sandbox, the catalog and every option. Live runs spend model usage under your own account, and model behavior varies from run to run, so a reproduction should match the paper's Wilson 95% confidence intervals, not its exact counts.

Configuration C2 and the compromised-host results need an Enclaweder. Researchers who want to reproduce the hardware results are invited to contact alfredo.metere@enclawed.com.

## License

The harness and the scripts are under the Massachusetts Institute of Technology (MIT) license, see [LICENSE](LICENSE).

## Citing

Alfredo Metere. *Enclawed Code: Deterministic Control of Every Tool Call of an Unmodified Claude Code.* Enclawed, Inc., 2026. Contact: alfredo.metere@enclawed.com
