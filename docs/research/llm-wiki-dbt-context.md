# Compiled context for the dbt estate: research and production design

**Status:** research report (2026-07). Sources: Karpathy's LLM-wiki gist (primary), the
[awesome-llm-wiki](https://github.com/gavischneider/awesome-llm-wiki) corpus (every
substantive link reviewed; marketing filtered out and flagged), the arXiv/production
literature it cites, and dbt's own artifact/tooling documentation. Grounded throughout in
the `credible-bi-airflow-triage` runtime this console fronts.

---

## 0. TL;DR

- **The wiki is the right abstraction for exactly one layer — semantics — and the wrong
  abstraction for structure.** Your instinct is correct: `manifest.json` is already a
  *compiled, deterministic knowledge base* of the project's structure and lineage. Nothing
  an LLM writes should ever restate what the manifest knows (parents, children, columns,
  tests, materializations): restated structure is stale the next `dbt compile` and is the
  single most common failure mode reported across the ecosystem ("docs drift").
- **Build three layers, not one wiki:**
  **L0 — deterministic projection** of `manifest.json` (+ `catalog.json`, `run_results.json`,
  exposures) into agent-readable per-node cards and lineage answers, regenerated on every
  merge, zero LLM involvement.
  **L1 — the semantic wiki**: LLM-compiled markdown that holds only what the manifest
  *cannot* know — business meaning, domain concepts, criticality rationale, incident
  history, cross-model narratives. Every page pinned to manifest `unique_id`s, provenance
  required, humans review via PR.
  **L2 — navigation/runtime**: a small deterministic index + CLI the triage agents call at
  run time (`context <node> --radius`, blast-radius queries, page lookup), because runs
  clone the repo, the session envelope is capped at 60 kB, and the runtime has no vector
  infrastructure — and none is needed at this scale.
- **The evidence supports compilation over query-time RAG for this workload**: agents doing
  incident triage under time pressure need cross-entity synthesis with citations, which is
  precisely where compiled wikis beat vector RAG in every benchmark reviewed — at the cost
  of compile-time tokens, which for us are amortized and mostly avoided because L0 is free
  (deterministic) and L1 only compiles *semantic deltas*.
- **Maintenance is the whole game.** Every production system that survived contact with
  scale converged on the same machinery: generated-vs-authored ownership boundaries,
  deterministic linting in CI, drift detection against the source of truth, provenance on
  every claim, and human-gated merges for semantic content. The design below specifies all
  five for the dbt case.

---

## 1. The problem, grounded in this repo

The backend this console fronts runs LLM agents as Airflow DAG runs
(`ai-agent-runner`). Two shipped agents define the context requirement:

- **`airflow-failure-triage`** must "classify severity by business impact: high means core
  marts or customer-facing data are stale or wrong", separate root cause from downstream
  symptoms, and report *blast radius* and the smallest safe fix.
- **`anomaly-detector`** must decide whether an anomalous metric matters — which is a
  question about what the table *means* and who consumes it, not about SQL.

Today the only dbt context either agent has is the generic `skills/dbt.md` (how to read
`run_results.json`, common failure taxonomy). For a project with thousands of models, the
gap between what the prompt demands and what the agent can know is exactly two kinds of
knowledge:

1. **Lineage** — what is upstream/downstream of the failed node (blast radius). This is
   *fully deterministic* and already encoded in `manifest.json` (`parent_map`,
   `child_map`, `depends_on`, exposures).
2. **Business semantics** — which marts are customer-facing, what `fct_orders` means to
   finance, which dashboards break, what happened the last three times this model failed.
   This is *not* in the manifest (or is only sparsely encoded in `description`/`meta`),
   and it is what a wiki layer is for.

Runtime constraints that shape everything below:

- Runs execute **in-VPC on Kubernetes**; the agent gets a **repo checkout** and file
  tools (`file_read`, `file_list`, bounded `dbt_show_query`). Context must be *pullable
  from files in the repo*, not pushed from a service.
- The session envelope is **capped at 60 kB** (it travels to the pod as an env var), so
  per-run context injection is bounded; the agent must *navigate* to context, cheaply.
- There is **no vector database** in the runtime, and (see §5) none of the systems
  reviewed needed one below ~10k pages when a good index + grep/FTS exists.
- Skills are flat `.md` files in the backend catalogs; adding CLI tools means adding a
  `tools/*.yaml` entry. Both are cheap. Wiki maintenance can itself run as a scheduled
  agent (`agent_triggers/*.yaml`), which the trigger schema already supports
  (`dag_complete` with `only_if: dbt_failed_nodes`, `schedule`).

## 2. Karpathy's core idea, from the primary source

The gist (read in full) is deliberately abstract; its load-bearing claims:

- **Compile once, keep current.** RAG "rediscovers knowledge from scratch on every
  question... nothing is built up." Instead the LLM "incrementally builds and maintains a
  persistent wiki — a structured, interlinked collection of markdown files that sits
  between you and the raw sources." The wiki is a *compounding artifact*: cross-references
  already exist, contradictions are already flagged, synthesis already reflects everything
  read.
- **Three layers.** Raw sources (immutable, LLM never modifies), the wiki (LLM-owned
  markdown), and **the schema** — a CLAUDE.md/AGENTS.md operating manual that "makes the
  LLM a disciplined wiki maintainer rather than a generic chatbot", co-evolved over time.
- **Three operations.** *Ingest* (one source touches 10–15 pages), *query* (answers with
  citations, and — the insight most implementations underuse — **good answers are filed
  back into the wiki**, so explorations compound), and *lint* (contradictions, stale
  claims, orphans, missing pages, missing cross-refs, data gaps).
- **Navigation without infrastructure.** `index.md` (content catalog, read first at query
  time) "works surprisingly well at moderate scale (~100 sources, hundreds of pages) and
  avoids the need for embedding-based RAG infrastructure"; `log.md` is an append-only,
  grep-parseable chronology. Beyond that scale, bolt on a search CLI (he points at `qmd`:
  BM25 + vector + rerank, CLI + MCP).
