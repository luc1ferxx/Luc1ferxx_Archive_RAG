# AGENTS.md

## Project Shape

- Root app: React 18 / Create React App frontend in `src/`.
- Backend: Node ESM Express API in `server/`, with custom RAG logic in `server/rag/`.
- Runtime/generated paths to avoid editing unless requested: `node_modules/`, `build/`, `server/node_modules/`, `server/data/`, `server/uploads/`, `server/upload-sessions/`, `server/evaluation/generated/`, and timestamped files under `server/evaluation/results/`.

## Setup

- Install frontend deps from the repo root: `npm install`.
- Install backend deps separately: `cd server && npm install`.
- Copy `.env.example` for frontend settings and `server/.env.example` to `server/.env` for backend settings.
- Required backend keys for full RAG/web behavior: `OPENAI_API_KEY` and `SERPAPI_KEY`.

## Development Commands

- Run frontend and backend together from the repo root: `npm run dev`.
- Run only the frontend: `npm start`.
- Run only the backend: `npm run server` from the root, or `cd server && npm run start`.
- Default ports are frontend `3000` and backend `5001`; the backend also honors `PORT`.
- Build the frontend: `npm run build`.

## Tests And Evaluation

- Backend test runner: `cd server && npm test`.
- Frontend test runner: `npm test` from the repo root. Use CRA's non-watch mode in automation, e.g. `CI=true npm test -- --watchAll=false`.
- Default synthetic RAG eval: `cd server && npm run eval:synthetic`.
- Current tracked `latest.*` synthetic report uses the near-duplicate corpus: `cd server && npm run eval:synthetic -- evaluation/synthetic-corpus-near-duplicate.json`.
- Run a specific synthetic corpus: `cd server && npm run eval:synthetic -- evaluation/synthetic-corpus-compare-hard.json`.
- Chunking comparison corpus: `cd server && RAG_CHUNK_STRATEGY=structured RAG_CHUNK_OVERLAP=180 npm run eval:synthetic -- evaluation/synthetic-corpus-chunking.json`.
- Feedback corpus generation: `cd server && npm run feedback:corpus`.
- Feedback regression eval: `cd server && npm run eval:feedback`; this writes ignored `evaluation/generated/feedback-corpus.json` and `evaluation/results/latest-feedback.*`.
- Real-corpus eval expects a local corpus file created from `evaluation/real-corpus.example.json` or passed explicitly: `cd server && npm run eval:real -- evaluation/real-corpus.json`.
- Ragas eval runs against saved Node eval payloads: `cd server && npm run eval:ragas -- --input evaluation/results/latest.json`. It requires optional dependencies plus `OPENAI_API_KEY`; see `server/evaluation/ragas-requirements.txt`.

Backend `npm test` imports `app.test.mjs`, `rag.test.mjs`, `answer-match.test.mjs`, `feedback-corpus.test.mjs`, and `agent-skills.test.mjs`.

## Implementation Notes

- Keep RAG changes inside `server/rag/` where possible; route/API behavior lives in `server/app.js`.
- AgentRAG skills are registered in `server/rag/skills/registry.js`; new skills need stable `id/version/label`, deterministic `match()`, and an `execute()` path that receives `accessScope` when reading user/workspace data.
- API auth is controlled by `API_AUTH_ENABLED` plus either `API_AUTH_TOKEN` for single-token local use or `API_AUTH_TOKENS` for per-user/per-workspace token mapping; the frontend can send `REACT_APP_API_AUTH_TOKEN`, which becomes an `x-api-key` header.
- When auth is enabled, document list/chat/delete/file access is filtered by the authenticated token's `userId` and `workspaceId`; keep new document routes scoped the same way.
- `VECTOR_STORE_PROVIDER=local` is the default documented path; `qdrant` is supported via the Qdrant env vars in `server/.env.example`.
- Startup health checks report OpenAI, auth, vector store, PostgreSQL document/session stores, and long memory. `STARTUP_HEALTH_STRICT=false` allows the server to start while reporting health errors.
- For RAG debugging, `RAG_OBSERVABILITY_ENABLED=true` writes JSONL traces under `server/data/rag-observability/`; set `RAG_OBSERVABILITY_INCLUDE_CONTEXT=true` only for local debugging when full chunk text is acceptable.
