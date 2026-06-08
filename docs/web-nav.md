# Web nav

Information architecture and layout for the web client's top-level navigation. Covers the route
inventory, mobile vs. desktop chrome, and how identity/account chores fit in. Drives the redesign of
the current single-row `<header>` in `apps/web/src/App.vue`, which overflows on phones and mixes
navigation with identity.

## Goals

* **Thumb-friendly on mobile.** The daily-driver actions (start a review, memorize new verses) must
  be reachable without reaching the top of the screen and without going through a menu.
* **Same Vue bundle scales to desktop.** Tauri reuses this client (`docs/architecture.md`), so the
  nav has to read well in a desktop window too — not just a phone.
* **Identity is not navigation.** Email, switch-profile, sign-out, export/import/reset belong in a
  corner menu, not in the row alongside Review and Memorize.
* **Room to grow.** Future Search, Account sub-page, History, and a real preferences surface should
  slot in without a redesign.

## Current state

`App.vue` renders a single `<header>` with a flex row containing: brand, five `<RouterLink>`s
(Dashboard, Review, Memorize, Settings, Stats), the signed-in email as plain text, and a **Switch
profile** link styled as a button. There is no responsive treatment — on a phone the row just
overflows. Account-data management (export / import / delete-all-progress) is buried as kebab menu
items inside `ProfilePickerView`'s profile cards, not surfaced anywhere in the nav.

## Route inventory

Source of truth: `apps/web/src/router/index.ts`.

| Route       | View                | Purpose                                                                                      | Cadence      |
| ----------- | ------------------- | -------------------------------------------------------------------------------------------- | ------------ |
| `/home`     | `HomeView`          | At-a-glance landing: stability, recent activity, empty-state CTA                             | daily glance |
| `/review`   | `ReviewView`        | Run a review session (single-grade pipeline)                                                 | daily action |
| `/memorize` | `MemorizeView`      | Read → drill new-card walkthrough across enrolled years                                      | daily-ish    |
| `/settings` | `SettingsView`      | Per-year scope sliders, headings/ftv toggles, offline-mode                                   | weekly+      |
| `/stats`    | `StatsView`         | Activity heatmap and aggregate stats                                                         | weekly+      |
| `/profiles` | `ProfilePickerView` | Sign-in form + multi-profile picker; **also** the secret home of account export/import/reset | rare         |

Aliases (redirects): `/` → `/home`, `/session` → `/review`, `/signin` → `/profiles`, `/material` →
`/settings`, `/dashboard` → `/home`.

### Future surfaces to leave room for

Not building these now — but the nav design must not preclude them:

* **Search / browse** — look at a verse outside the review/memorize flow. Reference layer.
* **Account sub-page under `/settings`** — relocate export / import / delete-all-progress out of
  `ProfilePickerView`'s kebabs into a real Account section. Linked from the profile switcher. See
  _Backlog_ below.
* **History / audit log** — server already has the event log; no UI today. Reference layer.
* **About / attribution / help** — currently in the footer; would slot into the identity menu.

## IA: three layers

The nav has three semantically distinct layers. Today they're crammed into one row; the redesign
puts each in its own slot.

1. **Action layer** — the verbs the user came to do.
   * Members: **Review**, **Memorize**.
   * Mobile: bottom tab bar (thumb-reach).
   * Desktop: integrated into the top bar with the reference layer.

2. **Reference layer** — landing pages and inspection surfaces.
   * Members: **Home** (`/home`), **Settings**, **Stats**.
   * Mobile: bottom tab bar alongside the action layer (5 tabs total).
   * Desktop: same top bar as the action layer.

3. **Identity layer** — who you are and how you administer this account.
   * Members: signed-in email, **Switch profile**, future **Sign out**, future **Account →** link
     (deep-link into the Account section of `/settings`).
   * Mobile and desktop: avatar/initials button top-right, opens a popover menu.

The action / reference split is conceptual, not visual. On screen, both layers live in the same
component (the bottom tab bar on mobile, the top bar on desktop). The split governs _priority_: if
we ever need to demote a destination to a "More" sheet, reference items go first.

