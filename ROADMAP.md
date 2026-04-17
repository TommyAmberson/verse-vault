# Roadmap

## Phase 1: Core Algorithm ✅

Edge-based memory graph with FSRS integration.

- [x] Graph model (7 node types, 11 edge types, directionality)
- [x] FSRS bridge (retrievability, next_states, weighted interpolation)
- [x] Path enumeration (DFS, 5-hop, no revisits)
- [x] Anchor transfer (distance decay for reference derivation)
- [x] Credit assignment (6-step algorithm, source set expansion, fallback chain)
- [x] Scheduling (effective_R, due_date binary search, priority scoring)
- [x] Post-review cascade (edge→card mapping)
- [x] ReviewEngine facade
- [x] Session module (re-drills, progressive reveal)
- [x] Basic simulation framework

## Phase 2: Graph Builder + Content Pipeline

Make the system work with real Bible content instead of hand-built test graphs.

- [ ] Graph builder: structured verse data → Graph + edges
- [ ] Card catalog builder: Graph → all card types per verse/chapter
- [ ] Bible content ingestion: KJV text with verse boundaries
- [ ] Phrase chunking: AI-generated or punctuation-based phrase boundaries
- [ ] Club 150/300 verse list loading
- [ ] Heading data loading

## Phase 3: CLI

Terminal interface for personal use. Fastest path to actually memorizing.

- [ ] Session-based review loop (show card → type verse → diff → grade)
- [ ] New verse introduction (progressive reveal in terminal)
- [ ] Edge state persistence (save/load between sessions)
- [ ] Chapter/verse selection (pick what to study)
- [ ] Progress display (stabilities, due counts, streak)

## Phase 4: Simulation + Validation

Verify the algorithm works before building for others.

- [ ] Multi-verse scenarios (2 adjacent, full chapter)
- [ ] Proper per-card prediction tracking (log loss, AUC, RMSE)
- [ ] Vanilla FSRS per-card baseline comparison
- [ ] User's Anki parameters as whole-verse baseline
- [ ] Fix simulated learner (per-atom last_review tracking)
- [ ] Sensitivity analysis (α, β, decay_factor)

## Phase 5: API Server

Backend for the web app. Rust (Axum), lightweight JSON API.

- [ ] Database schema (SQLite: edges, cards, users, verse content)
- [ ] Auth (accounts, sessions)
- [ ] API endpoints: start session, get next card, submit grades, get progress
- [ ] Content API: list chapters, verses, club lists
- [ ] Per-user FSRS parameter storage

## Phase 6: Web Frontend

The "visit, account, start memorizing" experience.

- [ ] Framework selection (deferred — independent of backend)
- [ ] Card review UI (show prompt, type response, diff display, grading)
- [ ] Session flow (progressive reveal, re-drills)
- [ ] Chapter/club selection
- [ ] Progress dashboard
- [ ] Mobile-responsive design

## Future

- [ ] Per-user FSRS parameter optimization (from review history)
- [ ] Multiple translations (ESV, NIV — with licensing)
- [ ] Team features for QuizMeet teams
- [ ] Customizable learning flow
- [ ] Import from Anki