- **Why it works.** "The tedious part of maintaining a knowledge base is not the reading
  or the thinking — it's the bookkeeping... Humans abandon wikis because the maintenance
  burden grows faster than the value." The LLM makes maintenance ~free; the human curates
  sources and asks questions. (His lineage: Bush's Memex — "the part he couldn't solve
  was who does the maintenance.")
- The metaphor that matters for us: **"Obsidian is the IDE; the LLM is the programmer;
  the wiki is the codebase."** For a dbt estate, read it in reverse: the codebase already
  ships a compiler (`dbt compile` → `manifest.json`). The wiki pattern applies to the
  part of the knowledge that has no compiler.

## 3. What the ecosystem converged on (survey of every substantive implementation)

Across ~40 substantive implementations, skills, and case studies (full dispositions in
Appendix A), the same operational patterns were independently rediscovered again and
again. Where numbers exist, they are given.

### 3.1 The universal skeleton

Every surviving system has Karpathy's three layers plus two additions:

1. `raw/` immutable sources → 2. `wiki/` compiled markdown → 3. schema/constitution file
(CLAUDE.md/AGENTS.md) → **4. generated metadata** (indexes, backlink maps, search
registries — always machine-built, never hand-edited; pi-llm-wiki's `meta/registry.json`
+ `backlinks.json`, engram's `.engram/cache`, owledge's "Markdown is the source of truth;
indexes, reports, graphs are generated or optional views") → **5. an ownership boundary
enforced by tooling**, not convention (pi-llm-wiki blocks edits to `raw/**` and `meta/**`;
the "Foundry" agent-only vault marks the human corpus read-only in CLAUDE.md after
suffering "attribution confusion"; Synto-style mutation defense protects human edits).

The comparative review that tested five implementations head-to-head concluded:
**"the schema file is 80% of the product"** — disciplined schemas (engram, pm-llm-wiki)
produced trustworthy wikis; permissive automation produced "confident chaos" that the
author deleted within five days.

A useful mental model for the layers (AAIF's memory mapping): the schema file is
*procedural* memory, `log.md` and dated entries are *episodic*, entity/concept pages are
*semantic*, and source digests are *summary* memory — a reminder that these files serve
different retention and update rules, which is why one global staleness policy fails
(§5.3).

### 3.2 Hot/cold context split, and the routing layer

The most transplantable production design reviewed is MehmetGoekce's L1/L2 cache
(126-star skill, mechanisms specified to line format, ~100 sessions measured):

- **L1** = always-loaded memory (CLAUDE.md + memory dir, ~10-20 files): rules whose
  violation would be "dangerous or embarrassing" — invariants, severity rules,
  credentials (git-excluded). **L2** = the wiki, loaded on demand. **L3** = grep over
  everything, "the exception, not the default."
- **Hub routing lines** — each namespace hub carries an `### Index` of
  `[[page]] -- description #tags` lines (≤120 chars) that act as "the wiki's page
  table/TLB": queries read only hub index blocks, pick ≤3-5 pages, read max 3
  simultaneously.
- **Access logging + LRU demotion**: every full-page read appends
  `date -- [[page]] -- query -- matched: "reason"` to an access log; a prune command
  demotes pages unaccessed for 6 months out of the live index (file never moves —
  "a move = broken-ref storm"; demotion ≠ deletion; auto re-promoted if queried).
- Measured economics: query 5-10k tokens, ingest 5-12k, ~$0.10/session; his L1 drifted
  from 5.6 KB to ~35 KB ("a CPU evicts its L1 without being asked; mine only shrinks
  when I make it" — hot-layer eviction is unsolved everywhere).

The same split appears as `hot.md` (≤500 words, hook-injected at session start) in
hippocampus, L0→L3 progressive loading (~200 tokens → 1-2k → 2-5k → 5-20k, "do NOT load
L3 unless needed") in obsidian-second-brain, and the `CRITICAL_FACTS.md` hard cap of
150 tokens.

### 3.3 Observed scaling walls (the numbers that matter at our scale)

| Threshold | Observation |
| --- | --- |
| < 20 pages | schema/lint overhead not worth it |
| ~50 pages | structure starts paying for itself |
| 53 → 139 pages | grep-everything retrieval turns "noisy and imprecise" — forced two-stage hub routing + access-log eviction |
| ~100-200 pages | index.md stops working as primary search; "maintaining the wiki without automation is essentially impossible" past 200 |
| ~500 notes | flat-file index "is a flat file, not a query engine" (Penfield) |
| ~760 pages / 1 person / 1 month | maintenance time ≈ time saved; 43% of pages stuck in draft review backlog (R&D World 30-day field report) |
| 50-100k tokens total | the curated-wiki sweet spot where "grep plus read beats an embedding lookup" (theaioperator, after removing vector search from a production system) |
| "hundreds to low thousands of documents" | consensus wiki-superior zone; 50k files/millions of docs → database/RAG territory |

A dbt project with thousands of models **exceeds every demonstrated hand-grown-wiki
comfort zone** — which is precisely why the architecture in §7 makes the deterministic
manifest carry structure and confines the LLM wiki to a page population in the low
hundreds (domains, marts, failure modes, incidents), inside the demonstrated envelope.

### 3.4 Write discipline: what keeps compiled pages trustworthy

- **Page-worthiness gates** (Farza's skill, the most operationally precise source):
  don't create a page that can't sustain 3 meaningful sentences; the concrete-noun test
  ("X is a ___"); 2+ sources before a concept page (Foundry, Hermes, PieKBS — whose
  `_draft/` quarantine keeps under-sourced syntheses out of the search index entirely).
  Anti-cramming (a third paragraph on a sub-topic → split it out) and anti-thinning
  (stubs that never enrich are equally a failure). Split pages >100-200 lines
  (Farza 150, Hermes 200, hippocampus 30-150).
- **Append vs synthesize**: re-read a page before every edit ("non-negotiable"),
  integrate — "never just append to the bottom"; but *operational fact streams* are the
  exception: the R&D World system lets the autonomous loop only **append dated, sourced
  facts to already-reviewed pages**, with structural changes human-gated.
- **Theme, not chronology** ("the Steve Jobs test"): an incident page organized by
  failure mode stays readable; organized by date it becomes an event log nobody reads.
- **Provenance on every claim** — the single most repeated rule, at increasing strictness:
  cite sources per page (everyone) → per paragraph (Hermes `^[raw/...]`) → per claim with
  file+line ranges validated by lint (llm-wiki-compiler) → "a claim without a source is a
  defect rather than a stylistic choice" enforced at a validation gate (R&D World) →
  "provenance-or-bust": claims without a literal source excerpt cannot become durable
  memory (knowledge-worker). The failure this prevents was observed in the wild: an
  agent "treating its own generated text as ground truth" — a speculative idea
  resurfacing later "as if it were implemented work" (nptacek). Triage hypotheses written
  back without `hypothesis` marking would poison the next incident.
- **Confidence and time on claims**: one-word confidence (`stated|high|low` — "the single
  highest-value v2 idea… a `stated` claim is treated as a quote, not a truth");
  `EXTRACTED | INFERRED | AMBIGUOUS` labels per edge (PENgram: "a graph where every edge
  claims equal confidence is lying to you"); bi-temporal `timeline:` entries
  `{fact, from, until, learned, source}` separating event time from learning time;
  `status: current|superseded|disputed` that **propagates into answers** ("X *[disputed —
  see claim-2]*", graphwiki) instead of being silently dropped.

### 3.5 Maintenance: lint, drift, contradiction, forgetting

- **Lint is scheduled, not on-request** ("the graph stays healthy in proportion to how
  automatic that check is"), with a deterministic/LLM split everywhere it works:
  scripts catch orphans, broken links, frontmatter gaps, index drift, size violations,
  credential leaks "for free, not by burning tokens" (hippocampus `vault_lint.py`,
  engram, commonplace-validate); the LLM handles only contradictions and semantic
  staleness. Union lint list across systems: orphans; broken/dangling links; missing
  required frontmatter; stale (90-day default); thin/empty pages; duplicates; index
  drift; uncited claims; hot/cold duplicates; credential patterns; contradiction flags.
- **Contradictions are surfaced, never auto-resolved** (Hermes protocol: note both
  positions with dates, mark frontmatter, flag for human review, "don't silently
  overwrite") — and §5's evidence shows why: measured LLM contradiction-detection
  precision is 0.20.
- **Drift detection**: Falconer frames enterprise drift as "a new PR contradicts the
  runbook" with owner-routed patch review; for dbt this becomes *deterministic* (diff
  wiki claims against manifest/catalog per merge). Their warning is the strongest
  argument for building the gate before the wiki: "a semantic search engine pointed at a
  stale knowledge base returns confidently-worded answers from documents that haven't
  been true since Q2."
- **Something must actually delete**: "the point of a forgetting curve is not the math.
  It is that something deletes" — realized as LRU demotion (Goekce), per-content-type
  staleness downgrades, and archive markers rather than file moves.
- **The false-absence guard** — the most triage-critical rule found anywhere: "the most
  common failure is not the AI making up a fact. It is the AI saying 'there is no note
  about that' when there is, because it answered from memory instead of actually
  searching." The model must verify presence AND absence by listing/grepping before
  asserting "no prior incidents for this model."

### 3.6 The compounding loop: queries and runs file back

- Query answers worth keeping become pages (`queries/`, `analyses/`, DAIR's `questions/`
  — "your explorations compound"; the four file-back criteria: connects 3+ notes,
  compares frameworks, captures a decision with reasoning, required real thought).
- **Crystallization / trajectory distillation** — the pattern that turns a triage agent
  into a compounding system: pi-llm-wiki captures the tool-call trajectory of a solved
  task, batch-distills trajectories into reusable `skill`/`case` pages, and answers
  "have I done this before?" at recall time; LLM Wiki v2 calls the same thing
  crystallizing "a debugging session" into a digest (question / findings / entities /
  lessons). OpenKB's Skill Factory goes one step further and compiles the wiki into
  redistributable agent skills — for Gantry, the mechanism by which the knowledge base
  feeds the `skills/` catalog.
- **Multi-agent writes are the unsolved problem** (no RBAC, no ACID, "50 agents writing
  simultaneously" has no demonstrated solution). The only working mitigations: a single
  writer (WikiKV's read-only online tier with one offline writer per subtree; the R&D
  World single-writer ledger loop), git serialization — branch → build (commit every
  20-50 pages) → deterministic verify report → merge, idempotent (Penfield) — and MCP
  write layers. Triage runs should therefore be **read-only** against the wiki, with
  writes funneled through one absorb pipeline.

### 3.7 Entity resolution — the one fuzzy problem left

graphwiki's measured result: pure embedding-threshold entity resolution tops out at
F1 0.667 (embeddings measure "same topic," not "same entity" — related pairs scored
*higher* cosine than true synonyms); a two-stage design (cheap vector filter ~0.55 →
one LLM judgment per surviving candidate) hit F1 1.000, replicated on invented domains.
For dbt, node identity is already deterministic (`unique_id`) — entity resolution is
only needed at the fuzzy boundary: mapping alert prose, Slack text, and dashboard names
onto model IDs and incident pages. Use the two-stage pattern there and nowhere else.

---

## 4. The structural contract: OKF, and what codebase-wiki compilers do

### 4.1 Open Knowledge Format v0.1 — adopt a subset

Google's OKF spec (June 2026; explicitly a formalization of Karpathy's gist, per its own
announcement) is ~450 lines of RFC-style contract, and its entire conformance surface is
three rules: every non-reserved `.md` has parseable YAML frontmatter; every frontmatter
has a non-empty `type`; reserved files (`index.md`, `log.md`) follow their format.
Everything else is recommendation: `title`, `description` (one sentence, feeds index
generators), `resource` (canonical URI of the underlying asset), `tags`, `timestamp`;
**concept ID = file path**; links are plain markdown, **untyped** ("the specific kind of
relationship… is conveyed by the surrounding prose"); **consumers MUST tolerate broken
links** ("a dangling link may simply represent not-yet-written knowledge"); unknown
frontmatter keys must be preserved. `okf_version: "0.1"` lives in root `index.md`
frontmatter (the only index allowed frontmatter).

Google's own reference producer is the exact shape of our problem: it walks **BigQuery
metadata** (a structured catalog) writing one OKF page per table, then runs a second LLM
pass that enriches pages with citations, schemas, and join paths, minting metric pages
under `references/`. Swap the BigQuery walk for a `manifest.json` walk and it is the dbt
producer. Ecosystem tooling exists today: engram (deterministic CLI: validate as gate,
lint as advice, `--json` everywhere, `superseded_by` instead of deletion, staleness as a
computable predicate `max(sources.timestamp) > page.updated`); okf-gem (CI exit codes,
post-edit curation hook, and the progressive-disclosure economics datapoint: a
400-concept bundle's full index is 313 KB but its depth-1 no-body skeleton is **2.8 KB**);
LangChain's OpenWiki emits OKF bundles.

What OKF is silent on — and where we extend via sanctioned extension keys:
generated-vs-curated marking, staleness (add `manifest_checksum` per page: stale ⇔
stored ≠ current), typed edges (lineage stays in the manifest; wiki links carry only
semantic relations), graph-scale navigation (shard indexes by domain; keep a JSON
sidecar catalog), and validation (no official validator exists; ours is ~150 lines:
3 conformance rules + manifest-aware checks — page-without-node, node-without-page
coverage, checksum staleness).

### 4.2 What production codebase→wiki compilers converge on

The five systems that compile *codebases* (the closest analog to a dbt project) agree on
far more than they differ:

- **Wiki lives in the repo** it documents: OpenWiki's `openwiki/` directory, Factory
  AutoWiki's `droid-wiki/` committed and versioned alongside code.
- **Freshness is CI, review is a PR**: OpenWiki ships GitHub Actions/GitLab CI workflows
  that run `openwiki code --update` on schedule and **open a PR with documentation
  updates**; AutoWiki installs workflows that refresh "on every push to the default
  branch"; vercel-labs/openwiki does daily scheduled refresh that regenerates **without
  replacing the last good wiki** (revisions kept).
- **Incremental, not whole-repo, regeneration**: AutoWiki "diffs against stored commit
  hashes and regenerates only affected pages"; Graphify's SHA256 cache means "re-runs
  only process changed files"; llm-wiki-compiler's `refresh --stale` "repairs changed
  knowledge without compiling unrelated new sources." (dbt gives us this diff for free:
  node `checksum` + `state:modified`.)
- **Source-grounded pages with citations**, page-level (vercel) to line-range-validated
  (llm-wiki-compiler's lint checks every citation).
- **Multi-agent pipelines scoped per facet**: AutoWiki's six phases (two-pass survey:
  structural scan of manifests/CI/entry points, then semantic scan; plan; generate in
  dependency order; capture; render; upload), "each scoped to one facet of the
  repository with just enough context to produce a good page."
- **Graph-first tools position against prose-first tools** in exactly our terms:
  GitNexus — "Like DeepWiki, but deeper… a knowledge graph tracks every relationship,
  not just descriptions" (tree-sitter → typed graph → MCP tools + generated AGENTS.md);
  Tesserae — a **typed knowledge graph as the source of truth** with the markdown wiki
  as an idempotent *projection*, serving "precisely the slice it needs — cited back to
  the file or the conversation it came from"; Understand Anything — deterministic
  tree-sitter structure + LLM semantics, with a separate "domain view" mapping code to
  business processes; codeglance — "map first, source last," deterministic artifacts +
  compact AI context briefs. For dbt, tree-sitter's role is played by `dbt compile`:
  the deterministic extractor already ran.

DeepWiki-Open, the most-starred codebase-wiki engine, has meanwhile pivoted its README
to a hosted product (grok-wiki.com) — snapshot-oriented generation with diagrams and Q&A
but no incremental story; useful as an onboarding artifact, not as a maintained context
layer.

---

## 5. The evidence: what benchmarks and production papers actually show

The papers cluster (all read in full via their HTML/abs versions) yields the sharpest
design constraints in this report.

### 5.1 Where compiled wikis win — and the one place they clearly lose

- **"Retrieval as Reasoning" (arXiv 2605.25480)** formalizes the pattern (Compilability,
  Composability, Evolvability) and shows tool-navigated wikis beating strong RAG
  baselines by +2.0 to +8.1 F1 on multi-hop QA — with the advantage **growing with
  fan-in**: +8.9 points on high multi-document questions, F1 0.983 at 4 hops (vs 0.90
  for graph-RAG). Latency is competitive (14.9-27.1 s/query ≈ dense RAG) because the
  agent reads 2.5-3.9 pages/query under a hard budget (Tmax=15 tool calls, patience 3).
  High fan-in cross-document synthesis is precisely the shape of "what upstream could
  corrupt this metric and which downstream consumers care."
- **The preregistered head-to-head (arXiv 2605.18490)** gives the two anchor numbers:
  the wiki's **claim-level citation precision doubles RAG's** (40.2% vs 18.9% of claims
  fully supported; 6.2% vs 34.1% unsupported) — for a triage report whose assertions
  must be trustworthy, this is the operationally valuable property — but an
  undisciplined 30-turn browsing agent without prompt caching paid a **21× query-token
  premium**. Decomposed RAG closed ~88% of the synthesis gap at 3.4× less cost yet
  stayed at 19.2% citation support: decomposition recovers synthesis, not attribution.
- **WiCER (arXiv 2605.07068)** is the sharpest warning: **blind LLM compilation is
  catastrophic by default** — compilers over-compress 2-3× past their target and drop
  query-critical facts at a 53-60% rate when the wiki is consumed as stuffed context.
  Its fix — one diagnostic probe per source, failed probes diagnosed to the specific
  dropped facts, re-injected as preservation constraints — cut catastrophic failures 55%
  (targeted diagnosis 5.9× better than generic preservation) at ~$1-2 and ~50 min per
  topic shard. Moral: **compile for traversal and attribution, never for compression**,
  and ship a probe suite (for us: mined from past incidents/postmortems).
- **DeepRefine (arXiv 2605.10488)** adds two things: long-lived agent-compiled KBs decay
  along three axes (incompleteness > incorrectness > redundancy/coreference, in both
  damage and fixability), best repaired by an **asynchronous, query-driven refinement
  stream** — failed interactions become the diagnosis signal, localized edits cost 2-3×
  less than recompilation, and the reward design penalizes breaking correct answers
  asymmetrically (−0.3 vs +1.0). And a caution: the one agentically-compiled "LLM-Wiki
  style" KB it tested was the *worst* constructor in the study — agent-written ≠ good.
- **memory-arena** (n=16, wide CIs) ranks the Karpathy wiki **worst per dollar for
  episodic conversational memory** (22.5% vs a 30-line vector store's 49.2%, at 14×
  cost) — the wrong task for the pattern. Wikis compile stable reference corpora; they
  are not a chat-session memory store. (LangChain's wiki-memory post scopes it the same
  way: "durable domain knowledge, not short-term conversation state… or high-frequency
  event logs" — run-by-run failure events belong in artifacts, not pages.)

### 5.2 WikiKV: the production blueprint (Tencent/WeChat, arXiv 2606.14275)

The one production-validated system ("millions of pages and tens of millions of KV
pairs" behind the WeChat Assistant) is effectively a specification for our L0/L2:

- **Path-as-key**: every node addressed by its normalized path, O(1) lookup, `Ls ≡ Get`
  in one round trip; navigation depth bounded by schema depth, not corpus size —
  latency rose only ~9-12% when the corpus doubled. dbt's `unique_id` and folder layout
  *are* path-as-key.
- **Read-only online tier; a single offline writer per subtree; parent-after-child
  writes with skip-on-miss reads; path-keyed cache invalidation** — i.e., exactly
  "wiki rebuilt in CI on merge, served immutably to agents, invalidated per changed
  manifest node."
- **Navigation is simultaneously the accuracy and the cost lever**: removing
  search-accelerated routing tripled pages read AND dropped answer correctness 25.4
  points. Production numbers: 2.2 tool calls/query; wiki tool contributes 0.432 s
  average (P99 < 1 s) of a 6.9 s LLM-dominated total — compatible with time-pressured
  triage.
- Schema evolution (split/merge with a cost model and reachability safety check) was
  worth +10.7 points over a frozen schema — but its hardest parts (cold-start schema
  induction, safety checks) are free for us: the manifest is the schema.

### 5.3 The failure-mode catalogue (Zenodo position paper + sub-studies)

Numbers to design against, from the richest failure catalogue reviewed:

- LLM **contradiction-detection precision 0.20** (80% false alarms — topical proximity
  mistaken for logical inconsistency) → surface contradictions, never auto-correct.
- **3.2% of page pairs per recompilation acquire silent semantic edits** (text similar,
  meaning changed — invisible to git diff) → semantic diffing in CI for compiled pages.
- At 84 pages, the best-structured wiki had the worst trustworthiness: only **23.5% of
  wiki sentences traceable to any source passage** (the compiler generated beyond its
  evidence) → enforce a traceability floor as a CI gate.
- **Hedge-stripping drift**: causal qualifiers drift 4.7× faster in humanities-style
  prose; "may contribute to" becomes "causes" over recompilations; numeric ranges get
  rounded → dbt caveats ("this model may double-count refunds when X") must live in
  near-verbatim structured fields, not summarized prose. The wastewater null result —
  three wiki iterations, zero wins on exception-laden operations manuals, because
  "the compiler consistently loses exception conditions and contraindication
  qualifiers" — is the same lesson: **exception-dense content resists compilation**.
- Staleness half-lives are per-content-type (6 vs 36 months measured) — one global
  90-day rule is wrong; encode per-type.
- Formal layers beat LLM reasoning where content is formalizable: ProbLog consistency
  checking hit F1 0.983 at 49× lower latency than LLM pairwise comparison; a Prolog
  prerequisite-closure query answers in milliseconds what multi-hop LLM reasoning does
  unreliably. **dbt already ships our formal layer** — the manifest DAG, tests,
  contracts; lineage and impact questions must be answered by deterministic graph
  queries, never LLM traversal.
- Operating regime, verbatim: **"human-assisted automation, not full autonomy."**

---

## 6. The dbt-native layer: what is already deterministic

Everything in this section the agent gets for free, with zero LLM involvement and zero
drift risk. The wiki must never restate any of it.

### 6.1 Artifacts

`manifest.json` (produced by nearly every dbt command; schema v12 for Core ≥1.7,
versioned at schemas.getdbt.com) carries: `nodes` (models/tests/seeds/snapshots/
analyses), `sources`, `exposures`, `metrics`, `groups`, `macros`, `docs`,
`parent_map` / `child_map` (first-order lineage, precomputed), `group_map`, `selectors`,
`disabled`. Every node: `unique_id` (`model.<package>.<name>`), `depends_on`, `refs`,
`config` (incl. materialization), `columns` (+descriptions), `description`, `meta`,
`tags`, `checksum` (the change-detection primitive), `access`, `group`, `patch_path`,
`path`. Companions: `catalog.json` (`dbt docs generate` — actual warehouse column
types/stats), `run_results.json` (per-node status/timing/failures — already the triage
trigger input), `sources.json` (freshness results).

**`exposures` are the business-impact encoding**: `type`
(dashboard/notebook/analysis/ml/application), `maturity` (high/medium/low), `owner`
(name/email), `url`, `depends_on` (refs/sources/metrics), `tags`, `meta` — and they are
selectable (`dbt ls -s +exposure:weekly_jaffle_metrics`). Blast radius that terminates
in a `maturity: high` dashboard exposure with an owner *is* the severity signal the
triage prompt demands. `groups` + `access` add ownership boundaries; `meta` is the
sanctioned place for `criticality`, `slack_channel`, `data_sla`, and similar keys.
Graph selectors (`+model+`, `@model`, `state:modified`) give exact impact sets and
exact change sets between two manifests — the drift-diff primitive.

### 6.2 The official agent surface: dbt-mcp

dbt Labs' MCP server ([dbt-labs/dbt-mcp](https://github.com/dbt-labs/dbt-mcp),
[docs](https://docs.getdbt.com/docs/dbt-ai/about-mcp)) is the strongest evidence for the
layered thesis: the vendor's own agent-context product is **deterministic tools over
artifacts and APIs, not a generated wiki**. Tool families:

- **Works against the local repo / dbt Core** (our runtime): `get_lineage_dev` (lineage
  from local manifest.json with type and depth filtering) and `get_node_details_dev`;
  dbt CLI tools (`list` with selector support, `compile`, `show`, `parse`, `docs`);
  Codegen (`generate_model_yaml` with upstream-description inheritance — the
  cold-start docs-coverage tool).
- **Requires dbt Platform**: Discovery API tools (`get_lineage`, `get_node_details`,
  `get_model_health` — run status + test results + upstream source freshness in one
  call, `get_mart_models`, `get_all_sources` with freshness, `get_model_performance`,
  `get_related_models` semantic search, alpha `search`), Semantic Layer tools, Admin
  API (job runs, artifacts), and Fusion column-level lineage
  (`fusion.get_column_lineage`; local variant via dbt-lsp).

The community fills the same shape from artifacts alone:
[`dbt-docs-mcp`](https://mcpservers.org/servers/mattijsdp/dbt-docs-mcp) (manifest +
catalog + sqlglot-derived column-level lineage), and the Rust
[`dbt-lineage`](https://crates.io/crates/dbt-lineage) crate whose 10 tools (`summary`,
`search_models`, `lineage`, `impact`, `column_upstream`, `column_downstream`,
`lineage_bundle`, `propose_test`, JSON error format) are explicitly agent/CI-oriented. Column-level lineage for dbt Core is available today via
sqlglot-based tooling; dbt-osmosis propagates column descriptions down the DAG; Recce
diffs environments.

### 6.3 The gaps that remain — the wiki's actual job

What no dbt artifact holds, observed both in the ecosystem and in this repo's own
agents: (1) **business meaning** beyond one-line descriptions (which are sparse in most
real projects — the reason `generate_model_yaml` and dbt-osmosis exist); (2) **why a
model matters** — criticality rationale, revenue paths, "which of the 40 dashboards
downstream anyone actually watches"; (3) **incident history and failure modes** —
"stg_payments flakes when the vendor file lands late (seen 12×)"; (4) **cross-model
narratives** — "revenue is computed in three places and they disagree on refunds";
(5) **playbooks/severity precedent** — what we did last time, what the smallest safe
fix was; (6) **tribal caveats** — the exception-dense content §5.3 says must be kept
near-verbatim. That list is exactly the wiki layer, and nothing else is.

---

## 7. The architecture: three layers over `manifest.json`

**Design stance (one sentence): treat `dbt compile` as the wiki's Pass 1.** Every
production system reviewed that works has a deterministic extractor feeding an LLM
semantic layer (tree-sitter for PENgram/GitNexus/Understand-Anything; the BigQuery
metadata walk for Google's OKF agent; the typed graph for Tesserae). dbt already ships
ours. The LLM never writes what the manifest knows; the manifest never pretends to know
what only humans and incidents can teach.

```
┌────────────────────────────────────────────────────────────────────────┐
│ L2 · NAVIGATION & RUNTIME (deterministic tools + read discipline)      │
│  wikictl: node <id> · lineage <id> --up/--down --depth · impact <id>   │
│  · search · page <path> · absent-check | routing indexes · hot context │
├────────────────────────────────────────────────────────────────────────┤
│ L1 · SEMANTIC WIKI (LLM-compiled, human-gated, OKF-subset markdown)    │
│  knowledge/wiki/{domains, models(earned), concepts, incidents,         │
│  playbooks, queries}/  — only what the manifest cannot know            │
├────────────────────────────────────────────────────────────────────────┤
│ L0 · DETERMINISTIC PROJECTION (generated on merge, zero LLM)           │
│  per-node cards + per-domain routing indexes + backlinks.json +        │
│  registry.json — pure functions of manifest/catalog/run_results       │
└────────────────────────────────────────────────────────────────────────┘
        ▲ manifest.json · catalog.json · run_results.json · exposures
```

### L0 — deterministic projection (generated, disposable, always fresh)

A pure-code generator (no LLM) runs on every merge to the dbt repo and materializes:

- **Per-node cards** — one small markdown/JSON card per model/source/exposure rendered
  from manifest+catalog: description, columns, tests, materialization, owner/group/meta,
  first-order parents/children, exposure trails (nearest downstream exposures with
  maturity/owner), freshness SLAs. OKF-conformant frontmatter with
  `resource: dbt://<project>/<unique_id>` and `manifest_checksum`. Cards are *generated
  views* (owledge's principle) — regenerated wholesale, never hand-edited, and excluded
  from the LLM-searchable layer (the 0% recall@10 lesson: raw dumps drown search).
- **Routing indexes** — per-domain `index.md` files of ≤120-char routing lines
  (Goekce's page-table pattern; okf-gem's 2.8 KB skeleton economics), plus JSON
  sidecars: `registry.json` (search), `backlinks.json` (model id → pages mentioning it —
  making per-failure page routing a dictionary lookup).
- **The drift diff** — on every merge: pages whose `manifest_checksum` no longer matches
  (stale), wiki pages whose node vanished (dead), nodes crossing a criticality threshold
  with no semantic page (coverage gap). Output feeds CI annotations and the compile
  agent's queue. This is Falconer's drift detection made exact.

### L1 — the semantic wiki (small, earned, provenance-locked)

- **Not a page per model.** Page population follows the worthiness gates: pages for
  **domains/marts** (always), **recurring failure modes**, **incidents** (filed back by
  the absorb pipeline), **playbooks**, **cross-model concepts** (metric definitions,
  grain conventions), and **models only when earned** (2+ incidents, or criticality, or
  genuine tribal knowledge — progressive refinement: "structure is earned, not
  imposed"). Target population: low hundreds of pages ≈ 50-100k tokens — inside every
  demonstrated envelope.
- **Contract**: OKF subset + extensions (§4.1). Frontmatter: `type` (from a controlled
  vocabulary: `Domain | Model | Concept | Incident | Playbook | Query`), `resource`
  (unique_id URI where applicable), `manifest_checksum`, `status`
  (`stub|draft|verified|superseded`), `owner`, `confidence`, typed semantic relations
  (`documents`, `caused_by`, `supersedes`, `contradicts`, `computes_same_metric_as`) —
  **never** `depends_on`: lineage edges in prose or links are banned by lint, because
  duplicated lineage is guaranteed drift.
- **Hybrid pages** use `<!-- @generated -->` / `<!-- @user -->` sentinel blocks
  (obsidian-architect pattern): the generated block re-renders from the manifest each
  merge; curated blocks are never touched by regeneration.
- **Every claim cited** (incident ID, PR, dbt test, dashboard URL, run_results
  invocation id) — uncited claims are lint defects; caveats/known-issues live in a
  structured `## Known issues` list kept near-verbatim (the exception-loss lesson);
  agent-written hypotheses carry `confidence: hypothesis` until a human or a later
  incident confirms.

### L2 — navigation and runtime consumption

- **Deterministic first**: the triage agent answers structure questions (`what feeds
  X`, `what breaks if X is wrong`, `which exposures are downstream`) with `wikictl`
  calls over the local manifest — the dbt-mcp `get_lineage_dev` shape, millisecond-fast,
  zero tokens. Blast-radius ranking = child_map walk × exposure maturity/owner weights
  (the traversal-precision fix: "everything is downstream" is not a severity).
- **Then routed reading**: session init loads the schema file + the relevant domain's
  routing index (not the whole catalog); `backlinks.json[unique_id]` yields candidate
  pages; read ≤3-5 pages, follow links ≤2 hops, hard tool budget ~15 (the RaR/WikiKV
  discipline: 2-3 reads/query is the production norm).
- **False-absence guard as protocol**: before reporting "no prior incidents," the agent
  must grep the incident index by unique_id and aliases and cite the empty result.
- **Per-incident working frame, not wiki writes**: runs are read-only against the wiki
  (single-writer rule); the run's findings go to its result envelope, and the **absorb
  pipeline** (below) files durable knowledge back asynchronously.

### The maintenance loop (who writes, when)

| Trigger | Actor | Action |
| --- | --- | --- |
| merge to dbt repo (CI) | code, no LLM | regenerate L0; drift diff; validator + deterministic lint gate |
| dbt run failure (`dag_complete` + `only_if: dbt_failed_nodes`) | triage agent | read-only consumption (already wired in this backend) |
| after triage/anomaly runs | absorb agent (single writer) | crystallize run → incident page draft + updates to affected pages, on a branch; deterministic verify; PR |
| weekly (`schedule` trigger) | compile agent | batch-absorb merged PRs/postmortems; reconcile contradictions → conflict pages; refresh stale-checksum pages only |
| weekly/monthly | lint + probe suite | deterministic lint; WiCER-style probes mined from past incidents replayed against the wiki; failures → preservation constraints in the compile prompt (Error-Book pattern) |
| quarterly | humans | review `contested`/`hypothesis` pages; promote/demote; prune cold pages (LRU demotion, never deletion) |

Humans gate every semantic merge via ordinary PR review (the consensus autonomy
boundary: agents auto-append dated sourced facts; page creation and restructuring pass
a human). The git history is the audit ledger.

---

## 8. Concrete build plan for `credible-bi-airflow-triage`

Where it lives: a `knowledge/` directory **in the dbt repo** (the repo the runner
already clones), sibling to `models/` — following OpenWiki/AutoWiki's in-repo
convention. The backend repo gains one skill and one tool; the Gantry console needs no
changes (the Library page will simply show the new skill; a knowledge-browser page is a
possible later addition).

**Phase 0 — deterministic only (1-2 days of work, immediate value):**
`knowledge/bin/wikictl` (Python, stdlib + manifest.json): `node`, `lineage --up/--down
--depth N`, `impact <id>` (descendants ranked by exposure maturity/owner/meta
criticality), `exposures <id>`, `diff <old-manifest>`. Wire as a backend tool
(`tools/wiki_query.yaml`, SELECT-free, read-only) and extend `skills/dbt.md`: "for
blast radius, call wikictl impact; never infer lineage from SQL." **This alone closes
most of the severity-classification gap** — before any wiki exists.

**Phase 1 — L0 projection + CI:** generator renders cards/routing indexes/registry to
`knowledge/generated/` (gitignored or committed — committed preferred for auditability);
CI job on merge regenerates + runs the ~150-line validator; drift report as a CI
annotation. Seed `knowledge/wiki/domains/<domain>.md` pages (one per top-level dbt
folder) with `@generated` skeletons + empty curated blocks.

**Phase 2 — absorb loop:** new agent pack `agents/wiki-absorb/agent.yaml` (single
writer), triggered `dag_complete` after triage runs and weekly `schedule`: crystallize
each triage result envelope into `knowledge/wiki/incidents/INC-<date>-<slug>.md`
(structured: failed nodes by unique_id, root cause, blast radius decided, severity,
smallest fix, lesson), update affected domain/model pages' `## Incident history`
(append-only, dated, cited), branch + PR. Absorb ledger
(`knowledge/meta/absorbed.json`) keyed by run invocation_id for idempotence across
Airflow retries.

**Phase 3 — consumption discipline:** `skills/dbt-wiki.md` skill encoding §7 L2
(deterministic-first routing, page budget, false-absence guard, citation of wiki pages
in triage reports by path). Add `knowledge_search` tool only if grep over routing
indexes proves insufficient (expected: it won't, below ~500 pages; QMD is the
escape hatch, already CLI+MCP).

**Phase 4 — quality machinery:** probe suite from the first N incidents ("what does the
wiki need to answer for this incident to have been triaged right?") run weekly;
Error-Book file of compile-prompt constraints; quarterly human review cadence;
per-type staleness thresholds.

Rollout metric (the R&D World lesson — watch maintenance ≈ savings): track per-run
pages read, wiki citations per triage report, severity-classification corrections by
humans, and absorb-PR review time. If review time grows past triage time saved, shrink
the page population, not the pipeline.

## 9. What not to build (anti-patterns, each observed failing)

1. **A wiki that restates the manifest** (lineage prose, column lists in curated pages)
   — stale on next compile; the single most-reported failure ("docs drift").
2. **Page-per-model on day one** — thousands of stubs is the anti-thinning failure at
   scale; generate cards (L0), earn pages (L1).
3. **Vector infrastructure first** — every measured system below ~thousands of docs
   found grep+routing better and debuggable; "bolting embeddings onto a 200-note vault
   is solving a problem you do not have." Measure recall on a bootstrapped eval set
   before adding any index (the 0% recall@10 fix was structural, not vectorial).
4. **Wiki-as-context-stuffing** — blind compilation drops 53-60% of query-critical
   facts; compile for traversal + citation, keep the envelope under 60 kB by pulling,
   not pushing.
5. **Agents writing to main / concurrent writers** — branch → verify → PR, single
   absorb writer, read-only runs (unsolved everywhere else).
6. **Auto-resolving contradictions or auto-applying semantic "fixes"** — 0.20 precision;
   prompted refinement is net-harmful without a trained/conservative policy; surface,
   gate on humans.
7. **Trusting agent memory for absence** — mandatory grep-before-"no prior incidents."
8. **Summarizing caveats** — exception-dense content loses its qualifiers in
   compilation; keep known-issues verbatim and structured.
9. **Adopting a hosted wiki product for this** — the marketing-tier products reviewed
   (Agent Wikis, Pinecone Nexus, grok-wiki, Falconer) publish no architecture that
   survives scrutiny, and the runtime constraint (in-VPC repo checkout) rules them out
   anyway.
10. **One global staleness rule** — half-lives are per-content-type; a metric definition
    and a vendor-flakiness note age differently.

---

## Appendix A. Every link in awesome-llm-wiki, dispositioned

Legend: **deep** = read in full / primary analysis in this report; **skim** = README or
article skimmed for distinct mechanisms; **skip** = deliberately not studied, with reason.
Nothing was skipped for convenience; skips are categorized (personal-vault variant of the
same pattern, GUI shell, video/podcast, vendor marketing, dead link, derivative
restatement of the gist).

### Foundations
| Link | Disposition |
| --- | --- |
| Karpathy LLM Wiki gist | **deep** — primary source, §2 |
| graphwiki (lucianfialho) | **deep** — §3 (property-graph mapping) |
| LLM Wiki v2 (rohitg00) | **deep** — §3 (scale, decay, typed graphs) |
| Farza's personal wiki skill | **deep** — §3 (skill decomposition) |

### Articles and guides
| Link | Disposition |
| --- | --- |
| Karhade, "Karpathy Killed RAG?" | **deep** — §3.3 decision zones; enterprise gaps (RBAC/ACID/audit) in §3.6 |
| andrej-karpathy.com concept guide | **skip** — page inside the reference vault (see Live implementations); derivative of the gist |
| tahirbalarabe2, "What is LLM Wiki Pattern" | **skim** — faithful restatement of the gist; no new mechanisms |
| tahirbalarabe2, Build/Automate second brain (×2) | **skip** — personal Obsidian variants of the same pattern |
| Pinecone Nexus posts (×2) | **skip** — vendor marketing for a closed product; the one idea (pre-compiled context layer) is better documented elsewhere |
| Denser.ai, VentureBeat | **skip** — content marketing / journalism restating the gist |
| DAIR.AI (×2) | **deep** — §3 four-phase pipeline |
| Leo Alexandru, "Build your AI Brain" | **deep** — §3 (taxonomy, 12-skill ecosystem) |
| Thinkers Club, agent-only vault | **deep** — §3 (human/agent boundary; "Foundry") |
| Commonplace (zby) | **deep** — §3 (deploy-time learning theory) |
| Roan Brasil (×2) | **skim** — the substantive content is the `llm-wiki-compiler` engine, reviewed directly below |
| saranfn trilogy (×3) | **skip** — personal-vault content-architecture series; token-bloat advice duplicated by stronger sources |
| Ben Kamens, disease wiki | **skip** — medical-domain personal case study; rigor mechanisms (deterministic verification) captured via other sources |
| ai-primer case studies | **deep** — §3 (recurring operational setups) |
| doit.com (Quick Desktop) | **skip** — personal implementation review, tool-specific |
| Syd Sachar Row-Bot thread (X) | **skip** — thread about a desktop app (see Applications) |
| "How to Build an AI Brain That Never Forgets" | **skip** — personal-vault variant |
| Mike Written, "I Tested 5 Implementations" | **deep** — §3 (comparative evidence: schema discipline) |
| LangChain blog set (OpenWiki intro / 0.2 OKF / Brains / Wiki Memory) | **deep** — §4 |
| AAIF, wiki as agent memory | **deep** — §3 (memory-type mapping) |
| theaioperator, "v2: What to Keep" | **deep** — §3 (routing at thousands of nodes) |
| Agentpedia "Complete Guide" | **skip** — derivative SEO deep-dive of the gist |
| Ken Moriwaki series (×3) | **skip** — minimal personal implementation series; superseded by production sources |
| IVGraph (Notion 3D) | **skip** — Notion/visualization variant |
| Falconer enterprise guide | **deep** — §3 (drift detection) |
| ricardodecal, self-authoring KBs | **skip** — concept piece; realized concretely by pi-llm-wiki trajectory distillation (§3) |
| vasileios, "Real Second Brain" | **skip** — architectural essay, derivative |
| Penfield Labs critique | **deep** — §3 (token scaling, dedup, hooks) |
| Decoding AI, "Second Brain Is a Graveyard" | **skip** — research-OS variant of the pattern |

### Specifications
| Link | Disposition |
| --- | --- |
| OKF v0.1 SPEC.md + Google Cloud announcement | **deep** — §4 |

### Tools (libraries, apps, extensions, CLIs, MCP, hosting, skills)
| Link | Disposition |
| --- | --- |
| synthadoc, Eva-brain, Nash Su LLM Wiki, Memento, nohmitaina, Sofie, the-curator, Wikikarp, Wikiwise, Cabinet, Row-Bot, whoami.wiki | **skip** — desktop/GUI shells around the same vault pattern; noted: Cabinet (git-backed auto-commit + cron), Nash Su (two-step CoT ingestion, async human review), OpenKnowledge (CRDT human+agent co-editing), yopedia (dual-surface human-markdown + 28-tool MCP), Tolaria (auto-AGENTS.md, MCP-native) |
| OpenKnowledge, Tolaria, yopedia | **skim** — one distinct mechanism each, noted above |
| claude-obsidian, green-dalii, domleca, twillm | **skip** — editor/Obsidian plugins, client-side variants |
| Matryca Plumber | **skim** — optimistic concurrency control on block-level AST mutations; background link healing |
| DeepWiki-Open | **deep** — §4 (codebase→wiki engine) |
| agentic-stack, JeanBaissari monorepo, LLM Research Wiki, browzy, CacheZero, cobusgreyling, digital-me-dream-cycle, Klore, LLM Wiki (nvk), LLM Wikid, llmwiki (lucasastorian), lorewiki, my-wiki, obsidian-knowledge, obsidian-wiki, quarry-kb, suwonleee, Lexicon, Atomic, EverOS | **skip** — same-pattern re-implementations; distinct bits noted where real: Oh My Wiki (Socratic accept/reject wizard), Lexicon (manual-edit preservation), Patina (mmap'd deterministic graph, no DB), Cosma (static HTML graph export) |
| Oh My Wiki, Patina, Cosma | **skim** — one distinct mechanism each, noted above |
| agent-wiki-cli | **skip** — two-pass compile + lint hooks, duplicated by stronger tools |
| AI Research OS | **skim** — §3 (index.yaml + open-questions.md); otherwise workshop marketing |
| AutoSci | **skim** — §3 (dual-layer memory: durable knowledge vs active project frames; arXiv 2605.31468) |
| knowledge-worker | **skim** — §3 (provenance-or-bust, review-before-merge) |
| vault-curator | **skim** — §3 (fill-only-missing enrichment, MOC indexes) |
| llm-wiki-tools | **skim** — §3 (concept-oriented pages, surgical patches, read/manage CLI split) |
| llm-wiki-compiler (atomicstrata) | **deep** — §3.4/§4.2 (strongest reference implementation: lifecycle profiles, fail-closed gates, line-range citations, stale-only refresh, eval harness) |
| OpenKB (PageIndex) | **deep** — §3.6 (vectorless tree retrieval, Skill Factory) |
| mykg | **deep** — frozen-ontology two-pass extraction + review gate; informs the §7 design stance |
| hippocampus | **deep** — §4.1 (OKF-adjacent template in practice: hot.md, content_hash, read discipline) |
| Graphify, Understand Anything, codeglance, Tesserae, QMD | **deep** — §4.2/§7 (deterministic-first graph compilation, token-efficiency, projection pattern, hybrid search) |
| ByteRover, Enzyme, GBrain | **skim** — README-level only (the research pass covering them was cut short by a session limit); noted mechanisms: hierarchical context tree + lifecycle (ByteRover), precomputed concept catalysts (Enzyme), zero-LLM typed extraction + background dream cycle (GBrain) — all variants of patterns covered by stronger sources |
| memory-arena | **deep** — §5.1 (benchmark harness; wiki wrong for episodic memory) |
| Beever Atlas, mindbase, Link, Linkly, Memora, SwarmVault | **skip** — MCP variants; noted: Beever Atlas (permission mirroring chat→graph), Memora (LLM dedup) |
| Synto | **dead** — repository 404s |
| pi-llm-wiki | **deep** — §3 (4-layer ownership model, trajectory distillation) |
| PieKBS | **deep** — §3.4/§7 (search-engine philosophy: bounded search+read primitives, agents synthesize their own answers; `_draft/` quarantine for under-sourced pages) |
| GitNexus | **deep** — §4 (repo→graph+wiki, MCP) |
| Agent Wikis | **skim** — marketing page; kept only the `llms.txt` / `llms-full.txt` / `index.json` serving convention; eval claims unverifiable |
| AutoWiki (Factory) | **deep** — §4 |
| Portable LLM Wiki | **skip** — hosted personal-vault product, thin public detail |
| vercel-labs/openwiki | **deep** — §4 (scheduled update model) |
| wikihub.md | **skim** — per-file ACL (`.wikihub/acl`, CODEOWNERS pattern) + agent REST API; hosting-layer ideas only |
| Engram (NoobAIDeveloper), hstack, Astro-Han, lewislulu, SamurAIGPT, obsidian-second-brain, DAIR wiki-builder, cortexes, Memory OS, PM Wiki | **skip** — skill-suite variants; PM Wiki's domain-schema lesson captured via the 5-implementations review; Memory OS noted (7-layer trust-scored memory) |
| TrueHOOHA LLM-Wiki-Skilled | **skim** — §3 (operations-as-skills, OKF-conformant, no helper scripts) |
| MehmetGoekce llm-wiki | **deep** — §3 (L1/L2 cache model) |
| Hermes bundled research-llm-wiki skill | **deep** — §3 (first-party skill: thresholds, 13 lint checks) |
| owledge | **skim** — §3 (generated-views principle, multi-agent artifacts, benchmark) |
| sametbrr llm-wiki-manager | **skip** — idempotent scaffolding scripts; mechanisms duplicated |

### Live implementations
| Link | Disposition |
| --- | --- |
| andrej-karpathy.com | **skim** — live reference vault (Cognee-backed) demonstrating background query-synthesis; consumed as an existence proof, not architecture |

### Research and papers
| Link | Disposition |
| --- | --- |
| Retrieval as Reasoning (2605.25480); WiCER (2605.07068); WikiKV (2606.14275); RAG-vs-Wiki (2605.18490); DeepRefine (2605.10488); Beyond RAG (Zenodo) | **deep** — §5 |

### Videos and podcasts
All 18 videos + 1 podcast: **skip** — not watchable in this environment; where a video had
a written companion (rdworldonline 30-day review, theaioperator rebuild, Marie Haynes OKF
pages, MehmetGoekce article), the companion was read instead. Per their descriptions, the
video-only content (Obsidian setup walkthroughs, OKF explainers, personal-archive builds)
duplicates written sources reviewed above.
