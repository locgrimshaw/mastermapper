# Getting this onto GitHub (step by step)

You don't need to be a Git expert. Follow these in order. Commands go in a
terminal (Mac: Terminal app; Windows: Git Bash, install from git-scm.com).

## One-time setup

1. **Install Git** if you don't have it: https://git-scm.com/downloads
2. **Make a GitHub account** at https://github.com (free).
3. **Tell Git who you are** (once):

   ```bash
   git config --global user.name "Your Name"
   git config --global user.email "you@example.com"
   ```

## Put this project on GitHub

1. On GitHub, click **New repository** (the + top-right).
   - Name it e.g. `welfare-mapper`
   - Keep it **Private** for now (you can open it later)
   - Do **not** tick "add a README" (we already have one)
   - Click **Create repository**

2. GitHub shows you a URL like
   `https://github.com/yourname/welfare-mapper.git`. Copy it.

3. In your terminal, from inside the `welfare-mapper` folder:

   ```bash
   git init
   git add .
   git commit -m "Initial prototype: map, scoring engine, plot report"
   git branch -M main
   git remote add origin https://github.com/yourname/welfare-mapper.git
   git push -u origin main
   ```

   (It may ask you to log in to GitHub the first time.)

Your code is now on GitHub. From now on, to save changes:

```bash
git add .
git commit -m "describe what you changed"
git push
```

## Publish the live map for free (GitHub Pages)

GitHub Pages serves static sites for free. The catch: it serves from the repo
root or `/docs`, and our app is in `/web`. Two clean options:

**Option A — quickest.** Move the web app contents to a `/docs` folder
GitHub Pages can serve directly. But that mixes app with documentation, so:

**Option B — recommended.** Use a tiny GitHub Action that publishes the `web/`
folder. Create this file at `.github/workflows/pages.yml`:

```yaml
name: Deploy map to Pages
on:
  push:
    branches: [main]
permissions:
  contents: read
  pages: write
  id-token: write
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: web
      - id: deployment
        uses: actions/deploy-pages@v4
```

Then on GitHub: **Settings → Pages → Build and deployment → Source →
GitHub Actions**. Push, wait a minute, and your map is live at
`https://yourname.github.io/welfare-mapper/`.

> **Important — the data file.** The app fetches
> `../data/processed/lsoa_imd.geojson`. The `.gitignore` excludes `data/` so
> large files don't bloat the repo. For the *live* site you have two choices:
> 1. For the prototype/demo: commit a small processed file (e.g. the synthetic
>    one, or a single-region real extract) by force-adding it:
>    `git add -f data/processed/lsoa_imd.geojson`, and copy it into `web/data/`
>    so Pages can serve it (adjust the fetch path, or put data under `web/`).
> 2. For production with the full national file: don't ship GeoJSON at all —
>    serve vector tiles (see the architecture note in the main concept), which
>    is the real answer once you outgrow the prototype.

## What NOT to commit

The full national datasets (hundreds of MB) and any API keys. The `.gitignore`
already blocks the `data/` folder. Never paste API keys into code that goes to
GitHub — use environment variables / GitHub Secrets when the backend arrives.
