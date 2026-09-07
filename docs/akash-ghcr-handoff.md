# Akash GHCR Handoff

## Images

The release workflow publishes these public GHCR image names:

- `ghcr.io/toxmon/flashloan-base-rust-sidecar`
- `ghcr.io/toxmon/flashloan-base-typescript-core`

Pushes to `main` publish the compatibility tag `v1.0.0` and an immutable `sha-<commit>` tag. Manual runs use the `tag` input for the non-immutable tag and still publish the commit tag. `latest` is intentionally not published.

Akash providers must be able to pull the images without credentials. Set each GHCR package visibility to **Public** before deploying; do not put registry credentials or private keys in the SDL.

## Render and validate the SDL

Render the deployment file explicitly after exporting the required environment variables:

```bash
export ALCHEMY_API_KEY='...'
envsubst < deploy.yaml > deploy-rendered.yaml
```

Validate the rendered SDL with the installed Akash CLI before submitting it:

```bash
provider-services sdl-to-manifest deploy-rendered.yaml
```

Use the validation command provided by the installed `provider-services` version if its subcommand syntax differs. Do not commit `deploy-rendered.yaml` or any file containing expanded credentials.

## Current SDL limitation

The current SDL exposes only the internal Rust sidecar gRPC port to `typescript-core`. It has no public health URI. Add an explicit public service/health endpoint before relying on external health checks or public ingress.
