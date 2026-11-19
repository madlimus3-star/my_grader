# my_grader

A small, local **C++ online judge**: keep your own problems as PDF statements, group them into
categories such as *TOI Zero* or *Array*, write test cases, and solve them in the browser with a
real compiler and a finish check on every submission.

Everything lives in this folder. No accounts, no cloud, no npm dependencies.

```
┌──────────────┬──────────────────────────────────────────────┐
│  categories  │  statement (PDF)  /  editor  /  test cases   │
│  problem list│  verdicts per test, compile errors, history  │
└──────────────┴──────────────────────────────────────────────┘
```

## Features

- **PDF statements** — upload the original `.pdf` (or a PNG/JPEG scan) per problem; it renders
  inside the page with open/download/replace actions.
- **Categories** — free-form tags per problem (`TOI Zero`, `Array`, `String`, …) that become the
  sidebar filters, with counts.
- **Test cases** — add input/expected pairs by hand, mark any of them as *sample*, or import a
  folder of matching `.in` / `.out` files in one go. Hidden tests are graded but not revealed.
- **Editor** — CodeMirror 5 with C++ highlighting, bundled locally so it works offline. Code is
  saved per problem in `localStorage`.
- **Judge** — compiles with `g++ -std=c++17 -O2`, runs every test with the problem's time and
  memory limits, and reports `AC`, `WA`, `TLE`, `RE`, `CE` or `OLE` per test with the input,
  expected and actual output for sample tests (and hidden ones on demand).
- **Submissions** — every run is stored; click one to load its code back into the editor.
- **Progress** — solved/attempted dots in the list and counters in the sidebar.

## Requirements

| | |
| --- | --- |
| Node.js | 20 or newer (tested on 24) |
| Compiler | `g++` with C++17 (Ubuntu: `sudo apt install build-essential`) |
| Limits | `prlimit` from util-linux (preinstalled on Ubuntu) |
| Optional | `unshare` for network isolation, available on most Linux systems |

No `npm install` is needed — the server uses only the Node standard library and CodeMirror is
already vendored under `public/vendor/codemirror`.

## Run

```sh
cd my_grader
npm start          # or: node server.js
```

Open <http://127.0.0.1:3000>.

```sh
PORT=4000 node server.js     # another port
HOST=0.0.0.0 node server.js  # expose on the LAN (see Security)
```

The startup banner prints the detected compiler and which sandbox layers are active.

## Using it

1. **New problem** — title, categories, difficulty, limits, and drop the PDF. The statement is
   optional at creation and can be replaced later from the *Statement* tab.
2. **Test cases tab** — paste input/expected pairs, tick *sample* for the ones a solver may see,
   or *Import .in/.out pairs* to add many at once (`1.in` + `1.out`, `test2.in` + `test2.out`, …).
3. **Solve tab** — write C++17 and press:
   - `Run samples` (or `Ctrl`/`Cmd` + `Enter`) to try only the sample tests,
   - `Submit` (or `Ctrl`/`Cmd` + `Shift` + `Enter`) to grade every test.
4. **Submissions tab** — history for the problem; click a row to restore that code and verdicts.

The *show hidden test data* checkbox re-runs the submission and includes hidden inputs, expected
outputs and diffs in the results.

## How judging works

- Each submission compiles in a throwaway directory under the system temp dir:
  `g++ -std=c++17 -O2 -pipe -o main main.cpp`.
- Every test runs as
  `unshare -rn prlimit --as=<memory> --cpu=<limit> --nproc=64 --nofile=256 --fsize=32MB -- ./main`
  with stdin from the test file and a wall-clock timeout slightly above the time limit.
- Output is compared after normalising line endings and trailing whitespace.
- After the first `TLE`, the remaining tests are reported as `TLE` without running, so an
  infinite loop cannot stall the queue for a minute.
- Submissions are serialised: one program runs at a time.

## Data layout

```
my_grader/
├── server.js              HTTP server and API
├── lib/
│   ├── store.js           problems, test cases, submissions on disk
│   └── judge.js           compile + sandboxed runs
├── public/                UI (no build step)
│   └── vendor/codemirror/
└── data/
    ├── problems/<id>/
    │   ├── problem.json   title, tags, limits, statement metadata
    │   ├── statement.pdf  the uploaded PDF
    │   └── tests/
    │       ├── index.json order + sample flags
    │       └── 001.in, 001.out, …
    └── submissions/<id>/  one JSON file per run (git-ignored)
```

Problems, statements and test cases are meant to be committed and shared. Submissions are not
tracked (see `.gitignore`).

## API

All JSON, no authentication:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/meta` | tag counts, totals, detected tools |
| `GET`/`POST` | `/api/problems` | list / create |
| `GET`/`PATCH`/`DELETE` | `/api/problems/:id` | read / update / delete |
| `GET`/`POST`/`DELETE` | `/api/problems/:id/statement` | stream / upload (base64 JSON) / remove |
| `GET`/`POST` | `/api/problems/:id/tests` | list / add |
| `POST` | `/api/problems/:id/tests/bulk` | add many pairs |
| `GET`/`PATCH`/`DELETE` | `/api/problems/:id/tests/:tid` | read / edit or toggle sample / delete |
| `POST` | `/api/problems/:id/submit` | `{ code, mode: "sample" \| "all", reveal }` |
| `GET` | `/api/problems/:id/submissions` | history summaries |
| `GET` | `/api/submissions/:sid?problemId=:id` | one submission with code and results |

## Security

This is a **local practice tool**, not a hardened public judge.

- The server binds to `127.0.0.1` by default. Do not expose it to the internet as-is: there is no
  authentication, and anyone who can reach it can create problems and run code.
- Submitted programs run with memory/CPU/file limits, a wall-clock timeout and (when available)
  a new network namespace via `unshare -rn`. That stops runaway loops and accidental network use,
  but it is not a container or a VM. Only run code you are willing to execute on your machine.
- For an untrusted audience, put the judge inside Docker/a VM and add an auth layer.

## Licence

MIT
