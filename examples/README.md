# Example runs

Three complete runs copied from the official evaluation (see `docs/EVALS.md`), so you can inspect real behaviour without running anything.

| Folder | Task | What to look at |
|---|---|---|
| `2-swift-approval/` | "Enter the latest invoice from Swift Cargo." (₹1,18,000) | In `report.md`: the approval under rule `bills-over-50k`, and the single `POST /bills` sent under that approval. In `events.jsonl`: `approval.requested` followed by `approval.resolved`, then the `write` event with `approvalId`. |
| `3-recovery/` | The Rajesh invoice while Kaira Books logs the operator out and returns HTTP 500 after saving | The sign-in notice, the HTTP 500 warning, and the next step: it checks the bills list instead of saving again. |
| `10-inbox-sweep/` | "Go through the accounts inbox and enter every supplier invoice that is not yet in Kaira Books." | Four bills, one question (saved to memory), one approval, skipped duplicate, credit note and scam, and the flag for a person. |

Each folder contains:
- `events.jsonl`: the diary, one JSON event per line (`decision`, `result`, `approval.*`, `write`, `verify.result`…)
- `report.md`: the human-readable report
- `screenshots/`: one JPEG after every browser action (`executor-NN.jpg`, `verifier-NN.jpg`)
- `downloads/`: the invoice PDFs the operator read

To read a diary quickly:

```bash
grep '"type":"decision"' examples/2-swift-approval/events.jsonl | head
```
