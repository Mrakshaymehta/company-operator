# From this prototype to an AI employee product

**What an AI employee is:** a company memory plus an operator that acts on it, governed by the company's own rules and checked independently. Every task reads from the memory, and every task can write back what it learned. Supervision should fall over time, as answers become facts and successful runs become procedures.

**Why this shape:**
- **Company context is the moat.** Models and browsers are commodities. A model knows how to click. What it does not know is that "Rajesh" means S-1001, that his invoices omit due dates, or that anything above ₹50,000 goes to Nisha. Memory with provenance and validity dates is what makes the same model useful inside a specific company, and what makes it trustworthy enough to act.
- **Reliability is the product.** Customers buy outcomes they do not have to check. That needs independent verification, safe retries, durable runs that survive crashes, and an audit trail a manager can read in a minute.
- **Governance must be structural.** Approvals, deny rules, credential isolation and egress limits belong in the runtime, enforced on actions, and configured per company as data. Prompts are advisory.

**How it grows:**
1. **Reach:** browser today; desktop apps through computer use; APIs through connectors. All go behind the same policy gate and audit.
2. **Learning:** answers become facts (built); learned facts are confirmed by people (built); successful runs are distilled into procedure suggestions and replayed as fast paths with the model as fallback (next).
3. **Operations:** durable workflows, queues and schedules ("every Monday"); approvals routed by role with escalation; per-tenant isolation of memory, policies, vaults and browsers.
4. **Quality:** every procedure has graded scenarios. Changes to prompts, models or policies run the suite and are gated on pass rate, cost and latency.

**What I would do in the first weeks at CentrAlign:** pick one painful, frequent workflow at a design partner and encode it the way this prototype does, with memory, procedure, policy and graded scenarios. Run it shadowed by a person, measure the pass rate and the interventions, and turn every intervention into memory or a procedure fix until supervision is the exception.
