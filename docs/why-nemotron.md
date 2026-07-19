# Why Nemotron is the right model for Horatio

Horatio’s value isn’t a single clever prompt — it’s **ambient memory**: every Blender MCP session is recorded, distilled, and served back so the next agent warm-starts. That only works if distillation is cheap enough to run continuously and trustworthy enough to inject into future agents. Nemotron sits at the center of both constraints.

## 1. The workload is continuous, not episodic

Most “AI for Blender” demos call a frontier model once at the end of a chat. We call a model **throughout the session** (activity digests: every ~10 tool pairs or ~90s of idle) and again when memory is updated (session end / idle / manual Update memory). That pattern is absurd on frontier API pricing and trivial on a fast, cheap open model. Nemotron makes “always-on distillation” an engineering choice instead of a cost crisis. Without that economics, the product collapses to optional post-hoc notes — and agents keep cold-starting.

## 2. The job fits Nemotron’s strengths, not chat-assistant theater

Our prompts are extraction contracts, not open-ended creativity: structured events with source `seq` citations, verbatim errors, no invented causality, fixed markdown sections. We disable thinking (`/no_think` + `enable_thinking: false`), demand `json_object`, and validate with Zod. We need **high-fidelity compression of technical traffic**, not witty prose. A strong open MoE that follows schema and stays grounded is a better fit than a flashier generalist that hallucinates narrative between tool calls — because bad memory poisons every future session.

## 3. Centrality, not decoration

Remove Nemotron and Horatio is still a transparent logger. The *product* — digests that are synthesis-sufficient, session notes, durable `memory.md`, warm `recall()` — is Nemotron’s output. The tap is deliberately dumb; intelligence lives only in the distiller. That’s the bounty spine: Nemotron isn’t a feature bolted on; it’s the reason ambient memory exists.

## 4. Context headroom matches the architecture experiment

Nemotron’s **1M-class context** (Mamba-2 hybrid) lets us argue two complementary designs: day-to-day activity→update on digests (fast, cheap, teardown-safe), and a one-shot full-`raw.jsonl` synthesis experiment that only a long-context model makes credible. Digests are an engineering decision for latency and races; 1M context is the evidence that we *could* go bigger when we want to validate the digest contract.

## 5. Open weights close the product loop

Hosted Super for quality memory updates; stretch path of **local Nemotron Nano (Ollama)** for always-on activity — private, zero token cost, same prompts. Closed frontier APIs can’t tell that story. For a designer-engineer driving Blender with Claude, “my session memory never leaves my machine” is a real differentiator, not a footnote.

## 6. Operational fit

Free-tier limits (~40 rpm) align with our single-queue, no-fan-out design (~1 call/min worst case for activity digests). We don’t need parallel agent swarms; we need steady, boring, reliable extraction. Nemotron + that discipline is enough.

---

**One-liner for judges**

*Frontier models are for decisions; Nemotron is for memory. Horatio needs memory that runs all session long — so Nemotron isn’t the best model we could afford; it’s the only class of model that makes the product make sense.*
