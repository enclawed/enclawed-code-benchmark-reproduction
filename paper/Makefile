# Build the codenclawed paper.
#   make          regenerate the benchmark tables from the live result files, then build paper.pdf
#   make tables   only regenerate generated/*.tex and abstract-arxiv.txt
#   make refresh  the same as make: regenerate every table and number from the live
#                 results, then rebuild the PDF; safe to run whenever results land
#                 (the generator is deterministic, so unchanged results change nothing)
#   make clean    remove LaTeX intermediates
#   make tables CZ_EXPORT_DIR=<dir>  also export the long tables (Markdown + CSV) to <dir>
# The codenclawed arms print "pending (final build)" until CZ_FINAL_BUILD names the
# final build, e.g. make refresh CZ_FINAL_BUILD=<sha>.
# The codenclawed rows of the confusion table are the live calls decided by the current release:
# data/replay-<kit>.json, written by scripts/replay-summary.mjs from one run of Enclawed's
# ground-truth replay (enclawed-oss `pnpm bench:replay --native --json ...`); the build stops when
# that file names other builds or another codenclawed-main.jsonl than the live one.
# Uses latexmk when it is installed, else a pdflatex/bibtex loop.

PAPER  := paper
# The harness (catalog, run.mjs, README, hostc/) and the result files, beside this directory in
# the reproduction repository; both paths are configurable.
BENCH   ?= ../harness
RESULTS ?= ../results
MODELS  ?= claude-haiku-4-5,claude-fable-5-1,claude-opus-5-5
LATEXMK := $(shell command -v latexmk 2>/dev/null)

.PHONY: all refresh tables pdf clean
CZ_FINAL_BUILD ?=
export CZ_FINAL_BUILD
CZ_ARM_BUILDS ?=
export CZ_ARM_BUILDS
# CZ_EXPORT_DIR=<dir>: also write the long tables as Markdown + CSV into <dir> (the codenclawed
# repository's docs/benchmark); unset, nothing is exported.
CZ_EXPORT_DIR ?=
export CZ_EXPORT_DIR

all: tables pdf

refresh:
	$(MAKE) tables
	$(MAKE) pdf

tables:
	node scripts/make-tables.mjs --bench $(BENCH) --results $(RESULTS) --models $(MODELS)
	node scripts/make-refinement.mjs
	node scripts/make-abstract.mjs

pdf:
ifneq ($(LATEXMK),)
	latexmk -pdf -interaction=nonstopmode -halt-on-error $(PAPER).tex
else
	pdflatex -interaction=nonstopmode -halt-on-error $(PAPER).tex
	bibtex $(PAPER)
	pdflatex -interaction=nonstopmode -halt-on-error $(PAPER).tex
	pdflatex -interaction=nonstopmode -halt-on-error $(PAPER).tex
endif
	@echo "boxes: $$(grep -cE 'Overfull|Underfull' $(PAPER).log); undefined: $$(grep -cE 'undefined' $(PAPER).log)"

clean:
	rm -f $(PAPER).aux $(PAPER).bbl $(PAPER).blg $(PAPER).log $(PAPER).out \
	      $(PAPER).fls $(PAPER).fdb_latexmk $(PAPER).toc
