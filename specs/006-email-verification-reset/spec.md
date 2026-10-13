# Feature Specification: Email Verification and Password Reset

**Feature Branch**: `feat/email-verification-reset`

**Created**: 2026-10-06

**Status**: Draft

**Input**: User description: "adding email verification and password reset"
(TommyAmberson/verse-vault#171)

## Context

Email and password sign-up is open and the address is never checked. There is no way to recover a
forgotten password. Two problems follow:

* **No recovery.** A learner who forgets their password loses access to the account and, with it,
  every profile's review history held on the server.
* **Unverified addresses block Google sign-in.** Google sign-in refuses to merge into an existing
  password account whose address has not been verified, which is what stops someone from
  pre-registering another person's address and then inheriting their Google sign-in. Since no
  password account is ever verified, a password learner can never add Google sign-in, and an address
  registered by someone who does not own it stays blocked for the real owner, who cannot reset it
  either. Today's error message tells them to sign in with email and password, which they may not be
  able to do.

The sending provider and sender address were decided in the issue (step 1): the app sends from
`no-reply@versevault.ca` through a transactional email provider over HTTPS. This spec covers what
learners see and what the system guarantees, not the provider.

Decided direction (issue step 3): verification is the key to account linking, **not** a gate on
signing in. Requiring verification before sign-in would lock every existing password learner out
until they verify. That can be tightened later.

## Clarifications

### Session 2026-10-06

* Q: How does the real owner get back an address someone else registered with a password, and how
  does a password learner add Google sign-in? → A: Three routes. (1) Password reset, unchanged. (2)
  Signed in with the password, "Connect Google" in account settings links a Google account with the
  same address, keeps the password, and verifies the address. (3) Signed out, a Google sign-in that
  lands on an unverified password account shows a choice instead of refusing: "That's me" asks for
  the password and links as in (2); "That's not me" takes the account over after explicit warnings,
  removing the password and ending every other session. Account settings warn that an unverified
  address can be taken over this way.
* Q: Should a learner who only signs in with Google be able to add a password through "forgot
  password"? → A: Yes. A reset link for a Google-only account sets its first password.
* Q: What can an owner use to clear what someone else left in an account? → A: Two actions in
  account settings, "Delete all progress" (existing) and a new "Reset account", each confirmed by
  typing a challenge phrase.
* Q: What must the learner type to confirm "Delete all progress" or "Reset account"? → A: The
  account's email address, exactly.
* Q: How many reset or verification emails may one address trigger per hour? → A: 3 per address per
  hour, counting reset and verification together.
* Q: Should this ship as one release or two? → A: One spec, two pull requests in order: phase 1 is
  User Stories 1 to 3 (reset and verification), phase 2 is User Stories 4 and 5 (Google linking,
  takeover, and Reset account).
* Q: Does following a verification link while signed out sign the person in? → A: No. The link never
  signs anyone in. (Tightened by the security review below: a signed-out learner signs in first,
  then the verification completes.)
* Q: Besides account settings, where does a learner see that their address is not verified? → A: On
  the profile picker (the sign-in and profile selection page), as a badge on each unverified
  profile. No notice on Home.

### Security review 2026-10-07

* A verification link verifies only for a learner signed in to that account. Otherwise someone who
  pre-registers another person's address could get the real owner to verify it by clicking the
  genuine email, keeping the attacker's password on an account that then accepts the owner's Google
  sign-in (GHSA-g38m-r43w-p2q7 reopened). Signing in proves the password; the email proves the
  inbox; both are needed.
* Google is no longer a trusted provider for linking: Google sign-in links into an existing account,
  takes over, or verifies an address only when Google itself reports the address verified.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Reset a forgotten password (Priority: P1)

A learner who has forgotten their password asks for a reset from the sign-in form by entering their
email address. They receive an email with a single-use link. Following it opens the web app, where
they choose a new password. They can then sign in with it, and any session that was signed in to
that account elsewhere is signed out.

**Why this priority**: without it, a forgotten password is permanent loss of access. It is also the
recovery path for an address someone else registered: the real owner proves they hold the inbox by
completing a reset.

**Independent Test**: create a password account, sign out, request a reset from the sign-in form,
follow the emailed link, set a new password, and sign in with it. The old password no longer works.

**Acceptance Scenarios**:

1. **Given** a password account for an address, **When** the learner requests a reset for that
   address, **Then** the form confirms that a reset email is on its way if an account exists, and
   the inbox receives one email with a reset link.
2. **Given** an address with no account, **When** someone requests a reset for it, **Then** the form
   shows the same confirmation as in scenario 1 and no email is sent.
3. **Given** an account that only signs in with Google, **When** a reset is requested for its
   address, **Then** the inbox receives a reset link, and following it sets the account's first
   password; Google sign-in keeps working.
4. **Given** a valid reset link, **When** the learner sets a new password that meets the password
   rules, **Then** the new password works, the old one does not, and every existing session for that
   account is ended.
5. **Given** a reset link that has expired or has already been used, **When** the learner opens it,
   **Then** they see that the link is no longer valid and can request a new one from the same page.
6. **Given** the learner completes a reset, **Then** the account's address counts as verified.

---

### User Story 2 - Verify the address at sign-up (Priority: P2)

When someone creates a password account, the app sends a verification email to the address. The new
account is usable straight away. Following the link while signed in to that account marks the
address as verified and shows a confirmation in the web app; a signed-out learner signs in first.

**Why this priority**: it is what lets a password account later accept Google sign-in, and it gives
every new account a confirmed recovery address. It does not block anyone, so it is less urgent than
recovery.

**Independent Test**: sign up with a new address, confirm the account works before verifying, follow
the emailed link while signed in, and confirm the account now shows as verified. Follow it again
from a signed-out browser and confirm it asks for sign-in before anything changes.

**Acceptance Scenarios**:

1. **Given** someone creates a password account, **When** sign-up succeeds, **Then** they are signed
   in as today, a verification email is sent to the address, and they are told to check their inbox.
2. **Given** an unverified account, **When** the learner follows a valid verification link while
   signed in to that account, **Then** the address is marked verified and the web app confirms it.
3. **Given** a valid verification link opened while signed out, or while another profile is active,
   **When** it is opened, **Then** nothing is verified yet; the learner is asked to sign in to that
   account, and verification completes once they have.
4. **Given** an expired or invalid verification link, **When** it is opened, **Then** the learner
   sees that it is no longer valid and how to request a new one. Opening a valid link a second time
   just confirms the address is verified.
5. **Given** an unverified account, **When** the learner signs in, **Then** sign-in succeeds exactly
   as it does today.

---

### User Story 3 - Verify an existing account later (Priority: P2)

A learner whose account predates this feature, or who lost the sign-up email, can see in account
settings that their address is not verified and can ask for a new verification email.

**Why this priority**: every password account that exists today is unverified. Without a way to
verify after the fact, none of them can ever add Google sign-in.

**Independent Test**: with an existing unverified password account, open account settings, request
verification, follow the link, and confirm settings now show the address as verified.

**Acceptance Scenarios**:

1. **Given** a signed-in learner with an unverified address, **When** they open account settings,
   **Then** they see that the address is unverified and an action to send a verification email.
2. **Given** they use that action, **Then** a verification email is sent and the page says so.
3. **Given** a verified address, **When** the learner opens account settings, **Then** no
   verification action is shown.
4. **Given** a device signed in to several profiles, **When** the learner opens the profile picker,
   **Then** each profile whose address is unverified carries an "unverified" badge, and verified
   profiles carry none.

---

### User Story 4 - Add Google sign-in to a password account (Priority: P3)

A password learner can add Google sign-in in two ways. Signed in, they choose "Connect Google" in
account settings. Signed out, they choose "Sign in with Google"; if the address belongs to an
unverified password account, the app says so and asks whether that account is theirs. If it is, they
enter the password and Google is connected. If it is not, they can take the account over after
explicit warnings, which removes the password and signs everyone else out.

**Why this priority**: it is the payoff of stories 2 and 3, and route 3 also lets the owner of an
address someone else registered get in with one Google sign-in instead of an email round trip.

**Independent Test**: with an unverified password account, connect Google from settings and confirm
both methods then work and the address is verified. Separately, from a signed-out device, sign in
with Google on another unverified password account, choose "That's not me", and confirm the old
password no longer works and its sessions are gone.

**Acceptance Scenarios**:

1. **Given** a verified password account, **When** the learner signs in with Google using the same
   address and Google reports that address verified, **Then** they are signed in to that account and
   can afterwards use either method.
2. **Given** a learner signed in with a password, **When** they choose "Connect Google" and sign in
   with a Google account that has the same address, **Then** Google is connected, the password still
   works, and the address is verified.
3. **Given** a learner signed in with a password, **When** they try to connect a Google account with
   a different address, **Then** the connection is refused and nothing changes.
4. **Given** an unverified password account and a signed-out device, **When** someone signs in with
   Google using that address, **Then** they see that an unverified account with this address already
   exists and are asked whether it is theirs, with "That's me" and "That's not me" choices.
5. **Given** that choice, **When** they choose "That's me" and enter the correct password, **Then**
   Google is connected, the password is kept, the address is verified, and they are signed in.
6. **Given** that choice, **When** they choose "That's not me", **Then** they first see a warning
   that whoever set the password will lose access and that the account may hold someone else's
   progress, and they must confirm before anything changes.
7. **Given** they confirm the takeover, **Then** the password is removed, every existing session for
   the account ends, Google is connected, the address is verified, they are signed in, and they are
   told how to clear what the account holds (User Story 5).

---

### User Story 5 - Clear an account's contents (Priority: P3)

A learner who has taken over an account, or simply wants a fresh start, can clear it from account
settings. "Delete all progress" (which exists today) removes review history and graduations but
keeps decks and settings. The new "Reset account" goes further and returns the account to the state
of a newly created one. Both are irreversible, so each asks the learner to type the account's email
address (the challenge phrase) before it runs, and both offer a backup download first.

**Why this priority**: a takeover leaves behind whatever the previous holder recorded. Without a
full reset, decks and settings they chose would remain.

**Independent Test**: on an account with progress, enrolled decks, and changed preferences, run
"Reset account", type the challenge phrase, and confirm the account now looks like a new one while
the same sign-in methods still work.

**Acceptance Scenarios**:

1. **Given** account settings, **When** the learner chooses "Delete all progress" or "Reset
   account", **Then** they are shown what will be removed and kept, offered a backup download, and
   asked to type the challenge phrase.
2. **Given** the confirmation step, **When** the typed text does not match the challenge phrase
   exactly, **Then** the action cannot be confirmed.
3. **Given** a matching phrase, **When** the learner confirms "Delete all progress", **Then** review
   history and graduations are removed and decks and settings stay, as today.
4. **Given** a matching phrase, **When** the learner confirms "Reset account", **Then** progress,
   enrolled decks, schedule changes, and preferences are removed, while the address, its verified
   state, and the sign-in methods stay.

---

### Edge Cases

* **Someone else registered my address.** The real owner either resets the password, which only they
  can complete because only they receive the email, or signs in with Google and chooses "That's not
  me". Both end the other person's sessions, verify the address, and give the owner the account.
  Anything the other person recorded remains, and the owner can clear it with "Delete all progress"
  or "Reset account" (User Story 5).
* **Wrong choice on the takeover screen.** A learner who picks "That's not me" for their own account
  loses only the password; their progress stays, and Google or a password reset still gets them in.
  The warning says this before they confirm.
* **Takeover screen reached without Google.** The choice is only offered right after a completed
  Google sign-in for that exact address. Opening it any other way, or after it has expired, shows
  nothing about the account and sends the learner back to sign in.
* **Wrong password on "That's me".** It behaves like a failed sign-in, with the same throttling, and
  offers the reset path.
* **Repeated requests.** Requests for reset or verification emails to the same address are
  throttled, so the form cannot be used to flood an inbox. When throttled, the learner is told to
  wait and try again later.
* **Several reset emails in a row.** Only the most recent reset link needs to work; using any link
  must not leave an older one usable afterwards.
* **Sending fails.** If the email provider is down or rejects the message, the learner sees the same
  confirmation as on success (so the response reveals nothing about the account), and the failure is
  logged on the server for the operator.
* **Desktop app.** Email links open in the system browser on the web app, not inside the desktop
  shell. After a reset, the learner signs in to the desktop app with the new password. A
  verification link asks the learner to sign in in that browser first, since the desktop app's
  session does not carry over to it.
* **Signed in as a different profile.** Opening a verification link on a device where another
  account is the active profile asks the learner to switch to, or sign in to, the account in the
  link before verifying. It never signs out the active profile.
* **A verification email for an account I did not create.** Someone registered my address and the
  app emailed me a verification link. Following it asks me to sign in to that account, which I
  cannot do without the other person's password, so it verifies nothing. Password reset or (phase 2)
  "That's not me" is the way in, and both remove the other person's access.
* **A Google account that Google has not verified.** A Google sign-in whose address Google reports
  as unverified never links into, takes over, or verifies an existing account; it is refused as
  today.
* **Development without an email provider.** When no provider credentials are configured, the server
  does not send email and instead writes the link it would have sent to its log, so sign-up, reset,
  and verification can be exercised locally.

## Requirements _(mandatory)_

### Functional Requirements

* **FR-001**: The sign-in form MUST offer a "forgot password" path from email sign-in that asks for
  an email address and requests a reset.
* **FR-002**: The response to a reset request MUST NOT reveal whether an account exists for the
  address, in its wording or in a measurably different response time.
* **FR-003**: A reset email MUST contain a single-use link that expires after a limited time (one
  hour by default). Any address with an account receives one; for an account without a password,
  completing the reset sets its first password.
* **FR-004**: Following a valid reset link MUST let the learner choose a new password under the same
  rules as sign-up, after which the old password stops working.
* **FR-005**: Completing a reset MUST end every existing session for that account, on every device.
* **FR-006**: Completing a reset MUST mark the account's address as verified, since receiving the
  email proves ownership of the inbox.
* **FR-007**: Creating a password account MUST send a verification email to its address, unless the
  client has reached its daily email limit (FR-012), in which case the account is still created and
  the learner can send the email later from settings. The account MUST be usable immediately, before
  verification.
* **FR-008**: A verification email MUST contain a link that expires after a limited time (24 hours
  by default). Following it MUST mark the address verified only when the learner is signed in to
  that account; otherwise the app MUST ask them to sign in to it first and verify only after they
  have. Following it MUST NOT sign anyone in or sign out the active profile.
* **FR-009**: Signing in MUST NOT require a verified address, for new and existing accounts alike.
* **FR-010**: Account settings MUST show whether the signed-in account's address is verified and,
  when it is not, offer to send a new verification email.
* **FR-026**: The profile picker MUST mark each profile whose address is unverified with a badge
  that says so. No other page shows a verification notice, apart from the message after sign-up
  (FR-007).
* **FR-011**: Expired, used, or malformed reset links, and expired or malformed verification links,
  MUST lead to a page that says the link is no longer valid and offers to request a new one, never
  to a raw error.
* **FR-012**: Requests that send email (reset and verification) MUST be throttled to at most 3
  requests per address per hour (reset and verification combined; the email sent at sign-up is not
  counted) and also per client, at most 10 emails per client per day including those sent at
  sign-up, and a throttled request MUST tell the learner to try again later. Sign-up itself is never
  refused for this limit.
* **FR-013**: All outgoing email MUST come from `VerseVault <no-reply@versevault.ca>`, contain the
  link as plain text as well as a button, and say why it was sent and what to do if the recipient
  did not ask for it.
* **FR-014**: Google sign-in using the address of a verified password account MUST sign in to that
  account. For an unverified one it MUST NOT sign in directly; it MUST show the choice in FR-019.
  Neither applies unless Google reports the address verified; otherwise the sign-in is refused.
* **FR-015**: Failures to send email MUST be logged on the server with enough detail for the
  operator to diagnose them, without logging the link itself in production.
* **FR-016**: When no email provider is configured, the server MUST log the link instead of sending,
  and MUST NOT fail the request.
* **FR-017**: The project's design docs MUST describe the reset and verification flows and the
  verification rules above, updated in the same pull request as the behaviour.
* **FR-018**: Account settings MUST let a learner signed in with a password connect a Google
  account. The Google account's address MUST match the account's address; connecting keeps the
  password and marks the address verified.
* **FR-019**: When a signed-out Google sign-in matches an unverified password account, the app MUST
  say that an unverified account with this address already exists and ask whether it is theirs.
  "That's me" MUST ask for the account's password and, on success, behave as FR-018.
* **FR-020**: "That's not me" MUST show a warning that whoever set the password will lose access and
  that the account may hold someone else's progress, and MUST require an explicit confirmation.
  Confirming MUST remove the password, end every existing session for the account, connect Google,
  mark the address verified, and sign the learner in.
* **FR-021**: The choice in FR-019 MUST only be reachable within 10 minutes of a completed Google
  sign-in for that exact address, and MUST NOT reveal anything about the account otherwise.
* **FR-022**: Account settings MUST warn, next to an unverified address, that until it is verified
  anyone with access to the inbox or its Google account can take the account over.
* **FR-023**: After a takeover, the app MUST tell the learner that the account may hold someone
  else's progress and point them to the actions in FR-024 and FR-025.
* **FR-024**: Account settings MUST offer "Reset account", which removes progress, enrolled decks,
  schedule changes, and preferences, and keeps the address, its verified state, and the sign-in
  methods.
* **FR-025**: "Delete all progress" and "Reset account" MUST each require the learner to type the
  account's email address as a challenge phrase, matching exactly, before running, and MUST offer a
  backup download first.

### Key Entities

* **Account address**: the email address on an account, with a verified flag that starts false for
  password sign-ups and true for Google sign-ups.
* **Reset link**: a single-use, expiring token tied to one account, delivered only by email.
* **Verification link**: an expiring token tied to one address, delivered only by email.
* **Pending Google sign-in**: a short-lived record that a Google sign-in for an address completed
  and matched an unverified password account. It is what authorizes the FR-019 choice and expires
  quickly.

## Success Criteria _(mandatory)_

### Measurable Outcomes

* **SC-001**: A learner who has forgotten their password can regain access, from opening the sign-in
  form to signing in with a new password, in under 3 minutes, provided the email arrives promptly.
* **SC-002**: 95% of reset and verification emails reach the inbox (not spam) of major webmail
  providers within 1 minute of the request.
* **SC-003**: For an address with an account and one without, a reset request produces identical
  wording, and response times that cannot be told apart.
* **SC-004**: An existing password learner can go from unverified to signing in with Google on the
  same account in under 5 minutes, with all profile progress intact.
* **SC-005**: No existing learner is prevented from signing in by this change.
* **SC-006**: Rapid repeated requests for one address result in at most 3 emails per hour beyond the
  one sent at sign-up, keeping total sending within the provider's free daily allowance under normal
  use.

## Assumptions

* The email provider, sender domain verification, and API credentials are already in place (domain
  verified 2026-10-06). The server receives the credential through its environment like its other
  secrets.
* Expiry defaults (one hour for reset, 24 hours for verification) follow the authentication
  library's conventions and need no product input.
* Email bodies are plain, short, and in English, matching the rest of the app. Branded HTML
  templates are out of scope.
* No backfill: existing password accounts stay unverified until their owner verifies or resets.
  Google-only accounts are already verified.
* Changing the email address on an account is out of scope; there is no such feature today.
* Requiring verification before sign-in is out of scope (see Context). A follow-up may add it once
  existing accounts have had time to verify.
* Issue step 4 (addresses held by someone else) is resolved by password reset and by the Google
  takeover in FR-019 and FR-020. No operator or admin path is needed.
* Disconnecting Google, or removing a password from an account that has both, is out of scope.
* Delivery is phased (see Clarifications). Phase 1 covers User Stories 1 to 3 with FR-001 to FR-017,
  FR-022, and FR-026; in phase 1 the FR-022 warning names only the inbox, since the Google takeover
  it also describes arrives in phase 2 (T025). Phase 2 covers User Stories 4 and 5 with FR-018 to
  FR-021 and FR-023 to FR-025, plus the choice screen in FR-014. Between the two, a signed-out
  Google sign-in onto an unverified password account stays refused, with a message pointing to
  signing in and verifying, or to resetting the password.
* Replies to `no-reply@` are not handled by this feature; inbound mail routing for a support address
  is a separate operator task.
* The same work for qzr-sheet (TommyAmberson/qzr-sheet#93) gets its own spec in that repository.
