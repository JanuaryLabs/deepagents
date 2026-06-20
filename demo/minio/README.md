# MinIO + rclone volume demo

A self-contained MinIO object store wired to a sandbox as a **mounted filesystem**
through the [rclone](https://rclone.org/docker/) Docker volume plugin. The rclone
volume carries its whole backend config inline — **no `rclone.conf`, no `nsenter1`**.

A file written to the volume becomes an object in the bucket; the same bucket is
also plain S3, so an app (e.g. [files-sdk](https://files-sdk.dev/adapters/minio))
can read it.

## One-time prerequisite

A Docker volume plugin can't be installed from a compose file — install it once
per host:

```bash
docker plugin install rclone/docker-volume-rclone:arm64 \
  --alias rclone --grant-all-permissions
# :amd64 on Intel / most Linux
```

## Run

```bash
docker compose up -d
```

That brings up MinIO, creates the `agent-storage` bucket, and the `writer` service
writes `hello.txt` **through the rclone volume**. Confirm it landed as an object:

- Console: http://localhost:9001 (`minioadmin` / `minioadmin`) → `agent-storage` → `hello.txt`
- or: `docker compose logs writer` should show it wrote the file.

Then drive the same bucket from a **deepagents sandbox** — it attaches to the
compose-created `agent-storage` volume (`lifecycle: 'external'`, so `docker compose up`
must have run first):

```bash
node run.ts
```

It writes `from-sandbox-<ts>.txt` to `/workspace/storage` inside the sandbox; the
file appears in the bucket alongside `hello.txt`. The sandbox installs `strace`
(`pkg(['strace'])`) and is wrapped with `withStraceFileChanges`, so each command's
filesystem writes are reported per-call:

```
[strace] write /workspace/storage/from-sandbox-<ts>.txt
```

Note that the path is the rclone FUSE mount — strace traces the `write` syscall
regardless of the backing filesystem.

## Profiling

`run.ts` self-reports per-phase timings when `PROFILE=1` (silent otherwise):

```bash
PROFILE=1 node run.ts
```

```
[profile] createDockerSandbox         93ms   # ~1900ms on the FIRST run (apk add strace); ~90ms after, reusing the named container
[profile] withStraceFileChanges      228ms   # strace self-test = 2 docker-exec round-trips
[profile] executeCommand (write)     253ms   # strace-wrapped = run + read-back trace (2 round-trips)
[profile] executeCommand (read)      235ms
[profile] TOTAL                      809ms
```

The big lever is the first-run `apk add` (bake `strace` into a custom image to skip
it). After that, each phase is ~2 `docker exec` round-trips (~55ms each on Docker
Desktop) plus strace's tracing overhead — the cost of the run-then-read-trace design,
not the sandbox.

## Point it at a real / remote MinIO

The volume config lives in `compose.yml`'s `driver_opts` (env-interpolated), so set
the values **before `docker compose up`**:

```bash
export MINIO_ENDPOINT="https://minio-api.your-host.com"
export MINIO_KEY="…"  MINIO_SECRET="…"  MINIO_BUCKET="agent-storage"
docker compose up -d   # driver_opts pick up the env; then run `node run.ts` as usual
```

Swapping provider is a one-line `driver_opts` change (`s3_provider` + `s3_endpoint`):
`AWS`, `GCS` (HMAC keys), `Cloudflare` (R2), `Wasabi`, etc. For a fully remote store
you'd also drop the local `minio`/`createbucket` services and create the bucket there.

## Notes

- **Endpoint reachability.** The rclone plugin runs in the Docker daemon, so it
  reaches the local MinIO via the published port at `host.docker.internal:9000`
  (works on Docker Desktop). On a native-Linux daemon use the host gateway
  (`http://172.17.0.1:9000`) or your LAN address instead.
- **Eventual consistency.** With `vfs_cache_mode: writes`, a write uploads ~5s
  after close (`--vfs-write-back`) plus a flush on unmount — don't assume an
  object exists the instant a file closes.
- **Credentials live in the volume config**, so they show in `docker volume inspect`.
  Fine for local dev; for production keep them in a named `rclone.conf` remote
  instead (see the [MinIO recipe](../../apps/docs/app/docs/context/recipes/minio-cloud-storage.mdx)).

## Teardown

```bash
docker compose down -v
```
