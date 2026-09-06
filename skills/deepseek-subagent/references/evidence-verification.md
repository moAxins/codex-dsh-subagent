# Evidence verification

Evidence-required jobs exist so DeepSeek cannot claim completion without written, verifiable records. Codex verifies the evidence file before treating the job as done.

## Where evidence lives

Each job exposes an artifacts directory under the controller's job storage and an exact evidence file path:

```text
<job dir>/artifacts/evidence.json
```

`spawn` returns both `artifactsPath` and `evidencePath`. Evidence artifacts live outside the delegated worktree, so they never appear in the repository diff. The worker grants the delegated session write permission only to that exact file — never the artifacts directory and never any other outside path.

## Evidence requirements in the packet

```json
{
  "evidenceRequirements": { "required": true, "kinds": ["fact", "citation", "image"] }
}
```

`required: true` forces ACP mode; headless spawn of an evidence-required job is rejected. `kinds` selects which record kinds DeepSeek should produce.

## Schema version 1

The evidence file is JSON with a top-level `version` and an `items` array:

```json
{
  "version": 1,
  "items": []
}
```

Every item requires:

| Field | Rule |
| --- | --- |
| `id` | non-empty string, unique within the file |
| `kind` | `fact`, `citation`, or `image` |
| `selected` | boolean |
| `useLocations` | array of strings; a selected item needs at least one |
| `claim` | non-empty string |
| `sourceUrl` | absolute http(s) URL |
| `publisher` | non-empty string |
| `publishedAt` | non-empty string or `null` |
| `verificationNotes` | non-empty string |
| `uncertainties` | array of strings |

Image items additionally require an absolute http(s) `imageUrl` and a `caption` that is a non-empty string or `null`.

## Status

`result` reports `evidenceStatus` and the parsed `evidence`:

- `not_required` — the packet did not require evidence.
- `missing` — required, but `evidence.json` does not exist.
- `invalid` — required, present, but not valid schema v1; `evidence.errors` lists each problem.
- `ready` — required, present, valid, and contains every kind named by `evidenceRequirements.kinds`; `evidence.items` contains the parsed records.

## Codex verification steps

1. Read `evidence.items`, confirm every requested kind is present, and map every selected item to a concrete use location in the delegated diff.
2. For each selected fact, open `sourceUrl` and confirm the claim, publisher, and publication date from the source.
3. For each selected citation, inspect its source and context, then confirm that the stated conclusion follows from it.
4. For each selected image, open both the original page in `sourceUrl` and the asset in `imageUrl`, then confirm the image, caption, publisher, date, and intended use.
5. Re-run the checks DeepSeek listed and test the acceptance criteria yourself.
6. Missing, invalid, or unconfirmed evidence triggers a correction and another verification pass.
