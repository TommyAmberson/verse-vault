# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Current phase: pre-implementation

The owner is still deciding what this app should be and which framework to use. The current priority
is **writing docs and brainstorming the product**, not writing code. Default to helping shape ideas,
requirements, and design — do not jump to scaffolding, picking a stack, or generating boilerplate
unless asked.

When the user shares ideas, help them explore and document. Ask about intent and tradeoffs before
proposing structure.

## Repository layout

* `master` (this branch) is a near-empty scaffold:
  `backend/versevault/{authz,core,users,messages_api,common}/` and `src/{controllers,models}/` are
  present as empty Django/Node directory stubs. There is no `package.json`, `manage.py`,
  `requirements.txt`, or `settings.py` — do **not** invent build/run/test commands from the
  directory names.
* Other branches contain earlier exploratory attempts at different stacks, visible from their names:
  `django-vue` (and numbered variants `django-vue00`..`django-vue9`), `laravel`, `laravel-vue`,
  `express-vue`, `sirix-vue`, `vue`, `hapi`. Treat these as abandoned spikes — reference them only
  if the user asks what was tried before. Do not merge from them or resurrect their code without
  explicit direction.
* `.env` and `backend/.env` exist locally and are correctly gitignored — do not suggest they need to
  be untracked.

## Git conventions

* Commits must be atomic and single-responsibility — one logical change per commit.
* Do not add `Co-Authored-By` lines.