## Layout

### Mobile (≤ 720 px viewport width)

* **Top bar** (sticky): brand on the left, avatar button on the right. ~48 px tall. No nav links.
* **Bottom tab bar** (sticky): five tabs in this left-to-right order: **Home · Review · Memorize ·
  Settings · Stats**. Icon + short label per tab. The active tab uses the existing `--color-accent`
  treatment.
* **Memorize-new pill**: the existing "new to memorize" count badge follows the Memorize tab.
* **Safe-area inset**: bottom bar respects `env(safe-area-inset-bottom)` so it sits above the iOS
  home indicator and Android gesture bar.

### Desktop (> 720 px viewport width)

* **Single top bar** (sticky): brand on the left, five nav links in the middle (**Home · Review ·
  Memorize · Settings · Stats**), avatar button on the right.
* No bottom bar.

### Identity popover

Opened by tapping the avatar in either layout. Contents (top to bottom):

1. Display name + signed-in email (read-only header).
2. **Switch profile** (existing `/profiles?force=1` link).
3. **Sign out** (calls `useAuth().signOut()` against the active profile, then pushes `/profiles`).
4. **Account →** (backlog — deep-link to `/settings#account` once that section ships).

Keep the popover light on chrome — small surface, plenty of padding, no nested submenus.

## Implementation plan

Single feature branch (`feat/web-nav-redesign`), one commit per logical step. The `/material` →
`/settings` rename is already on this branch as commit 1.

1. **Rename `/dashboard` → `/home`.** `DashboardView.vue` → `HomeView.vue`, route + name + nav label
   updated, redirect `/dashboard` → `/home` for back-compat with bookmarks. Parallel to the
   `/material` → `/settings` rename in shape and rationale.
2. **Avatar component + identity popover.** New `AppAvatar.vue` + popover, wired to existing auth
   state. Replaces the email-text + Switch-profile link in `App.vue`'s header. Desktop and mobile
   both render this from day one.
3. **Top bar layout.** Refactor `App.vue`'s `<header>` into a brand-left / nav-center / avatar-right
   composition. Single-row at desktop widths.
4. **Bottom tab bar.** New `MobileTabBar.vue`. Rendered at mobile widths only (CSS media query; no
   JS branch). Adds a `padding-bottom` rule on `.site-main` equal to the bar height so content isn't
   covered.
5. **Polish + a11y.** Tab `aria-current="page"` on active routes, focus-visible rings,
   reduced-motion handling for any transitions. Manual smoke on a phone-sized viewport (golden path:
   review, memorize, switch via tab bar, open identity popover, switch profile).

Each step ships independently with no behaviour regression. Step 1 is mechanical; step 2 is the
biggest visual change; step 3 is additive.

## Open questions

* **Bottom-bar breakpoint.** 720 px is the existing `max-width: 720px` value `.settings` uses for
  its centered column. Could also key off `pointer: coarse` to handle desktop windows narrowed to
  phone width. Default: width-based; revisit if it misbehaves on landscape phones.
* **Icon set.** No icons in the codebase today. Lightweight options: inline SVGs in
  `components/icons/`, or pull a single icon font (Lucide, Tabler). Default: inline SVGs to avoid a
  runtime dep.

## Backlog

Tracked here so the spec stays the canonical record; promote to GitHub issues as work picks up.

* **Account sub-page under `/settings`.** Migrate export / import / delete-all-progress out of
  `ProfilePickerView`'s profile-card kebabs into a real `/settings` → Account section. The profile
  switcher links into it; the kebabs go away. Lets `/profiles` go back to being purely sign-in +
  multi-profile switching, which is its original job.
* **Search route.** First reference-layer addition; no design exists yet.
* **Theme / appearance.** Once a global preference exists, slot under `/settings` → Appearance.
* **About / attribution surface.** Currently the API.Bible + NKJV copyright lines in the footer;
  could move to identity menu → About.
