# Releasing Lintel

A tag such as `v0.1.0` runs `.github/workflows/release.yml`. It builds every installer,
signs the updates, and creates one **draft** release. Nothing reaches users until you
publish the draft.

## 1. Pick a commit whose CI passed

The release stops unless `ci.yml` succeeded on the exact commit you tag. Two kinds of
commit have no CI run of their own:

- a commit pushed together with later ones (only the last commit of a push is checked)
- a commit that changes only `docs/` or `.md` files

Check the commit, here `main`'s newest:

```sh
git fetch origin
sha=$(git rev-parse origin/main)
gh run list --workflow ci.yml --commit "$sha" --status success
```

If that lists nothing, run CI on it first and wait for it to pass. This works while the
commit is still the newest on `main`:

```sh
gh workflow run ci.yml --ref main
gh run watch "$(gh run list --workflow ci.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

## 2. Tag it

The tag must be `v` followed by the `version` in `src-tauri/tauri.conf.json`:

```sh
git tag v0.1.0 "$sha"
git push origin v0.1.0
```

## 3. Check the run

In the run on the Actions page, every job must pass: `notices and version`, the four
`build` jobs, `sign the updates` and `draft release`. The last step of `draft release`,
"Check there is one draft and its files verify", must pass. It checks that:

- there is exactly one release for the tag, and it is a draft
- the draft has 14 files: the `.dmg`, the macOS update archive, the `.exe`, two `.deb` and
  two `.rpm` packages, a `.sig` file for each of those six updates, and `latest.json`
- `latest.json` names all 10 platforms, and each signature matches its file, the app
  version, and the key in `tauri.conf.json`

To see the draft from a terminal:

```sh
gh release list
gh release view v0.1.0
```

`gh release view` should find a draft by its tag. If it says the release is not found,
`gh release list` still shows it, and the draft is on the Releases page.

## If the draft release job fails

The signed files are kept with the run for 3 days. Within that time, fix the cause, delete
any draft the failed job left, and re-run only the failed job:

```sh
gh release delete v0.1.0 --yes    # only if a draft for the tag exists
gh run rerun <run-id> --failed
```

After 3 days the files are gone. Re-run the whole workflow instead
(`gh run rerun <run-id>`), which builds and signs everything again.

## 4. Smoke test, then publish

Download the draft's builds (`gh release download v0.1.0`, or from the Releases page) and
run `docs/smoke-test.md` with them.

Then check the draft's notes and publish it on the Releases page. Only then do the
download links in `latest.json` work, so installed copies of Lintel see the update only
after you publish.
