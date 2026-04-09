# Luc1ferxx Archive

Luc1ferxx Archive is a minimal multi-document RAG workspace built with React and Node.js. It lets you upload multiple PDFs, ask questions against those documents, compare the response with live web search results, and inspect cited pages in a built-in PDF preview panel.

## Features

- Multi-document PDF upload
- RAG answers generated from uploaded documents
- MCP-powered web search answers generated from Google search results
- Source citations with file name, page number, and excerpt
- Inline PDF preview for cited sources
- Lightweight Apple-inspired UI

## Stack

- Frontend: React, Ant Design, Axios
- Backend: Node.js, Express, Multer
- RAG: LangChain, OpenAI embeddings, in-memory vector store
- Web search: MCP server + SerpAPI

## Project Structure

```text
.
|-- public/                # Static frontend assets
|-- src/                   # React frontend
|-- server/
|   |-- chat.js            # RAG ingestion and retrieval
|   |-- chat-mcp.js        # MCP client + web answer generation
|   |-- mcp-server.js      # Local MCP server exposing search_web
|   |-- server.js          # Express API
|   `-- uploads/           # Runtime PDF uploads, ignored by git
|-- package.json           # Frontend scripts
`-- README.md
```

## Environment Variables

Create `server/.env` from `server/.env.example`.

```env
OPENAI_API_KEY=your_openai_api_key
SERPAPI_KEY=your_serpapi_key
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_CHAT_MODEL=gpt-5
```

Notes:

- `OPENAI_API_KEY` is required for document embeddings and answer generation.
- `SERPAPI_KEY` is required for the web-search answer path.
- `server/.env` is ignored by git and should never be committed.

## Installation

Install frontend dependencies:

```powershell
cmd /c npm.cmd install
```

Install backend dependencies:

```powershell
cd server
cmd /c npm.cmd install
cd ..
```

## Running the Project

Start frontend and backend together from the repository root:

```powershell
cmd /c npm.cmd run dev
```

Open:

```text
http://localhost:3000
```

Default local services:

- Frontend: `http://localhost:3000`
- Backend API: `http://localhost:5001`

## How It Works

1. Upload one or more PDFs from the frontend.
2. The backend stores each file under `server/uploads/`.
3. `server/chat.js` parses the PDF, splits text into chunks, creates embeddings, and stores them in an in-memory vector index.
4. When you ask a question, the backend retrieves the most relevant chunks across the selected documents and asks GPT to generate a RAG answer.
5. In parallel, `server/chat-mcp.js` calls the local MCP server, fetches Google search results through SerpAPI, and asks GPT to summarize a web answer.
6. The frontend displays both answers, the cited document sources, and a preview of the selected PDF page.

## Current Limitations

- The vector store is in memory only. Restarting the backend clears uploaded document embeddings.
- Uploaded PDFs are stored locally for development and are not persisted to cloud storage.
- There is no user authentication yet.

## Validation

Build the frontend:

```powershell
cmd /c npm.cmd run build
```

Start the backend directly if needed:

```powershell
cd server
cmd /c npm.cmd start
```

## API Overview

### `POST /upload`

Uploads a PDF and ingests it into the RAG pipeline.

### `GET /chat`

Accepts:

- `question`
- `docId` or `docIds`

Returns:

- `ragAnswer`
- `ragSources`
- `mcpAnswer`

## Security

- Do not commit `server/.env`.
- Do not commit real uploaded documents from `server/uploads/`.
- Use `server/.env.example` as the public configuration template.
