# Essays

A minimal, mobile-first static blog for publishing long-form essays as paginated markdown. Deployed via GitHub Pages at [edgewood1.github.io/essays](https://edgewood1.github.io/essays) and Netlify at [essays77.netlify.app](https://essays77.netlify.app).

---

## How it works

Essays are written as markdown files in the `essays/` folder. The app reads each file, extracts the title from the `# H1` heading, and lists it in the hamburger menu. Clicking an essay opens it as a paginated reader — each `##` section heading becomes its own page. Swipe left/right on mobile, or use arrow keys on desktop, to move between pages.

The app is a single HTML/CSS/JS file with no build step. Pushing to `main` triggers a GitHub Actions workflow that deploys to GitHub Pages automatically.

---

## Folder structure

```
essays/
├── index.html          # App shell
├── style.css           # All styles
├── app.js              # App logic (Store, API, Parser, Router, UI)
├── images/             # Image assets referenced by essays
├── essays/
│   ├── index.json      # Manifest — list of essay filenames to display
│   └── *.md            # Essay files
└── .github/
    └── workflows/
        └── deploy.yml  # GitHub Pages deployment
```

---

## Adding an essay

1. Write the essay as a markdown file and save it in `essays/`.
2. Add the filename to `essays/index.json`:
   ```json
   ["first-essay.md", "second-essay.md"]
   ```
3. Commit and push. The site updates automatically.

### Essay structure

```markdown
# Essay Title

Optional intro paragraphs — these appear as the first page with no section label.

## First Section

Body text...

## Second Section

Body text...
```

- `#` — essay title (one per file)
- `##` — section/page break; the heading becomes the page label
- `###` — subsection within a page (rendered as italic heading, no page break)

---

## Adding images

Images live in the `images/` folder at the repo root. Reference them in markdown using a path relative to the site root: `images/filename.jpg`.

### Inline image

An image placed within a section alongside text renders inline:

```markdown
## Tobacco

Some paragraph text here.

![The Bull Durham warehouse, circa 1880](images/bull-durham.jpg)

Text continues after the image.
```

### Full-page image

A `##` section whose entire body is a single image renders as a full-bleed image page — no prose, image fills the screen. The section title becomes the page label.

```markdown
## The Strayhorn Branch, looking north

![The Strayhorn Branch, looking north](images/strayhorn-creek.jpg)
```

### Image placeholder

If the image file doesn't exist yet, a labeled empty box renders in its place. This lets you mark where an image will go before you have the file — the layout is visible while you're still sourcing the photo. Just use the standard syntax with whatever filename you plan to use:

```markdown
![Description of the image that will go here](images/future-photo.jpg)
```

Drop the actual file in `images/` when ready, commit, and push.

### Adding an image

1. Copy the image file into `images/`.
2. Reference it in the essay markdown (see above).
3. Commit and push:
   ```
   git add images/ essays/
   git commit -m "Add image: description"
   git push
   ```

---

## Local development

No build step required. Serve the root directory with any static file server:

```bash
npx serve .
# or
python3 -m http.server
```

Then open `http://localhost:3000` (or whichever port is used).

> Note: opening `index.html` directly as a `file://` URL will not work because the app fetches `essays/index.json` and markdown files via `fetch()`, which browsers block on `file://` origins.
