# matacs-th-2026-02

- **Full name:** [FILL IN YOUR FULL NAME]
- **Reference:** MATACS-TH-2026-02
- **Time actually spent:** [FILL IN, e.g. about 1 hour 15 minutes]

## Files
- [WRITEUP.md](WRITEUP.md): answers to the five questions
- [diagram/process-flow.png](diagram/process-flow.png): process flow from upload to ranked output
- [PROMPTS.md](PROMPTS.md): the AI prompts, exactly as sent
- [ranking.json](ranking.json): expected ranking of proposals A to E
- [prototype/](prototype/): optional script (`triage.js`), `criteria.json`, extracted facts for A to E, sample audit log in `prototype/output/`
- [.env.example](.env.example): placeholder for the API key used in live mode

## Run the prototype
```
node prototype/triage.js            # offline (Node 18+, no install needed), scores the extracted facts, rewrites ranking.json
node prototype/triage.js --live     # reads prototype/proposals/<LETTER>.txt and calls the AI (needs a key)
```
The sample proposal text is not in this repository. Offline mode uses structured facts only. Live mode has not been run against a real API key.

## How I used AI tools
I used Claude to help draft the design, the prototype and the files. [FILL IN: at least one place where you disagreed with or corrected the AI's output, and why. Write this yourself so it is true.]
