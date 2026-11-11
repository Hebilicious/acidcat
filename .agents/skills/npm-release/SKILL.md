---
name: npm-release
description: |
    Releases and publishes the npm packages of AcidCat (`@acid-cat/*`): the release pull request of release-please, the workflow `release-npm.yml`, trusted publishing and provenance, a new npm package, a failed npm release, and npm login and 2FA from the shell of an agent. Use when you release, when a release fails, when you add an npm package, when you check the trusted publisher of a package, or when you change `scripts/publish-npm.ts` or `.github/workflows/release-npm.yml`.
---
# npm releases

The six npm packages are `@acid-cat/spec-ts`, `mcp-handshake`, `catalog`, `cli`, `core-effect` and `core-ts`. They have one version, and they are released together (the `linked-versions` plugin in `release-please-config.json`). The workflow `release-npm.yml` publishes them, with trusted publishing and provenance. It has no npm token, and it needs none.

## Rules

- Only `release-npm.yml` publishes a version. Never publish a version from a computer. Such a version has no provenance, and npm never accepts its version number again, also after an unpublish. The only publish from a computer is the empty placeholder that reserves the name of a new package (see [Add an npm package](#add-an-npm-package)).
- Never put an npm token in CI. Trusted publishing replaces the token.
- Never change a version or a `CHANGELOG.md` by hand. release-please writes them.
- A trusted publisher is part of the release. A release is done when each package has the new version on npm with provenance.

## Release

1. release-please keeps the pull request `chore(release): release main` open. It lists each package and its new version.
2. If the pull request is behind `main`, update it: `gh pr update-branch <number> --rebase`. Then wait for its checks.
3. When the checks pass, merge it with `gh pr merge <number> --squash`, and pull `main`.
4. The workflow `release.yml` tags each package. The tag `npm/v<version>` starts `release-npm.yml`. It runs `moon run verify`, then `node scripts/publish-npm.ts --version <version>`.
5. Check the result:

   ```sh
   gh run list --workflow release-npm.yml --limit 1
   npm view @acid-cat/<package>@<version> dist.attestations.provenance.predicateType
   ```

   The second command gives `https://slsa.dev/provenance/v1` for each package. npm can show a new version some minutes after the workflow ends.

`scripts/publish-npm.ts` skips a version that is on npm already. Before it publishes anything, it checks that each package is on npm. If a package is not, it publishes nothing, and tells you to add the package (see below).

## Add an npm package

npm accepts a trusted publisher only for a package that exists. `npm trust github` for a name that is not on npm gets `404`. So a new package needs its name on npm before its first release. In the pull request that adds the package:

1. Add the package to:
   - `npmPackages` in `scripts/npm-packages.ts`, in dependency order;
   - `packages` and the `npm` group of `linked-versions` in `release-please-config.json`;
   - `.release-please-manifest.json`, with the current version of the npm packages;
   - `pnpm-workspace.yaml`, `.moon/workspace.yml`, and the `build`, `test` and `typecheck` tasks in `deps` of `verify` in `moon.yml`.
2. Before the release, reserve the name: publish an empty placeholder with no code, version `0.0.0`, and add the trusted publisher. Log in first (see [npm login and 2FA](#npm-login-and-2fa)).

   ```sh
   name=@acid-cat/<package>
   dir=$(mktemp -d)
   cat > "$dir/package.json" <<EOF
   {
     "name": "$name",
     "version": "0.0.0",
     "description": "A placeholder that reserves the name. The release workflow of Hebilicious/acidcat publishes the versions.",
     "license": "MIT",
     "repository": { "type": "git", "url": "git+https://github.com/Hebilicious/acidcat.git" }
   }
   EOF
   printf '# %s\n\nThis version is a placeholder. Install a later version.\n' "$name" > "$dir/README.md"
   npm publish "$dir" --access public
   npm trust github "$name" --repo Hebilicious/acidcat --file release-npm.yml --allow-publish --yes
   rm -rf "$dir"
   ```

3. npm validates a trusted publisher at its first publish from CI. A trusted publisher that is not validated expires 48 hours after it was made. So reserve the name less than 48 hours before the release. If the trusted publisher expired, add it again with the same `npm trust github` command.

## Check a trusted publisher

- On npmjs.com: open `https://www.npmjs.com/package/<package>/access`, then **Trusted Publisher**. The entry is GitHub Actions, user `Hebilicious`, repository `acidcat`, workflow `release-npm.yml`, no environment, publishing allowed.
- With the CLI: `npm trust list <package>`. It needs 2FA.
- If no entry exists, or it expired, add it: `npm trust github <package> --repo Hebilicious/acidcat --file release-npm.yml --allow-publish --yes`.

## Fix a failed npm release

1. Read the log: `gh run view <run id> --log-failed`.
2. `ENEEDAUTH`, or `404` on the publish of a package: the package is not on npm, or it has no trusted publisher. Add or fix the trusted publisher (see above).
3. Run the failed job again: `gh run rerun <run id> --failed`. It skips the versions that are on npm already.
4. Do not publish the missing versions from a computer. A wrong version stays on npm. Fix it in the next release.

## npm login and 2FA

npm asks the user to confirm in the browser. The user cannot see a link that only goes to the log of a command.

- Open each npm page in the browser of the user with `xdg-open <url>`. Do not only paste the link.
- Log in:

  ```sh
  npm login --auth-type=web </dev/null > /tmp/npm-login.log 2>&1   # in the background
  grep -o 'https://www.npmjs.com/login[^ ]*' /tmp/npm-login.log      # then xdg-open this URL at once
  ```

  The link expires after about 5 minutes. `npm whoami` gives the user name after the login.
- `npm publish`, `npm trust` and `npm trust list` need 2FA. Without a terminal, npm hides the link (`***`) and stops with `EOTP`. Run the command in a pseudo-terminal, in the background, then open the link:

  ```sh
  script -qfec "npm trust github <package> --repo Hebilicious/acidcat --file release-npm.yml --allow-publish --yes" /tmp/npm.log </dev/null >/dev/null 2>&1
  grep -oE 'https://www.npmjs.com/auth/cli/[A-Za-z0-9-]+' /tmp/npm.log   # xdg-open this URL
  ```

- After the user confirms 2FA, npm accepts the next commands for some minutes with no new 2FA. Run them at once.
