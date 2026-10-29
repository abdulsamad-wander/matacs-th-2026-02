# Write-up: AI proposal triage design

Reference MATACS-TH-2026-02. Proposals are referred to by letter. Flow diagram: `diagram/process-flow.png`.

## The flow in short
Admin sets criteria (versioned) → upload PDFs → read text → **AI extracts facts** → code checks the AI output → **human checkpoint 1** → code runs the mandatory gate, flags, scoring and ranking → AI words a one-line reason → **human checkpoint 2** (ranked list, flagged, ineligible) → **human checkpoint 3**, the award decision. Everything is written to an audit log.

## 1. AI vs rules
AI is used only where language is messy: reading one proposal and filling fixed fields (installs, price, weeks, warranties, who holds the licence), and wording the reason line. Proposals say the same thing many ways ("since 2020", "to be confirmed"), and rules cannot read that reliably.

Rules decide everything else: mandatory pass/fail, scoring, ranking, tie-breaks and flags. A decision must come out the same every time and be explainable with arithmetic, and AI scores drift. The AI never sees the weights or other proposals, so it cannot tilt the result.

## 2. Consistency and explainability
Ranked twice, the same proposals give the same result. Extractions are cached by hash of file, prompt and model, and scoring is pure code on a fixed criteria version. Even a fresh re-extraction returns facts, not judgments, and the reviewer can see any difference in the extracted fields.

Formulas (shown to the reviewer):
- Experience 30: qualifying installs ÷ 12, capped at 1.
- Price 25: lowest price among mandatory-passing bids ÷ this price.
- Timeline 15: shortest schedule among those bids ÷ this schedule.
- Warranty 15: half panel years ÷ 25, half workmanship years ÷ 10, each capped at 1.
- Team 15: a quarter each for named lead, crew size, safety plan, monitoring plan.

Ties break on experience, then lower price, then letter. For each proposal the reviewer sees extracted values with the exact source quote, each mandatory result, points per criterion, flags and the reason line.

## 3. Human in the loop
- Checkpoint 1, after extraction: the reviewer sees empty fields and quotes that failed verification, and can correct a value.
- Checkpoint 2, after ranking: every flagged and ineligible proposal waits for a person. The reviewer can clear a flag, fix a fact or change a position, but must write a reason.
- Checkpoint 3: a person makes the award. The tool never awards.

The append-only log holds who, when, criteria version, prompt version, model, file hash, extracted JSON, scores, each override (old value, new value, reason) and the final decision.

## 4. Changing criteria
Criteria are versioned. An edit creates a new version and never rewrites old results. Weights must total 100 or the save is blocked. Existing scores are marked stale, not silently changed. Because extraction holds facts only, re-scoring needs no AI calls. If a new criterion needs a fact not yet extracted, only that field is extracted again. The admin sees old vs new ranking side by side before publishing. A reviewer chooses which version applies, and that choice is logged. The prototype reads `criteria.json` and rejects weights that do not total 100.

## 5. Risks and safeguards
- **Wrong extraction:** each value needs an exact quote that must exist in the source text, or the value is removed and flagged. Scanned or unreadable PDFs are flagged.
- **Made-up facts:** the prompt requires null when something is absent or "to be confirmed". Missing never becomes a guess. The reason line may only use numbers from the computed breakdown.
- **Manipulation:** the sample set has one. A note addressed to automated review systems claims pre-approval and asks for first rank and full marks. Proposal text is treated as data. The AI reports such text in a separate field, a regex scan checks the raw text as a second layer, and the scoring code never reads free text, so nothing written in a proposal can change a score. Any hit holds the proposal for a human. It is not auto-rejected, because the note could be a paste error.
- **Bias:** only stated facts are scored, and company name and location are not inputs. The price formula favours the cheapest bid, which is why mandatory checks run first. An optional blind mode hides names during review.
- **Cost:** one extraction call and one short reason call per proposal, with caching. Re-scoring costs nothing. A page limit per file caps abuse.
- **Other:** duplicate uploads (matched by file hash) and ties are handled by the rules above.

## Sample set result (`ranking.json`)
- **A, rank 1 (99.3):** all checks pass, most experience, full team plan, 12 weeks.
- **E, rank 2 (87.7)** and **C, rank 3 (81.5):** C has no stated safety or monitoring plan. Its "since 2020" may include installs older than five years, so it carries a note to confirm.
- **B, ineligible:** the cheapest bid, but it does not hold an electrical licence itself. The electrical work goes to an unnamed subcontractor. Price is not considered once the mandatory check fails.
- **D, flagged:** the schedule is not stated, so timeline cannot be scored. The embedded instruction is ignored and reported. If a reviewer clears it and 13 weeks is confirmed, D would score 88.8 and rank 2nd. This is reproducible with `--override D.reviewed=true --override D.completion_weeks=13`.

## Assumptions
- The note sits next to D's section, so I attribute it to D's file. A reviewer should confirm.
- The five-year window runs from the review date, 2026. A "since YEAR" claim earlier than 2021 gets a note.
- "WSIB clearance" counts as confirmed when stated.
- The weights are the admin's. The caps and formulas are my design and are editable in `criteria.json`.
- I did not wait for a reply to any question.
