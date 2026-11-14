# PDF/MIRA graph viewer

Read a research PDF beside a generated map of its questions, claims, and evidence. Scroll the paper to see the relevant part of the argument, or select a card to find its passage in the PDF. The reader keeps the authors’ words distinct from the AI-generated interpretation and marks estimated locations and inferred links.

## Run locally

Use Node.js 24, pnpm 11, and Git.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open [localhost:5178](http://localhost:5178/) and choose an example from the Library. The examples work without an API key. To import a new arXiv paper, supply `OPENROUTER_API_KEY` in the server environment before starting the app, then use **Add paper**. Generation sends the paper’s Markdown to OpenRouter and may incur charges.

Imported PDFs open directly from arXiv. The server keeps the text in a private cache for retries.

Run this prototype on your own computer or a trusted private network. The server starts locally by default and has no accounts.

- [User help](public/help.html), also available under **Help** in the app
- [Development guide](docs/development.md)
- [Sample credits](samples/README.md)
- [Ideas](docs/ideas.md)

## Local mock providers

Use `pnpm dev:mock` for bundled PDFs and deterministic mock AI results without provider credentials. See [local mock development](docs/mock-development.md) for setup and validation.

Set `PDF_MIRA_CONTACT_EMAIL` in the server environment to enable **Feedback** and, on deployments with private access, **Request access**.

## License

The project code is available under the [MIT License](LICENSE). The bundled research papers in `samples/` are not part of that grant; the [sample credits](samples/README.md) give each one's license.

The map generator depends on [MIRA-extraction](https://github.com/MIRA-science/MIRA-extraction), which has not published a license. It is installed from its repository and is not part of this project's code or license. Check with its authors before redistributing a package or image that bundles it.
