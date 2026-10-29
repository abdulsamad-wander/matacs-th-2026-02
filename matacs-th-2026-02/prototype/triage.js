#!/usr/bin/env node
/**
 * AI proposal triage prototype (design exercise, not production code). Node 18+, no dependencies.
 *
 * Offline (default): scores the structured extractions in prototype/extracted/.
 * Live (--live): reads proposal text from prototype/proposals/<LETTER>.txt (git-ignored), runs the
 * extraction prompt from PROMPTS.md, verifies quotes, then scores. Needs ANTHROPIC_API_KEY.
 *
 * Scoring, gating and ranking are plain code. AI only extracts facts (and optionally words the reason).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HERE = __dirname;
const ROOT = path.resolve(HERE, "..");

// ---------- helpers ----------
const stable = (x) =>
  Array.isArray(x) ? "[" + x.map(stable).join(",") + "]"
  : x && typeof x === "object" ? "{" + Object.keys(x).sort().map((k) => JSON.stringify(k) + ":" + stable(x[k])).join(",") + "}"
  : JSON.stringify(x);
const sha = (x) => crypto.createHash("sha256").update(typeof x === "string" ? x : stable(x)).digest("hex").slice(0, 12);
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

function loadPrompts() {
  const text = fs.readFileSync(path.join(ROOT, "PROMPTS.md"), "utf8");
  const out = {};
  for (const m of text.matchAll(/```text (\S+)\n([\s\S]*?)```/g)) out[m[1]] = m[2].trim();
  return out;
}

const INJECTION_PATTERNS = [
  /pre-?approved/gi, /rank (it|this)[^.]{0,30}first/gi, /full marks/gi, /ignore (all |any |previous )/gi,
  /note to (automated|ai)/gi, /automated review/gi, /system prompt/gi, /assign[^.]{0,40}(marks|score)/gi,
];
const scanInjection = (text) => INJECTION_PATTERNS.flatMap((p) => [...text.matchAll(p)].map((m) => m[0]));

// ---------- config ----------
function loadCriteria(file) {
  const c = readJson(file);
  const total = c.weighted.reduce((s, w) => s + w.weight, 0);
  if (total !== 100) {
    console.error(`Criteria rejected: weights add up to ${total}, must be 100.`);
    process.exit(1);
  }
  return c;
}

// ---------- extraction (live mode) ----------
async function liveExtract(text, prompts, crit) {
  const model = process.env.MODEL || "claude-sonnet-5-5";
  const year = crit.project.as_of.slice(0, 4);
  const user = prompts["extraction-user"].replace("{current_year}", year).replace("{proposal_text}", text);
  const cacheFile = path.join(HERE, "cache", sha(user + prompts["extraction-system"] + model) + ".json");
  if (fs.existsSync(cacheFile)) return readJson(cacheFile);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 2000, system: prompts["extraction-system"], messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const raw = (await res.json()).content[0].text.trim();
  const x = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(x, null, 2));
  return x;
}

/** Rule-based guards on AI output: quotes must exist in the source, injection scan on raw text. */
function verifyAndScan(x, text) {
  const flags = [];
  for (const [field, quote] of Object.entries(x.evidence || {})) {
    if (!norm(text).includes(norm(quote))) {
      x[field] = null;
      flags.push(`unverified quote for ${field}: value removed`);
    }
  }
  const hits = scanInjection(text);
  if (hits.length && !(x.instructions_to_reviewer || []).length) x.instructions_to_reviewer = hits;
  return flags;
}

// ---------- rules ----------
function mandatoryGate(x, crit) {
  const fails = [];
  const m = crit.mandatory.find((c) => c.id === "wsib_insurance");
  if (!(x.licence_number && x.licence_held_by_bidder)) fails.push("Ontario electrical contractor licence not held and stated by the bidder");
  if (!x.wsib_clearance) fails.push("WSIB clearance not confirmed");
  if ((x.liability_insurance_cad || 0) < m.min_liability_cad) fails.push("$5M liability insurance not confirmed");
  return fails;
}

function reviewFlags(x, crit) {
  const p = crit.project, flags = [];
  if ((x.instructions_to_reviewer || []).length) flags.push("contains text aimed at automated reviewers (ignored, needs human review)");
  for (const [field, label] of [["price_cad", "price"], ["completion_weeks", "schedule"], ["qualifying_installs_count", "experience count"]]) {
    if (x[field] == null) flags.push(`${label} not stated, cannot be scored`);
  }
  if (x.price_cad && x.price_cad > p.budget_ceiling_cad) flags.push("price above budget ceiling");
  if (x.completion_weeks && x.completion_weeks > p.max_weeks) flags.push("schedule longer than allowed");
  return flags;
}

function notesFor(x, crit) {
  const windowStart = Number(crit.project.as_of.slice(0, 4)) - crit.project.experience_window_years;
  return x.installs_since_year && x.installs_since_year < windowStart
    ? ["install count may include work older than the 5-year window, confirm"] : [];
}

/** 0..1 for one weighted criterion. pool = mandatory-passing proposals (for relative rules). */
function fraction(x, pool, w) {
  switch (w.rule) {
    case "count_cap":
      return Math.min((x.qualifying_installs_count || 0) / w.cap, 1);
    case "lowest_over_price": {
      const prices = pool.map((e) => e.price_cad).filter(Boolean);
      return x.price_cad && prices.length ? Math.min(...prices) / x.price_cad : null;
    }
    case "shortest_over_weeks": {
      const wk = pool.map((e) => e.completion_weeks).filter(Boolean);
      return x.completion_weeks && wk.length ? Math.min(...wk) / x.completion_weeks : null;
    }
    case "warranty_caps": {
      const a = Math.min((x.panel_warranty_years || 0) / w.panel_cap_years, 1);
      const b = Math.min((x.workmanship_warranty_years || 0) / w.workmanship_cap_years, 1);
      return (a + b) / 2;
    }
    case "checklist": {
      const hit = w.items.filter((i) => (i === "crew_size_stated" ? x.crew_size != null : Boolean(x[i]))).length;
      return hit / w.items.length;
    }
    default:
      throw new Error(`Unknown rule: ${w.rule}`);
  }
}

