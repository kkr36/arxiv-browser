# Paper Browser website

This folder is a standalone static site for the Paper Browser Chrome extension.

Pages:

- `index.html`: project homepage with GitHub and Chrome Web Store links.
- `api-keys.html`: setup guide for adding an OpenAlex / Semantic Scholar API key to the extension (the extension's missing-key warning banner links here).
- `usage.html`: usage guide — inline citations, exploration graph, exports, reading controls.
- `privacy.html`: Chrome Web Store privacy policy and Limited Use disclosure.

Screenshots live in `assets/screenshots/` (captured against the real app and a Chromium instance with the built extension loaded).

## GitHub Pages hosting

To host this through `paperbrowsercontact-design`, create a repository named:

```text
paperbrowsercontact-design.github.io
```

Then push the contents of this `website/` folder to that repository's `main` branch. GitHub user pages are served from the repository root.

Expected URLs:

- `https://paperbrowsercontact-design.github.io/`
- `https://paperbrowsercontact-design.github.io/privacy.html`

Use the second URL in the Chrome Web Store Developer Dashboard privacy policy field.