function score(x, pool, crit) {
  const pts = {};
  let sum = 0, missing = false;
  for (const w of crit.weighted) {
    const f = fraction(x, pool, w);
    pts[w.id] = f == null ? null : round(w.weight * f, 2);
    if (f == null) missing = true; else sum += w.weight * f; // total from unrounded points
  }
  return { pts, total: missing ? null : round(sum, 1) };
}

// ---------- pipeline ----------
function run(extractions, crit, overrides) {
  const audit = {
    criteria_version: crit.version, criteria_hash: sha(crit), prompt_version: "prompts-v1",
    run_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), overrides, proposals: {},
  };
  const gate = {};
  for (const [k, x] of Object.entries(extractions)) {
    for (const [f, v] of Object.entries(overrides[k] || {})) if (f !== "reviewed") x[f] = v;
    gate[k] = mandatoryGate(x, crit);
  }
  const pool = Object.entries(extractions).filter(([k]) => !gate[k].length).map(([, x]) => x);

  const results = Object.keys(extractions).sort().map((k) => {
    const x = extractions[k];
    const reviewed = Boolean((overrides[k] || {}).reviewed);
    const fails = gate[k];
    let flags = reviewFlags(x, crit);
    if (reviewed) flags = flags.filter((f) => !f.includes("automated reviewers"));
    const notes = notesFor(x, crit);
    const entry = { proposal: k, mandatory_failures: fails, flags, notes, rank: null };
    if (fails.length) {
      Object.assign(entry, { status: "ineligible", points: null, score: null,
        reason: `Fails mandatory check: ${fails.join("; ")}. Not scored.` });
    } else if (flags.length) {
      Object.assign(entry, { status: "flagged", points: null, score: null,
        reason: `Held for human review: ${flags.join("; ")}.` });
    } else {
      const { pts, total } = score(x, pool, crit);
      Object.assign(entry, { status: "ranked", points: pts, score: total,
        reason: `Passes mandatory checks; ${x.qualifying_installs_count} installs, $${x.price_cad.toLocaleString("en-US")}, ` +
          `${x.completion_weeks} weeks, warranty ${x.panel_warranty_years}/${x.workmanship_warranty_years} yrs, ` +
          `team plan ${Math.round((pts.team / 15) * 4)}/4; total ${total}` + (notes.length ? `. Note: ${notes[0]}` : "") + "." });
    }
    return entry;
  });

  // Rank: score desc, then experience points desc, then lower price, then letter
  results.filter((r) => r.status === "ranked")
    .sort((a, b) => b.score - a.score || b.points.experience - a.points.experience ||
      extractions[a.proposal].price_cad - extractions[b.proposal].price_cad || a.proposal.localeCompare(b.proposal))
    .forEach((r, i) => (r.rank = i + 1));

  const order = { ranked: 0, flagged: 1, ineligible: 2 };
  results.sort((a, b) => order[a.status] - order[b.status] || (a.rank || 99) - (b.rank || 99) || a.proposal.localeCompare(b.proposal));
  for (const r of results) audit.proposals[r.proposal] = { ...r, extraction_hash: sha(extractions[r.proposal]), extraction: extractions[r.proposal] };
  return { results, audit };
}

// ---------- cli ----------
function parseArgs(argv) {
  const a = { live: false, criteria: path.join(HERE, "criteria.json"), override: [],
    out: path.join(ROOT, "ranking.json"), audit: path.join(HERE, "output", "audit_log.json") };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--live") a.live = true;
    else if (k === "--criteria") a.criteria = argv[++i];
    else if (k === "--override") a.override.push(argv[++i]);
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--audit") a.audit = argv[++i];
    else { console.error(`Unknown option ${k}`); process.exit(1); }
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const crit = loadCriteria(a.criteria);
  const overrides = {};
  for (const o of a.override) {
    const [key, val] = [o.slice(0, o.indexOf("=")), o.slice(o.indexOf("=") + 1)];
    const [k, f] = [key.slice(0, key.indexOf(".")), key.slice(key.indexOf(".") + 1)];
    (overrides[k] = overrides[k] || {})[f] = JSON.parse(val);
  }

  const extractions = {};
  if (a.live) {
    if (!process.env.ANTHROPIC_API_KEY) { console.error("Set ANTHROPIC_API_KEY (see .env.example)."); process.exit(1); }
    const prompts = loadPrompts();
    const dir = path.join(HERE, "proposals");
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".txt")).sort()) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      const letter = path.basename(f, ".txt");
      const x = await liveExtract(text, prompts, crit);
      x.proposal = letter;
      x._verification_flags = verifyAndScan(x, text);
      extractions[letter] = x;
    }
  } else {
    const dir = path.join(HERE, "extracted");
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) extractions[path.basename(f, ".json")] = readJson(path.join(dir, f));
  }

  const { results, audit } = run(extractions, crit, overrides);
  const out = results.map((r) => ({ proposal: r.proposal, rank: r.rank, status: r.status, score: r.score, reason: r.reason }));
  fs.mkdirSync(path.dirname(a.audit), { recursive: true });
  fs.writeFileSync(a.out, JSON.stringify(out, null, 2) + "\n");
  fs.writeFileSync(a.audit, JSON.stringify(audit, null, 2) + "\n");
  for (const r of out) console.log(r.proposal, r.rank, r.status, r.score, "|", r.reason);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
